import { randomUUID } from 'node:crypto';
import { canonicalJson } from './json.js';
import {
  CONTROL_BYTES,
  REQUEST_BYTES,
  validateIntent,
  type Binding,
  type EnvironmentMessage,
  type ExecutionIntent,
} from './protocol.js';
import type { Result } from '../agent/ptc/contracts.js';
import { validatePtcResult } from './ptc-result.js';

/** Reverse RPC over the authenticated Environment channel. Admission never blocks the
 * flow's receive loop: controls and replies must progress while a capability waits.
 * All effects belong to a durable service; reconnect only retrieves original IDs.
 */
export class CentralLink {
  private readonly pending = new Map<
    string,
    {
      intent: ExecutionIntent;
      resolve(result: Result): void;
      reject(error: Error): void;
      cleanup(): void;
      cancelling: boolean;
    }
  >();
  private readonly incoming = new Map<
    string,
    { intent: ExecutionIntent; controller: AbortController; work: Promise<void> }
  >();
  private readonly requests = new Set<string>();
  private readonly cancelled = new Map<string, string>();
  private online = true;
  constructor(
    private readonly options: {
      nodeId: string;
      authorize(binding: Binding): void;
      send(message: EnvironmentMessage): Promise<void>;
      execute?(
        intent: ExecutionIntent,
        signal: AbortSignal,
        finalArguments?: ExecutionIntent['arguments'],
      ): Promise<Result>;
      status?(intent: ExecutionIntent): Promise<Result>;
      failed?(error: Error): void;
    },
  ) {}
  request(
    intent: ExecutionIntent,
    signal: AbortSignal,
    finalArguments?: ExecutionIntent['arguments'],
  ): Promise<Result> {
    return this.call(intent, signal, false, finalArguments);
  }
  status(intent: ExecutionIntent, signal: AbortSignal): Promise<Result> {
    return this.call(intent, signal, true);
  }
  private async call(
    value: ExecutionIntent,
    signal: AbortSignal,
    status: boolean,
    finalArguments?: ExecutionIntent['arguments'],
  ): Promise<Result> {
    const intent = validateIntent(value);
    this.authorize(intent.binding);
    if (!intent.parentExecutionId) throw new Error('Central call requires PTC parent');
    if (!this.online || this.pending.size >= 8) throw new Error('Central link unavailable or busy');
    signal.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        const request = this.pending.get(requestId);
        if (!request || request.cancelling) return;
        request.cancelling = true;
        clearTimeout(timer);
        cancelTimer = setTimeout(() => {
          this.pending.delete(requestId);
          request.cleanup();
          reject(new Error('Central cancellation drain unverified; fence executor'));
        }, 1000);
        if (!status && this.online)
          void this.options
            .send({
              version: 1,
              requestId,
              type: 'ptc.central.cancel',
              binding: intent.binding,
              executionId: intent.executionId,
            })
            .catch((error) => this.fail(error));
        else {
          this.pending.delete(requestId);
          request.cleanup();
          reject(new Error('Central reply unavailable; reconcile original ID'));
        }
      };
      const timer = setTimeout(stop, Math.min(intent.budgetMs + 30 * 60_000, 90 * 60_000));
      this.pending.set(requestId, {
        intent,
        resolve,
        reject,
        cancelling: false,
        cleanup: () => {
          clearTimeout(timer);
          clearTimeout(cancelTimer);
          signal.removeEventListener('abort', stop);
        },
      });
      signal.addEventListener('abort', stop, { once: true });
      void this.options
        .send({
          version: 1,
          requestId,
          type: status ? 'ptc.central.status' : 'ptc.central',
          intent,
          ...(finalArguments === undefined ? {} : { finalArguments }),
        })
        .catch(stop);
    });
  }
  private authorize(binding: Binding) {
    if (binding.nodeId !== this.options.nodeId)
      throw new Error('Central transport binding mismatch');
    this.options.authorize(binding);
  }
  private fail(error: unknown) {
    this.disconnect();
    this.options.failed?.(error instanceof Error ? error : new Error(String(error)));
  }
  async receive(message: EnvironmentMessage): Promise<boolean> {
    if (message.type === 'ptc.central.cancel') {
      this.authorize(message.binding);
      const key = canonicalJson(message.binding, CONTROL_BYTES);
      const prior = this.cancelled.get(message.executionId);
      if (prior && prior !== key) throw new Error('Central cancellation identity conflict');
      if (!prior && this.cancelled.size >= 256)
        throw new Error('Central cancellation quota exceeded; close link');
      this.cancelled.set(message.executionId, key);
      const running = this.incoming.get(message.executionId);
      if (running) {
        if (
          canonicalJson(running.intent.binding, CONTROL_BYTES) !==
          canonicalJson(message.binding, CONTROL_BYTES)
        )
          throw new Error('Central cancellation binding mismatch');
        running.controller.abort(new Error('Central caller cancelled'));
      }
      // Complete asynchronously so the receive loop can still drain inner replies.
      void (running?.work ?? Promise.resolve())
        .then(async () => {
          if (this.online)
            await this.options.send({
              version: 1,
              requestId: message.requestId,
              type: 'ptc.central.cancelled',
              binding: message.binding,
              executionId: message.executionId,
            });
        })
        .catch((error) => this.fail(error));
      return true;
    }
    if (message.type === 'ptc.central.cancelled') {
      this.authorize(message.binding);
      const request = this.pending.get(message.requestId);
      if (request?.cancelling) {
        if (
          request.intent.executionId !== message.executionId ||
          canonicalJson(request.intent.binding, CONTROL_BYTES) !==
            canonicalJson(message.binding, CONTROL_BYTES)
        )
          throw new Error('Cancellation completion identity mismatch');
        this.pending.delete(message.requestId);
        request.cleanup();
        request.reject(new Error('Central cancelled and drained; reconcile original ID'));
      }
      return true;
    }
    if (message.type === 'ptc.central' || message.type === 'ptc.central.status') {
      if (!this.online) throw new Error('Central link offline');
      const intent = validateIntent(message.intent);
      this.authorize(intent.binding);
      if (!intent.parentExecutionId) throw new Error('Central call requires PTC parent');
      if (this.requests.has(message.requestId) || this.requests.size >= 8)
        throw new Error('Central inbound request quota or duplicate');
      const status = message.type === 'ptc.central.status';
      if (status ? !this.options.status : !this.options.execute)
        throw new Error('Central service unavailable');
      if (this.incoming.has(intent.executionId)) {
        const current = this.incoming.get(intent.executionId)!;
        if (canonicalJson(current.intent, REQUEST_BYTES) !== canonicalJson(intent, REQUEST_BYTES))
          throw new Error('Central execution ID conflict');
        // Status may retrieve a committed result while post-hooks still drain;
        // repeated starts must never create another concurrent owner.
        if (!status) throw new Error('Central execution in progress; query original ID');
      }
      this.requests.add(message.requestId);
      const controller = new AbortController();
      const cancelled = this.cancelled.get(intent.executionId);
      if (cancelled) {
        if (cancelled !== canonicalJson(intent.binding, CONTROL_BYTES))
          throw new Error('Central cancelled binding mismatch');
        controller.abort(new Error('Central cancelled before admission'));
      }
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(intent.budgetMs + 30 * 60_000),
      ]);
      const work = Promise.resolve()
        .then(async () => {
          try {
            if (!status) signal.throwIfAborted();
            const result = validatePtcResult(
              await (status
                ? this.options.status!(intent)
                : this.options.execute!(
                    intent,
                    signal,
                    message.type === 'ptc.central' ? message.finalArguments : undefined,
                  )),
              intent.innerOperationId,
            );
            if (this.online)
              await this.options.send({
                version: 1,
                requestId: message.requestId,
                type: 'ptc.central.result',
                binding: intent.binding,
                executionId: intent.executionId,
                result: JSON.parse(canonicalJson(result, 16 * 1024 * 1024)),
              });
          } catch {
            if (this.online)
              await this.options.send({
                version: 1,
                requestId: message.requestId,
                type: 'ptc.central.error',
                binding: intent.binding,
                executionId: intent.executionId,
                error: {
                  code: 'unknown',
                  message: 'Central operation unavailable; reconcile original ID',
                },
              });
          }
        })
        .catch((error) => this.fail(error))
        .finally(() => {
          this.requests.delete(message.requestId);
          if (!status) this.incoming.delete(intent.executionId);
        });
      if (!status) this.incoming.set(intent.executionId, { intent, controller, work });
      return true;
    }
    if (message.type !== 'ptc.central.result' && message.type !== 'ptc.central.error') return false;
    this.authorize(message.binding);
    const request = this.pending.get(message.requestId);
    if (!request) return true;
    if (
      message.executionId !== request.intent.executionId ||
      canonicalJson(message.binding, CONTROL_BYTES) !==
        canonicalJson(request.intent.binding, CONTROL_BYTES)
    )
      throw new Error('Central reply identity mismatch');
    if (request.cancelling) return true;
    const result =
      message.type === 'ptc.central.result'
        ? validatePtcResult(message.result, request.intent.innerOperationId)
        : undefined;
    this.pending.delete(message.requestId);
    request.cleanup();
    if (result) request.resolve(result);
    else request.reject(new Error('Central outcome unavailable; query original ID'));
    return true;
  }
  disconnect(): void {
    this.online = false;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(new Error('Central disconnected; reconcile original IDs'));
    }
    this.pending.clear();
    for (const operation of this.incoming.values())
      operation.controller.abort(new Error('Central link disconnected'));
  }
  reconnect(): void {
    if (this.incoming.size || this.requests.size)
      throw new Error('Central work must drain before reconnect');
    this.online = true;
  }
  async drain(): Promise<void> {
    await Promise.all([...this.incoming.values()].map((operation) => operation.work));
  }
}
