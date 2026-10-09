/**
 * One `ptc` execution (docs/evaluations/ptc/ptc-only.md §4–5): the host side.
 *
 * The script runs in a QuickJS-WASM realm in a `ptc-guest` child process
 * (guest.ts), started with an empty environment inside the agent's OS
 * sandbox. The agent stays responsive (dialogs are answered meanwhile), and
 * cancellation or the active-time budget ends the script with SIGKILL,
 * whatever it is doing — QuickJS cannot interrupt a backtracking regular
 * expression, and a thread could not be stopped at all. JSON over IPC is the
 * only bridge.
 *
 * Every operation goes through the {@link Broker}, which applies the agent's
 * normal validation, hooks, auto mode and authorization. This side owns the
 * bookkeeping: quotas are reserved before an operation starts, records live
 * here (so the completion summary survives a crashed, cancelled or killed
 * script), and a stopped execution never resumes from a late result.
 */
import { selfCommand } from '../../self.js';
import {
  BUDGETS,
  CONTRACT_VERSION,
  ERROR_CODES,
  PtcError,
  type ErrorCode,
  type Outcome,
  type Result,
  type TraceNode,
} from './contracts.js';
import {
  GUEST_LIMITS,
  ROOT_SCOPE,
  type GuestMessage,
  type HostMessage,
  type ScriptOutcome,
} from './protocol.js';

export interface BrokerCall {
  name: string;
  args: Record<string, unknown>;
  operationId: string;
  signal: AbortSignal;
  /**
   * Take the execution's write slot when the call, as it will finally run
   * (after hook rewrites and approval), writes. Call right before running it;
   * the runtime releases the slot when the operation settles.
   */
  claimSlot(name: string, args: Record<string, unknown>): Promise<void>;
}

/** The agent side of an execution: authority stays here, never in the realm. */
export interface Broker {
  /** Capabilities the script may call: the preflight manifest. */
  readonly manifest: ReadonlySet<string>;
  /** Whether the call needs the execution's single write slot. */
  isWrite(name: string, args: Record<string, unknown>): boolean;
  /** Run one operation; failures come back as error envelopes. */
  invoke(call: BrokerCall): Promise<Result>;
}

export interface PtcGuestProcess {
  send(message: HostMessage): void | Promise<void>;
  kill(): void;
  exited: Promise<unknown>;
  pid?: number;
}

export interface ExecutionOptions {
  /** Trusted supervisor supplies an actually isolated gateway guest, never model arguments. */
  launchGuest?: (
    onMessage: (message: GuestMessage) => void,
    signal: AbortSignal,
  ) => Promise<PtcGuestProcess>;
  /** Preflighted JavaScript defining `async function __ptc_main()`. */
  code: string;
  broker: Broker;
  signal: AbortSignal;
  /** Active-time budget; time spent waiting for a human is not counted. */
  timeoutMs: number;
  turnId: string;
  executionId: string;
  /** Subscribe to "a human is being asked" changes; returns an unsubscribe function. */
  onHumanWait?: (listener: (waiting: boolean) => void) => () => void;
  /** `attachments.add(handle)`: queue an operation's image; throws a PtcError to refuse. */
  attach?: (handle: string) => { queued: number };
  /** Progress for observers (not the model); never called after the execution ended. */
  onProgress?: (summary: OperationSummary) => void;
  /** The session's script store (JSON object) for `load()`. */
  store?: string;
  /** Test seam: the pid of the script's process once started. */
  onProcess?: (pid: number) => void;
  /** Host-received ordered guest acknowledgement, not mere pipe-write completion. */
  onDelivered?: (operationId: string) => void;
}

export interface OperationRecord {
  operationId: string;
  capability: string;
  outcome: Outcome;
  errorCode?: ErrorCode;
  durationMs: number;
  /** The script received this result (false: it ended or was cancelled first). */
  delivered: boolean;
}

export interface OperationSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  unknown: number;
  notStarted: number;
  running: number;
}

