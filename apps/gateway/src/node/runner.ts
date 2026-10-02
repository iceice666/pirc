import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
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
import { projectInstructionsPath, readProjectInstructions, sessionRoot } from './chat.js';
import { DOMAIN_PATTERN, isInside, realResolve } from '../sandbox-policy.js';
import { NodeSandbox, type PreparedSandbox } from './sandbox.js';
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
/** Sandbox requests (approvals, unsandboxed commands) one session may have in flight. */
const MAX_SANDBOX_REQUESTS = 4;
/** Output kept from an unsandboxed command (head and tail). */
const HOST_EXEC_OUTPUT_BYTES = 1_000_000;
/**
 * Interactions the node asks itself (sandbox approvals) carry rpc ids with
 * this prefix. Answers to them never reach the agent, and the agent can
 * neither open nor cancel one: its word is not the human's.
 */
const NODE_DIALOG_PREFIX = 'node-sandbox-';

type AgentChild = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

/**
 * Run an approved command outside the sandbox: bash in its own process
 * group, the node's environment without its secrets, output capped.
 */
function runOnHost(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: withoutSecrets(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let head = '';
    let tail = '';
    let total = 0;
    const half = HOST_EXEC_OUTPUT_BYTES / 2;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      total += chunk.byteLength;
      if (head.length < half) {
        const room = half - head.length;
        head += text.slice(0, room);
        tail = (tail + text.slice(room)).slice(-half);
      } else tail = (tail + text).slice(-half);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 1000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const truncated = total > Buffer.byteLength(head + tail);
      resolve({
        output: truncated ? `${head}\n\n[… output truncated …]\n\n${tail}` : head + tail,
        exitCode: timedOut || aborted ? null : exitCode,
        timedOut,
        aborted,
        truncated,
      });
    };
    child.once('error', (error) => {
      head += `${error.message}\n`;
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}

class PiRunner {
  readonly state: ReducedSessionState = emptyReducedState();
  readonly epoch: number;
  private readonly child: AgentChild;
  /** srt's control channel (network allowlist updates), when sandboxed. */
  private readonly control: Writable | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly nodeDialogs = new Map<string, (confirmed: boolean) => void>();
  private readonly sandboxRequests = new Map<string, AbortController>();
  /** Domains the human allowed for this session, beyond the policy. */
  private readonly approvedDomains = new Set<string>();
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
    private readonly sandbox: PreparedSandbox,
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
    this.child = spawn(sandbox.command, [...sandbox.args, ...args.slice(config.agentArgs.length)], {
      cwd: sessionRoot(workspace, session.id),
      // fd 3: srt's control channel.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      // Its own process group, so stopping srt also stops what it sandboxes.
      detached: true,
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
        // The project config hash the user trusted in Settings; the agent ignores
        // .pirc/config.json hooks / env / allowedPaths unless they still match.
        PIRC_PROJECT_TRUST:
          (workspace.kind === 'directory' && db.getWorkspaceTrust(workspace.id)) || '',
        // Only for protecting it: the agent gets the text on its configure line.
        ...(workspace.kind === 'chat'
          ? { PIRC_PROJECT_INSTRUCTIONS: projectInstructionsPath(workspace)! }
          : {}),
        PIRC_WORKSPACE_MEMORY_DIR: config.workspaceMemoryDir,
        // This node answers browser_request (node/browser.ts).
        PIRC_BROWSER: browser?.enabled ? '1' : '0',
        // This node answers sandbox_request; the file tools mirror the policy.
        PIRC_SANDBOX: 'srt',
        PIRC_SANDBOX_POLICY: JSON.stringify(sandbox.policy.paths),
        ...sandbox.env,
      },
    }) as AgentChild;
    this.control = (this.child.stdio[3] as Writable | null) ?? undefined;
    this.control?.on('error', () => undefined);
    // Public catalog + node-local inference transport; no provider credentials.
    this.child.stdin.write(configureLine(models.current, readProjectInstructions(workspace)));
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
    this.events.publish(session.id, this.epoch, 'runner_ready', { sandbox: { active: true } });
    // In the timeline, and in the snapshot for clients that connect later.
    for (const warning of sandbox.warnings) {
      const notice = {
        type: 'extension_ui_request',
        id: `${NODE_DIALOG_PREFIX}notice-${randomUUID()}`,
        method: 'notify',
        message: warning,
        notifyType: 'warning',
      };
      reducePiEvent(this.state, notice);
      this.events.publish(session.id, this.epoch, 'notification', notice);
    }
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

  /** For the snapshot: a runner exists only inside the sandbox. */
  get sandboxStatus(): { active: boolean; reason?: string } {
    return { active: true };
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
      // Only the node opens or cancels its own dialogs.
      if (
        (typeof message.id === 'string' && message.id.startsWith(NODE_DIALOG_PREFIX)) ||
        (typeof message.targetId === 'string' && message.targetId.startsWith(NODE_DIALOG_PREFIX))
      )
        return;
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
    if (message.type === 'sandbox_request') {
      this.handleSandbox(message);
      return;
    }
    if (message.type === 'sandbox_cancel') {
      if (typeof message.id === 'string') this.sandboxRequests.get(message.id)?.abort();
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
    } else if (message.type === 'agent_error') {
      // The agent loop itself failed; the run ends with agent_settled.
      this.runError = typeof message.error === 'string' ? message.error : 'The agent loop crashed';
      if (this.currentRunId) this.db.updateRun(this.currentRunId, 'failed', this.runError);
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
    const dialog = this.nodeDialogs.get(rpcId);
    if (dialog) {
      dialog(answer.confirmed === true);
      if (this.currentRunId) this.db.updateRun(this.currentRunId, 'running');
      return;
    }
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

  /**
   * Ask the human, from the node itself: the agent is sandboxed and may be
   * steered by what it reads, so its own dialogs cannot grant anything.
   */
  private confirmFromNode(title: string, message: string, signal: AbortSignal): Promise<boolean> {
    const rpcId = `${NODE_DIALOG_PREFIX}${randomUUID()}`;
    const interaction = this.db.createInteraction(
      this.session.id,
      this.epoch,
      rpcId,
      'confirm',
      { type: 'extension_ui_request', id: rpcId, method: 'confirm', title, message },
      now() + this.config.interactionTtlMs,
    );
    this.events.publish(this.session.id, this.epoch, 'interaction_created', interaction);
    if (this.currentRunId) this.db.updateRun(this.currentRunId, 'waiting_input');
    return new Promise((resolve) => {
      const finish = (confirmed: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', withdraw);
        this.nodeDialogs.delete(rpcId);
        resolve(confirmed);
      };
      // Unanswered in time, cancelled by the agent, or the runner stopped.
      const withdraw = () => {
        const cancelled = this.db.cancelInteractionByRpcId(this.session.id, this.epoch, rpcId);
        if (cancelled) {
          this.events.publish(this.session.id, this.epoch, 'interaction_answered', {
            interactionId: cancelled,
            cancelled: true,
          });
          if (this.currentRunId) this.db.updateRun(this.currentRunId, 'running');
        }
        finish(false);
      };
      const timer = setTimeout(withdraw, this.config.interactionTtlMs);
      signal.addEventListener('abort', withdraw, { once: true });
      this.nodeDialogs.set(rpcId, finish);
    });
  }

  /**
   * The agent's `sandbox_request`: `network` (allow more domains for this
   * session) or `exec` (run one command outside the sandbox). Both need the
   * human's yes, asked by the node.
   */
  private handleSandbox(message: Record<string, any>): void {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 100) return;
    const requestId = message.id;
    const reply = (response: Record<string, unknown>) => {
      if (!this.closed && this.child.stdin.writable)
        this.child.stdin.write(
          `${JSON.stringify({ type: 'sandbox_response', id: requestId, ...response })}\n`,
        );
    };
    const fail = (code: string, text: string) =>
      reply({ ok: false, error: { code, message: text } });
    const args = message.args && typeof message.args === 'object' ? message.args : {};
    if (Buffer.byteLength(JSON.stringify(args)) > AGENT_REQUEST_MAX_BYTES)
      return fail('payload_too_large', 'Sandbox request arguments are too large');
    if (this.sandboxRequests.size >= MAX_SANDBOX_REQUESTS)
      return fail('too_many_requests', 'Too many sandbox requests are in flight');
    const reason =
      typeof args.reason === 'string' && args.reason.trim()
        ? args.reason.trim().slice(0, 500)
        : '(no reason given)';
    const controller = new AbortController();
    const start = (work: () => Promise<void>) => {
      this.sandboxRequests.set(requestId, controller);
      void work()
        .catch((error: unknown) =>
          fail('sandbox_error', error instanceof Error ? error.message : String(error)),
        )
        .finally(() => this.sandboxRequests.delete(requestId));
    };

    if (message.op === 'network') {
      const domains = Array.isArray(args.domains)
        ? [...new Set(args.domains.map((item: unknown) => String(item).trim().toLowerCase()))]
        : [];
      if (!domains.length || domains.length > 10)
        return fail('invalid_input', 'Name one to ten domains');
      const bad = domains.find((domain) => !DOMAIN_PATTERN.test(domain as string));
      if (bad) return fail('invalid_input', `Not a domain: ${bad}`);
      if (!this.control) return fail('sandbox_error', "The sandbox's control channel is closed");
      const allowed = new Set([
        ...this.sandbox.policy.network.allowedDomains,
        ...this.approvedDomains,
      ]);
      const missing = (domains as string[]).filter((domain) => !allowed.has(domain));
      if (!missing.length) return reply({ ok: true, result: { granted: domains } });
      return start(async () => {
        const confirmed = await this.confirmFromNode(
          'Allow network access?',
          [
            `The agent asks to reach ${missing.join(', ')} from its sandbox.`,
            `Reason: ${reason}`,
            'Approving allows these hosts for the rest of this session.',
          ].join('\n\n'),
          controller.signal,
        );
        if (!confirmed) return reply({ ok: true, result: { granted: [], denied: missing } });
        for (const domain of missing) this.approvedDomains.add(domain);
        this.control!.write(`${JSON.stringify(this.sandbox.settings(this.approvedDomains))}\n`);
        reply({ ok: true, result: { granted: domains } });
      });
    }

    if (message.op === 'exec') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim() || command.length > 20_000)
        return fail(
          'invalid_input',
          'command must be a non-empty string (at most 20000 characters)',
        );
      const workspace = this.db.getWorkspace(this.session.workspaceId);
      const root = realResolve(sessionRoot(workspace, this.session.id));
      const cwd = realResolve(
        path.resolve(root, typeof args.cwd === 'string' && args.cwd ? args.cwd : '.'),
      );
      let isDir = false;
      try {
        isDir = statSync(cwd).isDirectory();
      } catch {
        /* reported below */
      }
      if (!isInside(cwd, root) || !isDir)
        return fail('invalid_input', `cwd must be a directory inside ${root}`);
      const timeoutMs = Math.min(
        Math.max(typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000, 1000),
        3_600_000,
      );
      return start(async () => {
        const confirmed = await this.confirmFromNode(
          'Run a command outside the sandbox?',
          [
            `$ ${command}`,
            `in ${cwd}`,
            `Reason: ${reason}`,
            "It runs with this node account's full access (without the node's own secrets).",
          ].join('\n\n'),
          controller.signal,
        );
        if (!confirmed)
          return fail('denied', 'The user did not approve running this outside the sandbox');
        reply({ ok: true, result: await runOnHost(command, cwd, timeoutMs, controller.signal) });
      });
    }
    fail('invalid_input', 'Unknown sandbox operation');
  }

  setRun(runId: string): void {
    this.currentRunId = runId;
  }

  /** Signal srt with the agent and everything under it. */
  private kill(signal: NodeJS.Signals): void {
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        /* group gone; fall through */
      }
    }
    this.child.kill(signal);
  }

  private fail(error: Error): void {
    if (!this.closed) {
      this.events.publish(this.session.id, this.epoch, 'runner_error', { message: error.message });
      this.kill('SIGKILL');
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
    for (const controller of this.sandboxRequests.values()) controller.abort();
    this.sandboxRequests.clear();
    for (const dialog of [...this.nodeDialogs.values()]) dialog(false);
    this.sandbox.cleanup();
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
    this.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      const killTimer = setTimeout(() => {
        if (!this.closed) this.kill('SIGKILL');
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
  /** Runners being prepared (the sandbox probe is async); one start per session. */
  private readonly starting = new Map<string, Promise<PiRunner>>();
  constructor(
    private readonly config: NodeConfig,
    private readonly db: GatewayDatabase,
    private readonly events: EventHub,
    private readonly writes: WriteBroker,
    private readonly models: ModelStore,
    private readonly gateway: AgentGateway,
    private readonly browser?: BrowserManager,
    private readonly sandbox: NodeSandbox = new NodeSandbox(config),
  ) {}

  /**
   * Runners start without a limit; sessions that only read never contend.
   * Writers are serialized per path by the {@link WriteBroker}.
   */
  private ensure(sessionId: string): Promise<PiRunner> {
    this.db.requireSessionAvailable(sessionId);
    const existing = this.runners.get(sessionId);
    if (existing?.alive) return Promise.resolve(existing);
    let starting = this.starting.get(sessionId);
    if (!starting) {
      starting = this.start(sessionId).finally(() => this.starting.delete(sessionId));
      this.starting.set(sessionId, starting);
    }
    return starting;
  }

  private async start(sessionId: string): Promise<PiRunner> {
    const session = this.db.getSession(sessionId);
    this.db.setRunnerState(sessionId, 'starting');
    let prepared: PreparedSandbox | undefined;
    try {
      const workspace = this.db.getWorkspace(session.workspaceId);
      prepared = await this.sandbox.prepare({
        sessionId,
        workspaceRoot: sessionRoot(workspace, sessionId),
        sessionDir: session.privateSessionPath,
        inferenceSocket: this.models.current.inference?.socketPath,
        // The user's project instructions: never writable from the session.
        protectedPaths: [projectInstructionsPath(workspace)].filter((item) => item !== undefined),
      });
      const runner = new PiRunner(
        session,
        this.config,
        this.db,
        this.events,
        this.models,
        this.writes,
        this.gateway,
        this.browser,
        prepared,
        (exited) => {
          if (this.runners.get(sessionId) === exited) this.runners.delete(sessionId);
          this.writes.release(sessionId);
        },
      );
      this.runners.set(sessionId, runner);
      return runner;
    } catch (error) {
      prepared?.cleanup();
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
    this.db.requireSessionAvailable(sessionId);
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
      role?: string | undefined;
      model?: { provider: string; id: string } | undefined;
      thinking?: string | undefined;
    },
  ): Promise<void> {
    const runner = await this.ensure(sessionId);
    this.db.requireSessionAvailable(sessionId);
    const { role, model, thinking, ...message } = delivery;
    // The role first: the user's model and thinking level override the role's.
    for (const command of [
      ...(role ? [{ type: 'set_role', role }] : []),
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

  async stopSession(sessionId: string): Promise<void> {
    // A start already probing the sandbox must finish before its files can be removed.
    await this.starting.get(sessionId)?.catch(() => undefined);
    const runner = this.runners.get(sessionId);
    await runner?.stop(this.config.shutdownGraceMs);
    if (runner?.alive)
      throw new ApiError(
        503,
        'runner_unavailable',
        'The chat process has not stopped yet; retry deletion',
      );
    this.writes.release(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runners.values()].map((runner) => runner.stop(this.config.shutdownGraceMs)),
    );
  }
}
