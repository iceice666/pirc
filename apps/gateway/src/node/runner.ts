import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { NodeConfig } from '../config.js';
import { configureLine, type ModelStore } from '../models.js';
import { AGENT_OP_MAX_LENGTH, AGENT_OP_PATTERN, AGENT_REQUEST_MAX_BYTES } from '../protocol.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import type { EventHub } from '../events.js';
import { applySessionName } from '../session-name.js';
import type { AgentGateway } from './agent-gateway.js';
import type { BrowserManager } from './browser.js';
import { sessionRoot } from './chat.js';
import { withoutSecrets } from './secrets.js';
import type { WriteBroker } from './write-broker.js';
import { emptyReducedState, reducePiEvent, type ReducedSessionState } from './reducer.js';
import { JsonlParser } from './rpc-framing.js';
import type { CommandPayload } from '../types.js';
import { id, now } from '../util.js';

interface PendingRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
}

const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
/** Gateway requests one session may have in flight. */
const MAX_GATEWAY_REQUESTS = 8;
/** Browser requests one session may have in flight (handoff waits count). */
const MAX_BROWSER_REQUESTS = 4;

class PiRunner {
  readonly state: ReducedSessionState = emptyReducedState();
  readonly epoch: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private currentRunId: string | null = null;
  /** Error from the latest assistant turn; a later successful turn clears it. */
  private runError: string | null = null;
  private gatewayRequests = 0;
  private readonly browserRequests = new Map<string, AbortController>();