export type ExecutionStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface ExecutionReport {
  status: ExecutionStatus;
  /** The returned string as is, or JSON of any other value; absent when nothing was returned. */
  value?: string;
  /** The returned value was a string (`value` is not JSON). */
  valueIsString?: boolean;
  /** The whole script store (JSON) when a completed script changed it. */
  store?: string;
  /**
   * The script may have read the store with `load()`: only a script that ended on its own and
   * reported not loading is known not to have.
   */
  storeRead: boolean;
  error?: { code: ErrorCode | 'ScriptError'; message: string };
  console: string;
  consoleTruncated: boolean;
  /** Records of the operations (refusals past the call quota are only counted). */
  operations: OperationRecord[];
  summary: OperationSummary;
  trace: TraceNode[];
  traceTruncated: boolean;
  activeMs: number;
  waitedMs: number;
}

/** Refusals past the call quota that still get a record of their own. */
const RECORDED_REFUSALS = 20;
/** Calls after which a script that ignores QuotaExceeded is stopped. */
const MAX_ATTEMPTS = BUDGETS.internalCalls * 5;
/** `tools.par` scopes per execution (the guest refuses more; the host stops past it). */
const MAX_SCOPES = BUDGETS.parScopes;
const MAX_TRACE_NODES = 2 * (BUDGETS.internalCalls + RECORDED_REFUSALS) + 2 * MAX_SCOPES + 2;

const truncateUtf8 = (text: string, bytes: number): string => {
  const buffer = Buffer.from(text);
  return buffer.length <= bytes ? text : buffer.subarray(0, Math.max(0, bytes)).toString('utf8');
};

/** Active-time budget that stops counting while a human is asked. */
class Budget {
  private used = 0;
  private since: number | undefined = performance.now();
  private waitingSince: number | undefined;
  private stopped = false;
  waited = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly limitMs: number,
    private readonly onExpire: () => void,
  ) {
    this.arm();
  }
  get activeMs(): number {
    return this.used + (this.since === undefined ? 0 : performance.now() - this.since);
  }
  pause(): void {
    if (this.stopped || this.since === undefined) return;
    this.used += performance.now() - this.since;
    this.since = undefined;
    this.waitingSince = performance.now();
    clearTimeout(this.timer);
  }
  resume(): void {
    if (this.stopped || this.since !== undefined) return;
    if (this.waitingSince !== undefined) this.waited += performance.now() - this.waitingSince;
    this.waitingSince = undefined;
    this.since = performance.now();
    this.arm();
  }
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => (this.activeMs >= this.limitMs ? this.onExpire() : this.arm()),
      Math.max(1, this.limitMs - this.activeMs),
    );
  }
  /** Freeze both counters, including a wait still open. */
  stop(): void {
    if (this.stopped) return;
    if (this.since !== undefined) this.used += performance.now() - this.since;
    if (this.waitingSince !== undefined) this.waited += performance.now() - this.waitingSince;
    this.since = undefined;
    this.waitingSince = undefined;
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

interface Operation {
  record: OperationRecord;
  controller: AbortController;
  scope: string;
  settled: Promise<void>;
}

interface Scope {
  parent: string;
  cancelled: boolean;
}

type StopReason = 'timed_out' | 'cancelled' | 'quota';

/**
 * A store, kept only when it is a JSON object within the store budget, with keys and values
 * within their limits (checked here too: the script controls what the guest sends).
 */
export function storeOf(raw: unknown): { store?: string } {
  if (typeof raw !== 'string' || raw.length > BUDGETS.storeTotalChars + 2) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    for (const [key, value] of Object.entries(parsed))
      if (!key || key.length > 200 || JSON.stringify(value).length > BUDGETS.storeValueChars)
        return {};
    return { store: raw };
  } catch {
    return {};
  }
}

