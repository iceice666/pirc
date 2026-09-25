import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NodeConfig } from '../config.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import type { EventHub } from '../events.js';
import { applySessionName } from '../session-name.js';
import type { WorkspaceLocks } from './locks.js';
import { emptyReducedState, reducePiEvent, type ReducedSessionState } from './reducer.js';
import { JsonlParser } from './rpc-framing.js';
import type { CommandPayload } from '../types.js';
import { id, now } from '../util.js';

interface PendingRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
}

const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);

class PiRunner {
  readonly state: ReducedSessionState = emptyReducedState();
  readonly epoch: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private currentRunId: string | null = null;
  /** Error from the latest assistant turn; a later successful turn clears it. */
  private runError: string | null = null;

  constructor(
    readonly session: SessionRow,
    private readonly config: NodeConfig,
    private readonly db: GatewayDatabase,
    private readonly events: EventHub,
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
      cwd: workspace.canonicalPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: session.privateSessionPath },
    });
    const parser = new JsonlParser(config.rpcMaxLineBytes, config.rpcMaxOutputBytes, (value) =>
      this.handleValue(value),
    );
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

  /**
   * No run in progress, no RPC awaiting a reply, and no dialog awaiting the
   * user: safe to stop and restart later.
   */
  get idle(): boolean {
    return (
      !this.closed &&
      this.currentRunId === null &&
      this.pending.size === 0 &&
      this.db.pendingInteractions(this.session.id).length === 0
    );
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
    private readonly locks: WorkspaceLocks,
  ) {}

  /**
   * Runners stay up after a run so follow-ups are fast, but an idle one must not
   * block another session: stop idle runners that overlap this workspace, and
   * the oldest idle runner when the global limit is reached.
   */
  private async evictIdle(sessionId: string, canonicalPath: string): Promise<void> {
    const idle = (owner: string) => !!this.runners.get(owner)?.idle;
    const victims = new Set(this.locks.overlapping(sessionId, canonicalPath).filter(idle));
    const remaining = this.locks.holders().filter((owner) => !victims.has(owner));
    if (remaining.length >= this.config.runnerLimit) {
      const oldest = remaining.find((owner) => owner !== sessionId && idle(owner));
      if (oldest) victims.add(oldest);
    }
    await Promise.all(
      [...victims].map(async (owner) => {
        const runner = this.runners.get(owner);
        await runner?.stop(this.config.shutdownGraceMs);
        // exit() already released the lock; this covers a runner that was never spawned.
        this.locks.release(owner);
        this.db.setRunnerState(owner, 'stopped');
      }),
    );
  }

  private async ensure(sessionId: string): Promise<PiRunner> {
    const existing = this.runners.get(sessionId);
    if (existing?.alive) return existing;
    const session = this.db.getSession(sessionId);
    const workspace = this.db.getWorkspace(session.workspaceId);
    await this.evictIdle(sessionId, workspace.canonicalPath);
    // A concurrent request may have started this session while we waited.
    const started = this.runners.get(sessionId);
    if (started?.alive) return started;
    this.locks.acquire(sessionId, workspace.canonicalPath);
    this.db.setRunnerState(sessionId, 'starting');
    try {
      const runner = new PiRunner(session, this.config, this.db, this.events, (exited) => {
        if (this.runners.get(sessionId) === exited) this.runners.delete(sessionId);
        this.locks.release(sessionId);
      });
      this.runners.set(sessionId, runner);
      return runner;
    } catch (error) {
      this.locks.release(sessionId);
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
    return uploadIds.map((uploadId) => {
      const upload = this.db.getUpload(uploadId);
      if (upload.ownerUser !== user)
        throw new ApiError(403, 'forbidden', 'Upload belongs to another user');
      const data = readFileSync(path.join(this.config.uploadsDir, upload.storageName)).toString(
        'base64',
      );
      return { type: 'image', data, mimeType: upload.mimeType };
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
      const messagePayload = payload as Extract<CommandPayload, { message: string }>;
      rpc = {
        type: payload.type,
        message: messagePayload.message,
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
          response.error ?? 'Pi rejected command',
        );
        if (runId) this.db.updateRun(runId, 'failed', response.error ?? 'Pi rejected prompt');
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

  async models(sessionId?: string): Promise<Record<string, any>> {
    if (sessionId) return (await this.ensure(sessionId)).request({ type: 'get_available_models' });
    const first = this.db.listSessions()[0];
    if (!first) return { success: true, data: { models: [] } };
    return (await this.ensure(first.id)).request({ type: 'get_available_models' });
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runners.values()].map((runner) => runner.stop(this.config.shutdownGraceMs)),
    );
  }
}