  constructor(
    readonly session: SessionRow,
    private readonly config: NodeConfig,
    private readonly db: GatewayDatabase,
    private readonly events: EventHub,
    models: ModelStore,
    private readonly writes: WriteBroker,
    private readonly gateway: AgentGateway,
    private readonly browser: BrowserManager | undefined,
    private readonly onExit: (runner: PiRunner) => void,
  ) {
    this.epoch = db.incrementEpoch(session.id);
    db.staleEpochInteractions(session.id, this.epoch);
    const workspace = db.getWorkspace(session.workspaceId);
    const args = [
      ...config.agentArgs,
      '--mode',
      'rpc',
      '--session-dir',
      session.privateSessionPath,
    ];
    if (session.piSessionId) args.push('--continue');
    this.child = spawn(config.agentCommand, args, {
      cwd: sessionRoot(workspace, session.id),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        // The node token must not reach the agent: its tools and shells run whatever the model asks.
        ...withoutSecrets(process.env),
        PI_CODING_AGENT_SESSION_DIR: session.privateSessionPath,
        // Ask this node for a write lease before file-tool writes.
        PIRC_WRITE_BROKER: '1',
        // Allowlisted operations on the gateway go through this node (gateway_request).
        PIRC_GATEWAY: '1',
        // `chat` makes the agent a personal assistant (see node/chat.ts).
        PIRC_WORKSPACE_KIND: workspace.kind,
        PIRC_WORKSPACE_MEMORY_DIR: config.workspaceMemoryDir,
        // This node answers browser_request (node/browser.ts).
        PIRC_BROWSER: browser?.enabled ? '1' : '0',
      },
    });
    // Public catalog + node-local inference transport; no provider credentials.
    this.child.stdin.write(configureLine(models.current));
    const parser = new JsonlParser(config.rpcMaxLineBytes, (value) => this.handleValue(value));
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.child.stdout.on('end', () => {
      try {
        parser.end();
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) =>
      this.events.publish(session.id, this.epoch, 'runner_stderr', {
        text: chunk.toString('utf8').slice(0, 8192),
      }),
    );
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => this.exit(code, signal));
    db.setRunnerState(session.id, 'ready');
    this.events.publish(session.id, this.epoch, 'runner_ready', {});
    // A user-chosen name stops the agent from generating one. Written before any
    // prompt, so the agent sees it first.
    const current = db.getSession(session.id);
    if (current.nameSource === 'user')
      void this.request({ type: 'set_session_name', name: current.name }).catch(() => undefined);
    void this.request({ type: 'get_state' })
      .then((response) => {
        if (response.success && response.data?.sessionId)
          this.db.setPiSession(this.session.id, response.data.sessionId as string);
      })
      .catch(() => undefined);
  }

  get alive(): boolean {
    return !this.closed;
  }

  private handleValue(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('RPC emitted a non-object JSON value');
    const message = value as Record<string, any>;
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message);
        return;
      }
    }
    if (message.type === 'extension_ui_request') {
      if (dialogMethods.has(message.method) && typeof message.id === 'string') {
        const timeout =
          typeof message.timeout === 'number' && message.timeout > 0
            ? message.timeout
            : this.config.interactionTtlMs;
        const interaction = this.db.createInteraction(
          this.session.id,
          this.epoch,
          message.id,
          message.method,
          message,
          now() + timeout,
        );
        this.events.publish(this.session.id, this.epoch, 'interaction_created', interaction);
        if (this.currentRunId) this.db.updateRun(this.currentRunId, 'waiting_input');
      } else if (message.method === 'cancel' && typeof message.targetId === 'string') {
        const cancelled = this.db.cancelInteractionByRpcId(
          this.session.id,
          this.epoch,
          message.targetId,
        );
        if (cancelled) {
          this.events.publish(this.session.id, this.epoch, 'interaction_answered', {
            interactionId: cancelled,
            cancelled: true,
          });
          if (this.currentRunId) this.db.updateRun(this.currentRunId, 'running');
        }
        return;
      } else this.events.publish(this.session.id, this.epoch, 'notification', message);
    }
    if (message.type === 'write_lease_request') {
      this.grantWrite(message);
      return;
    }
    if (message.type === 'gateway_request') {
      this.forwardGateway(message);
      return;
    }
    if (message.type === 'browser_request') {
      this.handleBrowser(message);
      return;
    }
    if (message.type === 'browser_cancel') {
      if (typeof message.id === 'string') this.browserRequests.get(message.id)?.abort();
      return;
    }
    if (message.type === 'session_name_changed') {
      applySessionName(this.db, this.events, this.session.id, this.epoch, message);
      return;
    }
    reducePiEvent(this.state, message);
    if (message.type === 'agent_start') {
      if (!this.currentRunId) this.currentRunId = this.db.createRun(this.session.id);
      this.runError = null;
      this.db.updateRun(this.currentRunId, 'running');
    } else if (message.type === 'agent_settled') {
      // A retried or recovered error must not leave the run failed; only the
      // final assistant turn decides.
      if (this.currentRunId)
        this.db.updateRun(
          this.currentRunId,
          this.runError === null ? 'succeeded' : 'failed',
          this.runError ?? undefined,
        );
      this.currentRunId = null;
      this.runError = null;
      this.writes.release(this.session.id);
    } else if (message.type === 'message_end' && message.message?.role === 'assistant') {
      this.runError =
        message.message.stopReason === 'error'
          ? (message.message.errorMessage ?? 'The agent reported an error')
          : null;
      if (this.runError !== null && this.currentRunId)
        this.db.updateRun(this.currentRunId, 'failed', this.runError);
    } else if (message.type === 'auto_retry_start' && this.currentRunId) {
      this.db.updateRun(this.currentRunId, 'running');
    }
    this.events.publish(this.session.id, this.epoch, 'pi_event', message);
  }

  request(command: Record<string, unknown>): Promise<Record<string, any>> {
    if (this.closed || !this.child.stdin.writable)
      return Promise.reject(new ApiError(503, 'runner_unavailable', 'Runner is not available'));
    const requestId = id('rpc');
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ ...command, id: requestId })}\n`,
        'utf8',
        (error) => {
          if (error) {
            this.pending.delete(requestId);
            reject(error);
          }
        },
      );
    });
  }

  async answer(rpcId: string, answer: Record<string, unknown>): Promise<void> {
    if (this.closed || !this.child.stdin.writable)
      throw new ApiError(503, 'runner_unavailable', 'Runner is not available');
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(
        `${JSON.stringify({ type: 'extension_ui_response', id: rpcId, ...answer })}\n`,
        'utf8',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    if (this.currentRunId) this.db.updateRun(this.currentRunId, 'running');
  }

  /** Answer the agent's `write_lease_request` from the node-wide broker. */
  private grantWrite(message: Record<string, any>): void {
    if (typeof message.id !== 'string') return;
    let response: Record<string, unknown>;
    if (typeof message.path !== 'string' || !path.isAbsolute(message.path))
      response = { granted: false, error: 'write_lease_request needs an absolute path' };
    else {
      let canonical: string;
      try {
        canonical = realpathSync(message.path);
      } catch {
        canonical = path.resolve(message.path);
      }
      const grant = this.writes.acquire(this.session.id, canonical);
      if (grant.granted) response = { granted: true };
      else {
        let holder = grant.holder;
        try {
          holder = `"${this.db.getSession(grant.holder).name}" (${grant.holder})`;
        } catch {
          /* session row gone; keep the id */
        }
        response = {
          granted: false,
          error: `${grant.path} is being written by session ${holder}; wait until its run finishes`,
        };
      }
    }
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.write(
        `${JSON.stringify({ type: 'write_lease_response', id: message.id, ...response })}\n`,
      );
  }

  /**
   * Pass the agent's `gateway_request` to the daemon. The runner names the
   * session, so an agent can only ever act as its own session.
   */
  private forwardGateway(message: Record<string, any>): void {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 100) return;
    const reply = (response: Record<string, unknown>) => {
      if (!this.closed && this.child.stdin.writable)
        this.child.stdin.write(
          `${JSON.stringify({ type: 'gateway_response', id: message.id, ...response })}\n`,
        );
    };
    const fail = (status: number, code: string, text: string, details?: unknown) =>
      reply({
        ok: false,
        error: { status, code, message: text, ...(details === undefined ? {} : { details }) },
      });
    const op = message.op;
    if (typeof op !== 'string' || op.length > AGENT_OP_MAX_LENGTH || !AGENT_OP_PATTERN.test(op))
      return fail(400, 'invalid_input', 'A gateway operation is named like area.action');
    const args = message.args ?? {};
    if (Buffer.byteLength(JSON.stringify(args)) > AGENT_REQUEST_MAX_BYTES)
      return fail(413, 'payload_too_large', 'Gateway request arguments are too large');
    if (this.gatewayRequests >= MAX_GATEWAY_REQUESTS)
      return fail(429, 'too_many_requests', 'Too many gateway requests are in flight');
    this.gatewayRequests++;
    void this.gateway
      .request(this.session.id, op, args)
      .catch(() => ({ status: 500, body: null }))
      .then(({ status, body }) => {
        this.gatewayRequests--;
        const answer = (body ?? {}) as {
          result?: unknown;
          error?: { code?: unknown; message?: unknown; details?: unknown };
        };
        if (status >= 200 && status < 300)
          return reply({ ok: true, result: answer.result ?? null });
        fail(
          status,
          typeof answer.error?.code === 'string' ? answer.error.code : 'internal_error',
          typeof answer.error?.message === 'string'
            ? answer.error.message
            : `The gateway answered ${status}`,
          answer.error?.details,
        );
      });
  }

  /**
   * Answer the agent's `browser_request` from the node's browser. The runner
   * names the session, so an agent only ever drives its own tabs.
   */
  private handleBrowser(message: Record<string, any>): void {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 100) return;
    const reply = (response: Record<string, unknown>) => {
      if (!this.closed && this.child.stdin.writable)
        this.child.stdin.write(
          `${JSON.stringify({ type: 'browser_response', id: message.id, ...response })}\n`,
        );
    };
    const fail = (status: number, code: string, text: string) =>
      reply({ ok: false, error: { status, code, message: text } });
    if (!this.browser?.enabled)
      return fail(403, 'forbidden', 'The browser is not available on this node');
    const op = message.op;
    if (typeof op !== 'string' || !/^[a-z_]{1,40}$/.test(op))
      return fail(400, 'invalid_input', 'Unknown browser operation');
    const args = message.args && typeof message.args === 'object' ? message.args : {};
    if (Buffer.byteLength(JSON.stringify(args)) > AGENT_REQUEST_MAX_BYTES)
      return fail(413, 'payload_too_large', 'Browser request arguments are too large');
    if (this.browserRequests.size >= MAX_BROWSER_REQUESTS)
      return fail(429, 'too_many_requests', 'Too many browser requests are in flight');
    const controller = new AbortController();
    this.browserRequests.set(message.id, controller);
    const workspace = this.db.getWorkspace(this.session.workspaceId);
    void this.browser
      .handle(
        {
          sessionId: this.session.id,
          workspaceId: workspace.id,
          root: sessionRoot(workspace, this.session.id),
        },
        op,
        args,
        controller.signal,
      )
      .then(
        (result) => reply({ ok: true, result: result ?? null }),
        (error: unknown) =>
          error instanceof ApiError
            ? fail(error.statusCode, error.code, error.message)
            : fail(500, 'browser_error', error instanceof Error ? error.message : String(error)),
      )
      .finally(() => this.browserRequests.delete(message.id));
  }

  setRun(runId: string): void {
    this.currentRunId = runId;
  }

  private fail(error: Error): void {
    if (!this.closed) {
      this.events.publish(this.session.id, this.epoch, 'runner_error', { message: error.message });
      this.child.kill('SIGKILL');
    }
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    const error = new ApiError(
      503,
      'runner_unavailable',
      `Runner exited (${signal ?? code ?? 'unknown'})`,
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.browserRequests.values()) controller.abort();
    this.browserRequests.clear();
    this.db.markDispatchedUnknown(this.session.id, error.message);
    if (this.currentRunId) this.db.updateRun(this.currentRunId, 'interrupted', error.message);
    this.db.setRunnerState(this.session.id, 'failed');
    this.events.publish(this.session.id, this.epoch, 'runner_exit', { code, signal });
    this.onExit(this);
  }

  async stop(graceMs: number): Promise<void> {
    if (this.closed) return;
    try {
      await Promise.race([
        this.request({ type: 'abort' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('shutdown timeout')), graceMs),
        ),
      ]);
    } catch {
      /* force termination below */
    }
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      const killTimer = setTimeout(() => {
        if (!this.closed) this.child.kill('SIGKILL');
      }, graceMs);
      const fallbackTimer = setTimeout(resolve, graceMs * 2);
      fallbackTimer.unref();
      this.child.once('exit', () => {
        clearTimeout(killTimer);
        clearTimeout(fallbackTimer);
        resolve();
      });
    });
  }
}

export class RunnerManager {
  private readonly runners = new Map<string, PiRunner>();
  constructor(
    private readonly config: NodeConfig,
    private readonly db: GatewayDatabase,
    private readonly events: EventHub,
    private readonly writes: WriteBroker,
    private readonly models: ModelStore,
    private readonly gateway: AgentGateway,
    private readonly browser?: BrowserManager,
  ) {}

  /**
   * Runners start without a limit; sessions that only read never contend.
   * Writers are serialized per path by the {@link WriteBroker}.
   */
  private async ensure(sessionId: string): Promise<PiRunner> {
    const existing = this.runners.get(sessionId);
    if (existing?.alive) return existing;
    const session = this.db.getSession(sessionId);
    this.db.setRunnerState(sessionId, 'starting');
    try {
      const runner = new PiRunner(
        session,
        this.config,
        this.db,
        this.events,
        this.models,
        this.writes,
        this.gateway,
        this.browser,
        (exited) => {
          if (this.runners.get(sessionId) === exited) this.runners.delete(sessionId);
          this.writes.release(sessionId);
        },
      );
      this.runners.set(sessionId, runner);
      return runner;
    } catch (error) {
      this.writes.release(sessionId);
      this.db.setRunnerState(sessionId, 'failed');
      throw error;
    }
  }

  get(sessionId: string): PiRunner | undefined {
    return this.runners.get(sessionId);
  }

  private imageContents(
    uploadIds: string[] | undefined,
    user: string,
  ): Array<{ type: 'image'; data: string; mimeType: string }> | undefined {
    if (!uploadIds?.length) return undefined;
    const images = uploadIds
      .map((uploadId) => this.db.getUpload(uploadId))
      .filter((upload) => (upload.kind ?? 'image') === 'image')
      .map((upload) => {
        if (upload.ownerUser !== user)
          throw new ApiError(403, 'forbidden', 'Upload belongs to another user');
        const data = readFileSync(path.join(this.config.uploadsDir, upload.storageName)).toString(
          'base64',
        );
        return { type: 'image' as const, data, mimeType: upload.mimeType };
      });
    return images.length ? images : undefined;
  }

  /**
   * Non-image uploads aren't sent to the model directly: copy each into the
   * session's workspace (under `.pirc/uploads`, already an allowed root for
   * the agent's file tools) and return the relative paths so the prompt can
   * point the agent at them.
   */
  private fileAttachments(
    uploadIds: string[] | undefined,
    user: string,
    sessionId: string,
  ): string[] {
    if (!uploadIds?.length) return [];
    const files = uploadIds
      .map((uploadId) => this.db.getUpload(uploadId))
      .filter((upload) => upload.kind === 'file');
    if (!files.length) return [];
    const session = this.db.getSession(sessionId);
    const workspace = this.db.getWorkspace(session.workspaceId);
    const destDir = path.join(sessionRoot(workspace, sessionId), '.pirc', 'uploads');
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    return files.map((upload) => {
      if (upload.ownerUser !== user)
        throw new ApiError(403, 'forbidden', 'Upload belongs to another user');
      const safeName = path.basename(upload.filename || upload.id);
      const destName = `${upload.id}-${safeName}`;
      const dest = path.join(destDir, destName);
      if (!existsSync(dest))
        copyFileSync(path.join(this.config.uploadsDir, upload.storageName), dest);
      return path.posix.join('.pirc', 'uploads', destName);
    });
  }

  async dispatch(
    sessionId: string,
    commandId: string,
    payload: CommandPayload,
    user: string,
  ): Promise<Record<string, any>> {
    const runner = await this.ensure(sessionId);
    let rpc: Record<string, unknown>;
    let runId: string | null = null;
    if (['prompt', 'steer', 'follow_up'].includes(payload.type)) {
      const messagePayload = payload as Extract<
        CommandPayload,
        { type: 'prompt' | 'steer' | 'follow_up' }
      >;
      const fileNotes = this.fileAttachments(messagePayload.uploadIds, user, sessionId);
      const message = fileNotes.length
        ? `${messagePayload.message}\n\nAttached file(s) available to read from the workspace:\n${fileNotes.map((relPath) => `- ${relPath}`).join('\n')}`
        : messagePayload.message;
      rpc = {
        type: payload.type,
        message,
        images: this.imageContents(messagePayload.uploadIds, user),
      };
      if (payload.type === 'prompt') {
        runId = this.db.createRun(sessionId);
        runner.setRun(runId);
      }
    } else if (payload.type === 'set_model')
      rpc = { type: 'set_model', provider: payload.provider, modelId: payload.modelId };
    else if (payload.type === 'set_thinking')
      rpc = { type: 'set_thinking_level', level: payload.level };
    else if (payload.type === 'send_now')
      rpc = {
        type: 'send_now',
        queue: payload.queue,
        index: payload.index,
        message: payload.message,
      };
    else rpc = { type: payload.type };
    this.db.updateCommand(commandId, 'dispatched');
    try {
      let response: Record<string, any>;
      if (payload.type === 'stop') {
        if (runId) this.db.updateRun(runId, 'stopping');
        const cleared = await runner.request({ type: 'clear_queue' });
        if (!cleared.success) throw new Error(cleared.error ?? 'clear_queue rejected');
        const aborted = await runner.request({ type: 'abort' });
        response = { ...aborted, data: { cleared: cleared.data } };
      } else response = await runner.request(rpc);
      if (!response.success) {
        this.db.updateCommand(
          commandId,
          'rejected',
          response,
          response.error ?? 'Agent rejected command',
        );
        if (runId) this.db.updateRun(runId, 'failed', response.error ?? 'Agent rejected prompt');
      } else this.db.updateCommand(commandId, 'accepted', response);
      return response;
    } catch (error) {
      if (!runner.alive)
        this.db.updateCommand(commandId, 'outcome_unknown', undefined, (error as Error).message);
      else this.db.updateCommand(commandId, 'rejected', undefined, (error as Error).message);
      if (runId)
        this.db.updateRun(runId, runner.alive ? 'failed' : 'interrupted', (error as Error).message);
      throw error;
    }
  }

  /**
   * Push a message from the gateway into a session: a delegated task, or news
   * of a delegation for the chat that asked. Starts the agent if needed; the
   * message runs next, after any run in progress.
   */
  async deliver(
    sessionId: string,
    delivery: {
      customType: string;
      content: string;
      details?: Record<string, unknown> | undefined;
      model?: { provider: string; id: string } | undefined;
      thinking?: string | undefined;
    },
  ): Promise<void> {
    const runner = await this.ensure(sessionId);
    const { model, thinking, ...message } = delivery;
    for (const command of [
      ...(model ? [{ type: 'set_model', provider: model.provider, modelId: model.id }] : []),
      ...(thinking ? [{ type: 'set_thinking_level', level: thinking }] : []),
    ]) {
      const set = await runner.request(command);
      if (!set.success)
        throw new ApiError(
          503,
          'runner_unavailable',
          set.error ?? `The agent refused ${command.type}`,
        );
    }
    const response = await runner.request({ type: 'deliver', message });
    if (!response.success)
      throw new ApiError(
        503,
        'runner_unavailable',
        response.error ?? 'The agent refused the message',
      );
  }

  async answer(
    sessionId: string,
    epoch: number,
    rpcId: string,
    answer: Record<string, unknown>,
  ): Promise<void> {
    const runner = this.runners.get(sessionId);
    if (!runner?.alive || runner.epoch !== epoch)
      throw new ApiError(
        409,
        'stale_interaction',
        'Interaction belongs to an inactive runner epoch',
      );
    await runner.answer(rpcId, answer);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runners.values()].map((runner) => runner.stop(this.config.shutdownGraceMs)),
    );
  }
}