/** The guest's final outcome, checked field by field: the script can shape it. */
function checkedOutcome(raw: unknown): ScriptOutcome {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.ok === true) {
    const loaded = value.loaded === false ? { loaded: false } : {};
    if (value.value === undefined) return { ok: true, ...loaded, ...storeOf(value.store) };
    if (typeof value.value !== 'string')
      return {
        ok: false,
        error: { code: 'ScriptError', message: 'The script returned a malformed value' },
      };
    return {
      ok: true,
      value: value.value.slice(0, GUEST_LIMITS.valueChars),
      ...(value.string === true ? { string: true } : {}),
      ...loaded,
      ...storeOf(value.store),
    };
  }
  const error = (value.error ?? {}) as Record<string, unknown>;
  const code =
    typeof error.code === 'string' && (ERROR_CODES as readonly string[]).includes(error.code)
      ? (error.code as ErrorCode)
      : 'ScriptError';
  const message = typeof error.message === 'string' ? error.message : 'Script failed';
  return {
    ok: false,
    error: { code, message: message.slice(0, 8192) },
    ...(value.loaded === false ? { loaded: false } : {}),
  };
}

export async function execute(options: ExecutionOptions): Promise<ExecutionReport> {
  const { broker } = options;
  const execution = new AbortController();
  let stopReason: StopReason | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let child: PtcGuestProcess | undefined;
  let outcome: ScriptOutcome | undefined;
  /** End the script process, whatever it is doing. */
  const halt = () => {
    child?.kill();
  };
  const stop = (reason: StopReason) => {
    if (outcome || stopReason) return;
    stopReason = reason;
    halt();
    execution.abort();
    finish?.();
  };
  const budget = new Budget(options.timeoutMs, () => stop('timed_out'));
  // Independent lifetime cap: human waits cannot retain a centralized guest forever.
  const absoluteDeadline = setTimeout(() => stop('timed_out'), options.timeoutMs + 30 * 60_000);
  const onAbort = () => stop('cancelled');
  options.signal.addEventListener('abort', onAbort);
  // The budget pauses while a human is asked, but only while the script
  // itself waits: a script computing meanwhile still spends active time.
  let humanWaiting = false;
  let guestBusy = true;
  /** Results sent; an `idle` counts only once the guest has received all of them. */
  let resultsSent = 0;
  let resultsReceived = 0;
  const deliveryIds = new Map<number, string>();
  const received = (count: unknown) => {
    if (
      !Number.isSafeInteger(count) ||
      Number(count) < resultsReceived ||
      Number(count) > resultsSent
    )
      return;
    for (let index = resultsReceived + 1; index <= Number(count); index++) {
      const id = deliveryIds.get(index);
      if (id) options.onDelivered?.(id);
      deliveryIds.delete(index);
    }
    resultsReceived = Number(count);
  };
  const updateBudget = () => (humanWaiting && !guestBusy ? budget.pause() : budget.resume());
  const unsubscribe = options.onHumanWait?.((waiting) => {
    humanWaiting = waiting;
    updateBudget();
  });

  // Bookkeeping, all on this side.
  const trace: TraceNode[] = [];
  let traceTruncated = false;
  let sequence = 0;
  const node = (fields: Omit<TraceNode, 'turnId' | 'executionId' | 'sequence' | 'createdAt'>) => {
    if (trace.length >= MAX_TRACE_NODES) {
      traceTruncated = true;
      return;
    }
    trace.push({
      turnId: options.turnId,
      executionId: options.executionId,
      sequence: sequence++,
      createdAt: new Date().toISOString(),
      ...fields,
    });
  };
  const rootId = `${options.executionId}:root`;
  const nodeIdOf = (scope: string) =>
    scope === ROOT_SCOPE ? rootId : `${options.executionId}:${scope}`;
  node({ nodeId: rootId, type: 'execution', status: 'running' });
  const operations: Operation[] = [];
  const records: OperationRecord[] = [];
  const scopes = new Map<string, Scope>();
  let attempts = 0;
  let unrecordedRefusals = 0;
  let pending = 0;
  let writeBusy = false;
  const writeQueue: Array<() => void> = [];
  let consoleText = '';
  let consoleTruncated = false;
  let ended = false;

  /** Whether `scope` is `ancestor` or lies inside it. */
  const within = (scope: string, ancestor: string) => {
    for (let at: string | undefined = scope; at !== undefined; ) {
      if (at === ancestor) return true;
      if (at === ROOT_SCOPE) return false;
      at = scopes.get(at)?.parent;
    }
    return false;
  };
  const cancelledScope = (scope: string) => {
    for (const [id, info] of scopes) if (info.cancelled && within(scope, id)) return true;
    return false;
  };

  /** Running operations count as `unknown` once the execution has ended. */
  const summary = (final = false): OperationSummary => {
    const count = (value: Outcome) => records.filter((r) => r.outcome === value).length;
    return {
      total: attempts,
      completed: count('completed'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      unknown: records.filter((r) => r.outcome === 'unknown' && (final || r.durationMs >= 0))
        .length,
      notStarted: count('not_started') + unrecordedRefusals,
      running: final ? 0 : pending,
    };
  };
  const progress = () => {
    if (!ended) options.onProgress?.(summary());
  };

  const acquireWrite = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new PtcError('Cancelled', 'Cancelled before it started'));
      if (!writeBusy) {
        writeBusy = true;
        return resolve();
      }
      const grant = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = writeQueue.indexOf(grant);
        if (index >= 0) writeQueue.splice(index, 1);
        reject(new PtcError('Cancelled', 'Cancelled while waiting for the write slot'));
      };
      writeQueue.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  // At most `concurrentOperations` run at once; later calls wait their turn (nested
  // tools.par or an unawaited call next to a par would otherwise be refused).
  let running = 0;
  const slotQueue: Array<() => void> = [];
  const acquireSlot = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new PtcError('Cancelled', 'Cancelled before it started'));
      if (running < BUDGETS.concurrentOperations) {
        running++;
        return resolve();
      }
      const grant = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = slotQueue.indexOf(grant);
        if (index >= 0) slotQueue.splice(index, 1);
        reject(new PtcError('Cancelled', 'Cancelled while waiting to start'));
      };
      slotQueue.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  const releaseSlot = () => {
    const next = slotQueue.shift();
    if (next) next();
    else running--;
  };
  const releaseWrite = () => {
    const next = writeQueue.shift();
    if (next) next();
    else writeBusy = false;
  };

  const send = async (message: HostMessage) => {
    if (ended || stopReason || !child) return;
    if (message.type === 'result') {
      // Reserve before the async write: the guest may receive and answer before
      // the local drain callback, and a blocked write still spends active time.
      resultsSent++;
      guestBusy = true;
      updateBudget();
    }
    try {
      await child.send(message);
    } catch {
      return false; /* process exit terminates the script; never claim delivery */
    }
    return true;
  };

  /** One operation, entirely on this side; the envelope goes back to the script. */
  const startOperation = (
    id: number,
    rawName: string,
    argsJson: string,
    rawScope: string,
    oversize: boolean,
  ) => {
    if (attempts >= MAX_ATTEMPTS) return stop('quota');
    const index = ++attempts;
    const scope = rawScope === ROOT_SCOPE || scopes.has(rawScope) ? rawScope : ROOT_SCOPE;
    const operationId = `${options.executionId}:op${index}`;
    const name = rawName.slice(0, 64);
    const deliver = async (envelope: Result, record?: OperationRecord) => {
      if (ended || stopReason) return;
      let json = JSON.stringify(envelope);
      if (Buffer.byteLength(json) > BUDGETS.resultBytes)
        json = JSON.stringify({
          ok: false,
          contractVersion: CONTRACT_VERSION,
          operationId,
          error: {
            code: 'QuotaExceeded',
            message: `The result exceeds ${BUDGETS.resultBytes} bytes; ask for less (offset/limit, filters)`,
            operationId,
            outcome: record?.outcome ?? 'not_started',
          },
        });
      deliveryIds.set(resultsSent + 1, operationId);
      const delivered = await send({ type: 'result', id, json });
      if (record && delivered) record.delivered = true;
    };
    const refuse = (error: PtcError) => {
      const envelope: Result = {
        ok: false,
        contractVersion: CONTRACT_VERSION,
        operationId,
        error: error.toJSON(operationId),
      };
      // Past the quota a script may loop on refusals: count them, keep a few.
      if (index > BUDGETS.internalCalls + RECORDED_REFUSALS) {
        unrecordedRefusals++;
        return deliver(envelope);
      }
      const record: OperationRecord = {
        operationId,
        capability: name,
        outcome: 'not_started',
        errorCode: error.code,
        durationMs: 0,
        delivered: false,
      };
      records.push(record);
      node({
        nodeId: operationId,
        parentNodeId: nodeIdOf(scope),
        type: 'operation',
        status: error.code === 'Cancelled' ? 'cancelled' : 'failed',
        capability: name,
        outcome: 'not_started',
        errorCode: error.code,
        durationMs: 0,
      });
      deliver(envelope, record);
    };
    // Reserve first: a refused call still counts toward the call quota.
    if (index > BUDGETS.internalCalls)
      return refuse(
        new PtcError(
          'QuotaExceeded',
          `More than ${BUDGETS.internalCalls} operations in one ptc call; split the work across calls`,
        ),
      );
    if (cancelledScope(scope))
      return refuse(new PtcError('Cancelled', 'Its tools.par was cancelled after a failure'));
    if (!name)
      return refuse(
        new PtcError('InvalidArguments', 'The capability name must be a string literal'),
      );
    if (!broker.manifest.has(name))
      return refuse(
        new PtcError(
          'CapabilityUnavailable',
          `${name} is not in this script's capability manifest; call capabilities by literal name`,
        ),
      );
    if (oversize || Buffer.byteLength(argsJson) > BUDGETS.argsBytes)
      return refuse(new PtcError('QuotaExceeded', `Arguments exceed ${BUDGETS.argsBytes} bytes`));
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = undefined;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return refuse(new PtcError('InvalidArguments', 'Arguments must be an object'));
    const values = args as Record<string, unknown>;
    pending++;
    const controller = new AbortController();
    const signal = AbortSignal.any([execution.signal, controller.signal]);
    const started = performance.now();
    const record: OperationRecord = {
      operationId,
      capability: name,
      outcome: 'unknown',
      durationMs: -1,
      delivered: false,
    };
    records.push(record);
    node({
      nodeId: operationId,
      parentNodeId: nodeIdOf(scope),
      type: 'operation',
      status: 'running',
      capability: name,
    });
    const operation: Operation = { record, controller, scope, settled: Promise.resolve() };
    operations.push(operation);
    progress();
    operation.settled = (async () => {
      let envelope: Result;
      let held = false;
      let slot = false;
      const claimSlot = async (finalName: string, finalArgs: Record<string, unknown>) => {
        if (held || !broker.isWrite(finalName, finalArgs)) return;
        await acquireWrite(signal);
        held = true;
      };
      try {
        await acquireSlot(signal);
        slot = true;
        envelope = await broker.invoke({ name, args: values, operationId, signal, claimSlot });
      } catch (error) {
        const typed =
          error instanceof PtcError
            ? error
            : new PtcError('OperationFailed', (error as Error).message, 'unknown');
        envelope = {
          ok: false,
          contractVersion: CONTRACT_VERSION,
          operationId,
          error: typed.toJSON(operationId),
        };
      } finally {
        if (held) releaseWrite();
        // Keep the operation slot while its bounded IPC result drains.
        // Otherwise fast replies can build an unbounded transport backlog.
      }
      record.durationMs = Math.round(performance.now() - started);
      if (envelope.ok) record.outcome = 'completed';
      else {
        record.errorCode = envelope.error.code;
        record.outcome = envelope.error.outcome;
      }
      node({
        nodeId: operationId,
        parentNodeId: nodeIdOf(scope),
        type: 'operation',
        status: envelope.ok
          ? 'completed'
          : envelope.error.code === 'Timeout'
            ? 'timed_out'
            : envelope.error.code === 'Cancelled'
              ? 'cancelled'
              : 'failed',
        capability: name,
        outcome: record.outcome,
        durationMs: record.durationMs,
        ...(envelope.ok ? {} : { errorCode: envelope.error.code }),
      });
      progress();
      try {
        await deliver(envelope, record);
      } finally {
        if (slot) releaseSlot();
        pending--;
      }
    })();
  };

  const onMessage = (message: GuestMessage) => {
    if (ended || stopReason || !message || typeof message !== 'object') return;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    switch (message.type) {
      case 'call':
        if (typeof message.id === 'number')
          startOperation(
            message.id,
            text(message.name),
            text(message.argsJson),
            text(message.scope),
            message.oversize === true,
          );
        return;
      case 'attach': {
        if (typeof message.id !== 'number') return;
        let reply: Record<string, unknown>;
        try {
          if (!options.attach)
            throw new PtcError('CapabilityUnavailable', 'Attachments are not available');
          reply = { ok: true, data: options.attach(text(message.handle).slice(0, 100)) };
        } catch (error) {
          const typed =
            error instanceof PtcError
              ? error
              : new PtcError('OperationFailed', (error as Error)?.message ?? String(error));
          reply = { ok: false, error: typed.toJSON() };
        }
        void send({ type: 'result', id: message.id, json: JSON.stringify(reply) });
        return;
      }
      case 'idle':
        // An idle sent before the latest result arrived is stale: the script may be busy again.
        if (message.received !== resultsSent) return;
        received(message.received);
        guestBusy = false;
        updateBudget();
        return;
      case 'log': {
        if (consoleTruncated) return;
        const level = text(message.level).slice(0, 8);
        const line = `${level === 'log' || level === 'info' || !level ? '' : `[${level}] `}${text(message.text)}\n`;
        const used = Buffer.byteLength(consoleText);
        if (used + Buffer.byteLength(line) > BUDGETS.consoleBytes) {
          consoleText += truncateUtf8(line, BUDGETS.consoleBytes - used);
          consoleTruncated = true;
        } else consoleText += line;
        return;
      }
      case 'scope_open': {
        const scope = text(message.scope);
        if (!scope || scope === ROOT_SCOPE || scopes.has(scope)) return;
        if (scopes.size >= MAX_SCOPES) return stop('quota');
        const parent = scopes.has(text(message.parent)) ? text(message.parent) : ROOT_SCOPE;
        scopes.set(scope, { parent, cancelled: false });
        node({
          nodeId: nodeIdOf(scope),
          parentNodeId: nodeIdOf(parent),
          type: 'par',
          status: 'running',
        });
        return;
      }
      case 'scope_cancel': {
        const info = scopes.get(text(message.scope));
        if (!info || info.cancelled) return;
        info.cancelled = true;
        // Abort only what this par (and pars inside it) started and is still running.
        for (const operation of operations)
          if (operation.record.durationMs < 0 && within(operation.scope, text(message.scope)))
            operation.controller.abort();
        return;
      }
      case 'scope_close': {
        const scope = text(message.scope);
        const info = scopes.get(scope);
        if (!info) return;
        node({
          nodeId: nodeIdOf(scope),
          parentNodeId: nodeIdOf(info.parent),
          type: 'par',
          status: message.status === 'completed' ? 'completed' : 'failed',
        });
        return;
      }
      case 'done':
        received(message.received);
        outcome = checkedOutcome(message.outcome);
        finish?.();
        return;
    }
  };

  try {
    if (options.signal.aborted) stop('cancelled');
    if (!stopReason) {
      let stderr = '';
      const started = options.launchGuest
        ? undefined
        : Bun.spawn([...selfCommand(), 'ptc-guest'], {
            // No environment at all: nothing of the agent's reaches the script's process.
            env: {},
            // Not the workspace: Bun would load a `.env` and run a `bunfig.toml`
            // preload from its working directory. Sandboxed agents cannot write to `/`.
            cwd: '/',
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'pipe',
            serialization: 'json',
            ipc: (message: GuestMessage) => onMessage(message),
          });
      child = options.launchGuest
        ? await options.launchGuest(onMessage, execution.signal)
        : {
            send: (message) => started!.send(message),
            kill: () => {
              if (started!.exitCode === null && started!.signalCode === null)
                started!.kill('SIGKILL');
            },
            exited: started!.exited,
            pid: started!.pid,
          };
      if (child.pid !== undefined) options.onProcess?.(child.pid);
      if (started)
        void (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of started.stderr as ReadableStream<Uint8Array>)
            stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-2000);
        })().catch(() => undefined);
      void child.exited.then(() => {
        if (outcome || stopReason) return;
        outcome = {
          ok: false,
          error: {
            code: 'ScriptError',
            message: `Script runtime stopped unexpectedly${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`,
          },
        };
        finish?.();
      });
      if (stopReason || execution.signal.aborted) {
        child.kill();
      } else
        child.send({
          type: 'start',
          code: options.code,
          manifest: [...broker.manifest],
          store: options.store ?? '{}',
        } satisfies HostMessage);
      await finished;
    }
  } catch (error) {
    if (!outcome && !stopReason)
      outcome = {
        ok: false,
        error: {
          code: 'ScriptError',
          message: `Script runtime failed: ${(error as Error)?.message ?? String(error)}`,
        },
      };
  } finally {
    ended = true;
    halt();
    // Whatever is still running is no longer awaited by anyone: cancel it,
    // then give it a bounded time to report what actually happened.
    execution.abort();
    budget.stop();
    clearTimeout(absoluteDeadline);
    unsubscribe?.();
    options.signal.removeEventListener('abort', onAbort);
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([
        ...operations.map((operation) => operation.settled),
        // SIGKILL cannot be ignored; wait for the process to be gone and reaped.
        child?.exited,
      ]),
      new Promise<void>((resolve) => (grace = setTimeout(resolve, BUDGETS.settleGraceMs))),
    ]);
    clearTimeout(grace);
  }

  const status: ExecutionStatus =
    stopReason === 'timed_out'
      ? 'timed_out'
      : stopReason === 'cancelled'
        ? 'cancelled'
        : stopReason === 'quota' || !outcome?.ok
          ? 'failed'
          : 'completed';
  node({
    nodeId: rootId,
    type: 'execution',
    status,
    durationMs: Math.round(budget.activeMs + budget.waited),
  });
  const error: ExecutionReport['error'] =
    stopReason === 'timed_out'
      ? {
          code: 'Timeout',
          message: `Active execution budget of ${Math.round(options.timeoutMs / 1000)}s exceeded`,
        }
      : stopReason === 'cancelled'
        ? { code: 'Cancelled', message: 'Cancelled' }
        : stopReason === 'quota'
          ? {
              code: 'QuotaExceeded',
              message: `Stopped: the script kept calling past its quotas (${BUDGETS.internalCalls} operations, ${MAX_SCOPES} tools.par calls)`,
            }
          : outcome && !outcome.ok
            ? outcome.error
            : undefined;
  // Copies: operations still settling must not change a returned report.
  return {
    status,
    ...(status === 'completed' && outcome?.ok && outcome.value !== undefined
      ? { value: outcome.value, ...(outcome.string ? { valueIsString: true } : {}) }
      : {}),
    ...(status === 'completed' && outcome?.ok && outcome.store !== undefined
      ? { store: outcome.store }
      : {}),
    storeRead: outcome?.loaded !== false,
    ...(error ? { error } : {}),
    console: consoleText,
    consoleTruncated,
    operations: records.map((record) => ({ ...record })),
    summary: summary(true),
    trace: trace.map((item) => ({ ...item })),
    traceTruncated,
    activeMs: Math.round(budget.activeMs),
    waitedMs: Math.round(budget.waited),
  };
}
