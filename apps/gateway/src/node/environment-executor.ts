import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { builtinTools } from '../agent/tools/index.js';
import type { InnerJournal } from '../environment/inner-journal.js';
import { planPtc } from '../gateway-runtime/ptc-contracts.js';
import { validateSchema } from '../agent/ptc/schema.js';
import { validatePtcResult, ptcTerminal, aliasPtcResult } from '../environment/ptc-result.js';
import { validateIntent } from '../environment/protocol.js';
import type { Writable } from 'node:stream';
import { killGroup } from '../agent/tools/bash.js';
import { JsonlParser } from './rpc-framing.js';
import { withoutSecrets } from './secrets.js';
import type { PreparedSandbox } from './sandbox.js';
import type { EnvironmentExecutor } from '../environment/service.js';
import {
  REQUEST_BYTES,
  RESULT_BYTES,
  terminalSchema,
  type ExecutionIntent,
  type ExecutionEvent,
  type Terminal,
} from '../environment/protocol.js';
import { canonicalJson, digest, parseJson } from '../environment/json.js';
import { validateBroker, type BrokerKind, brokerSchemas } from '../environment/broker.js';
import type { Descriptor } from '../environment/protocol.js';
import { ExecutionBudget } from '../environment/budget.js';
import { EnvironmentCgroup } from './environment-cgroup.js';
import type { EnvironmentArtifacts } from '../environment/artifacts.js';
import { persistExecutorArtifacts } from './environment-result-artifacts.js';

/** IPC and broker work are drained, but descendant cleanup is not independently proven. */
export class EnvironmentCleanupUnverified extends Error {}

/** Supervisor launches only a PreparedSandbox selected with environmentExecutor:true. */
export class SandboxedEnvironmentExecutor implements EnvironmentExecutor {
  private child: ChildProcessWithoutNullStreams;
  private ready = false;
  private closed = false;
  private active:
    | {
        intent: ExecutionIntent;
        terminalReceived?: boolean;
        operations: Map<string, { name: string; settled: boolean }>;
        resolve(value: Terminal): void;
        reject(error: Error): void;
        event(kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']): void;
        cleanup(): void;
      }
    | undefined;
  private readonly control: Writable | undefined;
  readonly started: Promise<void>;
  readonly stopped: Promise<void>;
  private budget: ExecutionBudget | undefined;
  readonly managesBudget = true;
  private brokerRequests = new Map<string, AbortController>();
  private cancelledBrokers = new Set<string>();
  private backgroundOutstanding = false;
  private orderlyStop = false;
  private backgroundCleaned = false;
  private brokerWork = new Set<Promise<unknown>>();
  private readonly centralDispatched = new Set<string>();
  private cgroup: EnvironmentCgroup | undefined;
  private admitted = Promise.resolve();
  constructor(
    private readonly options: {
      sandbox: PreparedSandbox;
      cwd: string;
      /** Node-resolved trusted config hash, never supplied by a remote intent. */
      projectTrust?: string;
      descriptor?: Descriptor;
      /** Trusted node-owned storage, outside executor read/write roots. */
      artifacts?: EnvironmentArtifacts;
      /** Same trusted node journal; inner facts never live only in the sandbox child. */
      inner?: InnerJournal;
      ptcSnapshot?(intent: ExecutionIntent): { store: string; untrusted: string[] };
      /** Explicit delegated Linux cgroup parent; no automatic system configuration. */
      delegatedCgroup?: string;
      background?(
        tasks: Array<{ id: string; pid?: number | undefined; status: string; startedAt: string }>,
      ): void;
      request(
        kind: BrokerKind,
        payload: unknown,
        intent: ExecutionIntent,
        signal: AbortSignal,
      ): Promise<unknown>;
    },
  ) {
    if (!options.sandbox.status.active) throw new Error('Sandbox unavailable');
    this.cgroup = options.delegatedCgroup
      ? new EnvironmentCgroup(options.delegatedCgroup)
      : undefined;
    const command = this.cgroup ? '/bin/sh' : options.sandbox.command;
    const args = this.cgroup
      ? [
          '-c',
          'kill -STOP $$; exec "$@"',
          'pirc-environment-bootstrap',
          options.sandbox.command,
          ...options.sandbox.args,
        ]
      : options.sandbox.args;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...withoutSecrets(process.env),
        ...options.sandbox.env,
        PIRC_SANDBOX: 'srt',
        PIRC_SANDBOX_POLICY: JSON.stringify(options.sandbox.policy.paths),
        PIRC_PROJECT_TRUST: options.projectTrust ?? '',
      },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    if (this.cgroup)
      this.admitted = this.cgroup
        .admitStopped(
          child.pid!,
          () => child.exitCode === null && child.signalCode === null && !this.closed,
        )
        .catch((error) => {
          this.fail(error as Error);
          throw error;
        });
    void this.admitted.catch(() => {});
    this.stopped = new Promise((resolve) => child.once('close', () => resolve()));
    this.control = child.stdio[3] as Writable | undefined;
    this.control?.on('error', () => undefined);
    this.started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Executor startup timeout'));
        this.close();
      }, 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
        this.fail(error);
      };
      const parser = new JsonlParser(RESULT_BYTES, (value) => {
        const message = value as Record<string, any>;
        if (message?.type === 'executor.ready' && !this.ready) {
          this.ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (message?.type === 'executor.background') {
          const { tasks } = brokerSchemas.background.parse({ tasks: message.tasks });
          // Projection only: neither an empty list nor a reported PID is fencing evidence.
          if (tasks.some((task) => task.status === 'running' || task.status === 'stopping'))
            this.backgroundOutstanding = true;
          options.background?.(tasks);
          return;
        }
        if (message?.type === 'executor.shutdown_complete' && this.orderlyStop) {
          // Projection only. Independent cgroup evidence is required for regrant.
          return;
        }
        const active = this.active;
        if (
          !active ||
          active.terminalReceived ||
          message?.executionId !== active.intent.executionId
        ) {
          fail(new Error('Invalid executor reply'));
          return;
        }
        if (message.type === 'executor.cancel_request') {
          if (typeof message.id !== 'string') throw new Error('Invalid broker cancellation');
          const request = this.brokerRequests.get(message.id);
          if (request) {
            request.abort();
            this.cancelledBrokers.add(message.id);
          }
          return;
        }
        if (message.type === 'executor.wait') {
          // Child projection is not authority to pause a budget. Only pending,
          // validated supervisor human requests below may do so.
          if (typeof message.waiting !== 'boolean') throw new Error('Invalid human wait');
        } else if (message.type === 'executor.result') {
          if (this.brokerRequests.size) {
            fail(new Error('Executor terminal before broker completion; outcome unknown'));
            return;
          }
          const terminal = terminalSchema.parse(message.terminal);
          if (terminal.artifacts.length)
            throw new Error('Executor cannot manufacture artifact references');
          active.terminalReceived = true;
          // Keep the execution active until returned bytes are durably stored. A
          // cancellation/crash during ingestion must not publish a terminal result.
          const storageWork = (
            options.artifacts
              ? persistExecutorArtifacts(
                  terminal,
                  active.intent.binding,
                  options.artifacts,
                  this.operationController?.signal,
                )
              : Promise.resolve(terminal)
          )
            .then(async (stored) => {
              if (this.active !== active || !this.healthy) {
                if (options.artifacts)
                  await Promise.all(
                    stored.artifacts.map((artifact) =>
                      options.artifacts!.removeUnreferenced(active.intent.binding, artifact),
                    ),
                  );
                return;
              }
              // A tool may intentionally finish a cancelled wait. Preserve its
              // terminal semantics; ingestion itself observes cancellation above.
              if (active.intent.capability === 'ptc')
                options.inner?.seal(active.intent.binding, active.intent.executionId);
              this.active = undefined;
              active.cleanup();
              active.resolve(stored);
            })
            .catch(fail)
            .finally(() => this.brokerWork.delete(storageWork));
          this.brokerWork.add(storageWork);
        } else if (message.type === 'executor.operation') {
          const operation = message.operation as Record<string, unknown>;
          const suffix =
            typeof operation?.toolCallId === 'string'
              ? operation.toolCallId.slice(active.intent.executionId.length + 1)
              : '';
          if (
            active.intent.capability !== 'ptc' ||
            !String(operation?.toolCallId).startsWith(`${active.intent.executionId}:`) ||
            !/^op[1-9][0-9]{0,2}$/.test(suffix) ||
            Number(suffix.slice(2)) > 200 ||
            !['tool_execution_start', 'tool_execution_end'].includes(String(operation?.type)) ||
            !options.descriptor?.capabilityCatalog.some((cap) => cap.name === operation.toolName)
          )
            throw new Error('Invalid executor operation projection');
          const id = String(operation.toolCallId),
            known = active.operations.get(id);
          if (operation.type === 'tool_execution_start') {
            if (known || active.operations.size >= 200)
              throw new Error('Executor operation quota or duplicate ID');
            active.operations.set(id, { name: String(operation.toolName), settled: false });
          } else {
            if (!known || known.settled || known.name !== operation.toolName)
              throw new Error('Invalid executor operation settlement');
            known.settled = true;
          }
          // Bound display arguments and result; child output is never an approval receipt.
          const args =
            operation.args && typeof operation.args === 'object'
              ? Object.fromEntries(
                  Object.entries(operation.args).map(([key, value]) => [
                    key,
                    typeof value === 'string' ? value.slice(0, 1000) : value,
                  ]),
                )
              : {};
          const projected =
            operation.type === 'tool_execution_start'
              ? {
                  type: operation.type,
                  toolCallId: operation.toolCallId,
                  toolName: operation.toolName,
                  args: canonicalJson(args, RESULT_BYTES).length <= 4096 ? args : {},
                }
              : {
                  type: operation.type,
                  toolCallId: operation.toolCallId,
                  toolName: operation.toolName,
                  result: {
                    content: [{ type: 'text', text: 'Operation settled; durable result follows' }],
                  },
                  isError: operation.isError === true,
                };
          active.event('operation', parseJson(canonicalJson(projected, 65536), 65536));
        } else if (message.type === 'executor.progress') {
          active.event('progress', message.output);
        } else if (message.type === 'executor.request') {
          if (!Object.hasOwn(brokerSchemas, message.kind) || typeof message.id !== 'string') {
            fail(new Error('Invalid executor broker request'));
            return;
          }
          if (this.brokerRequests.size >= 8 || this.brokerRequests.has(message.id))
            throw new Error('Executor broker quota or duplicate ID');
          const requestController = Object.assign(new AbortController(), {
            kind: message.kind as string,
          });
          this.brokerRequests.set(message.id, requestController);
          const kind = message.kind as BrokerKind;
          let operation = active.intent;
          if (message.innerIntent) {
            if (active.intent.capability !== 'ptc' || !options.inner)
              throw new Error('Unexpected inner operation');
            operation = validateIntent(message.innerIntent);
            if (operation.parentExecutionId !== active.intent.executionId)
              throw new Error('Inner parent mismatch');
            const known = options.inner.status(
              operation.binding,
              active.intent.executionId,
              operation.innerOperationId!,
            );
            if (
              canonicalJson(known.intent, REQUEST_BYTES) !==
                canonicalJson(operation, REQUEST_BYTES) ||
              known.state !== 'running'
            )
              throw new Error('Inner operation unavailable');
          }
          const schema =
            operation.capability === 'ptc'
              ? {
                  type: 'object',
                  properties: { code: { type: 'string' }, timeout: { type: 'number' } },
                  required: ['code'],
                  additionalProperties: false,
                }
              : options.descriptor?.capabilityCatalog.find(
                  (entry) => entry.name === operation.capability,
                )?.argumentSchema;
          // Existing core-only harnesses may omit a descriptor, but approval arguments
          // still validate against the shipped registry, never a child-supplied schema.
          const payload = validateBroker(
            kind,
            message.payload,
            operation,
            (schema as Record<string, unknown> | undefined) ??
              this.coreSchema(operation.capability),
          );
          const controller = this.operationController!;
          const requestSignal = AbortSignal.any([controller.signal, requestController.signal]);
          const work = async () => {
            if (kind === 'ptc_inner_delivered') {
              if (active.intent.capability !== 'ptc' || !options.inner)
                throw new Error('No PTC journal');
              const operation = options.inner.status(
                active.intent.binding,
                active.intent.executionId,
                payload.innerOperationId,
              );
              if (!operation.result) throw new Error('Inner result not committed');
              options.inner.delivered(
                active.intent.binding,
                active.intent.executionId,
                payload.innerOperationId,
                digest(operation.result, RESULT_BYTES),
              );
              return null;
            }
            if (
              kind === 'ptc_preflight' ||
              kind === 'ptc_preflight_done' ||
              kind === 'ptc_post' ||
              kind === 'ptc_post_done'
            ) {
              if (active.intent.capability !== 'ptc' || !options.inner || !options.descriptor)
                throw new Error('PTC journal unavailable');
              const inner = validateIntent(payload.intent);
              if (inner.parentExecutionId !== active.intent.executionId)
                throw new Error('Inner parent mismatch');
              const cap = options.descriptor.capabilityCatalog.find(
                (cap) => cap.name === inner.capability && cap.placement === 'gateway',
              );
              if (!cap) throw new Error('Central capability unavailable');
              if (kind === 'ptc_preflight' || kind === 'ptc_post')
                options.inner.beginPhase(inner, kind === 'ptc_preflight' ? 'preflight' : 'post');
              else {
                if (
                  kind === 'ptc_preflight_done' &&
                  validateSchema(payload.arguments, cap.argumentSchema as Record<string, unknown>)
                    .length
                )
                  throw new Error('Invalid hook-final central arguments');
                options.inner.finishPhase(
                  inner,
                  kind === 'ptc_preflight_done' ? 'preflight' : 'post',
                  kind === 'ptc_preflight_done' ? payload.arguments : null,
                );
              }
              return null;
            }
            if (
              kind === 'ptc_inner_start' ||
              kind === 'ptc_inner_result' ||
              kind === 'ptc_central'
            ) {
              if (active.intent.capability !== 'ptc' || !options.inner || !options.descriptor)
                throw new Error('PTC journal unavailable');
              const inner = validateIntent(payload.intent);
              if (inner.parentExecutionId !== active.intent.executionId)
                throw new Error('Inner parent mismatch');
              if (kind === 'ptc_inner_start') {
                const accepted = options.inner.accept(inner);
                if (!accepted.fresh)
                  throw new Error('Inner operation already recorded; never replay');
                options.inner.claim(
                  inner.binding,
                  inner.parentExecutionId!,
                  inner.innerOperationId!,
                );
                return null;
              }
              const recorded = this.options.inner!.status(
                inner.binding,
                active.intent.executionId,
                inner.innerOperationId!,
              );
              if (
                recorded.state !== 'running' ||
                canonicalJson(recorded.intent, REQUEST_BYTES) !==
                  canonicalJson(inner, REQUEST_BYTES)
              )
                throw new Error('Unclaimed or conflicting inner operation');
              if (kind === 'ptc_inner_result') {
                const result = validatePtcResult(payload.result);
                const cap = options.descriptor.capabilityCatalog.find(
                  (cap) => cap.name === inner.capability,
                );
                if (cap?.placement === 'gateway') {
                  let phase: ReturnType<InnerJournal['phase']> | undefined;
                  try {
                    phase = options.inner.phase(inner, 'central');
                  } catch {}
                  if (phase?.state === 'completed') {
                    const trusted = validatePtcResult(phase.result, inner.innerOperationId);
                    if (
                      canonicalJson(
                        aliasPtcResult(result, inner.innerOperationId!),
                        RESULT_BYTES,
                      ) !==
                      canonicalJson(aliasPtcResult(trusted, inner.innerOperationId!), RESULT_BYTES)
                    )
                      throw new Error('Central result differs from supervisor evidence');
                  } else if (phase) {
                    this.fail(
                      new Error('Central operation still draining; executor fencing required'),
                    );
                    throw new Error('Central drain unverified; no guest continuation');
                  } else if (result.ok || result.error.outcome !== 'not_started')
                    throw new Error('Central effect never dispatched');
                }
                const terminal = ptcTerminal(result);
                options.inner.finish(
                  inner.binding,
                  inner.parentExecutionId!,
                  inner.innerOperationId!,
                  terminal,
                );
                return null;
              }
              const capability = options.descriptor.capabilityCatalog.find(
                (entry) => entry.name === inner.capability,
              );
              if (capability?.placement !== 'gateway') throw new Error('Not a central capability');
              const phase = options.inner.phase(inner, 'preflight');
              if (
                phase.state !== 'completed' ||
                canonicalJson(phase.result, REQUEST_BYTES) !==
                  canonicalJson(payload.arguments, REQUEST_BYTES)
              )
                throw new Error('Missing central preflight evidence');
              if (
                validateSchema(
                  payload.arguments,
                  capability.argumentSchema as Record<string, unknown>,
                ).length
              )
                throw new Error('Invalid central final arguments');
              options.inner.beginPhase(inner, 'central');
              if (this.centralDispatched.has(inner.executionId))
                throw new Error('Central inner already dispatched; reconcile original ID');
              this.centralDispatched.add(inner.executionId);
              let result;
              try {
                result = validatePtcResult(
                  await options.request(kind, payload, inner, requestSignal),
                  inner.innerOperationId,
                );
              } catch (error) {
                // A lost central reply is not evidence that the remote effect drained.
                // Stop this executor before the guest can release its slot and continue.
                this.fail(new Error('Central outcome/drain unknown; executor fencing required'));
                throw error;
              }
              options.inner.finishPhase(inner, 'central', result);
              return result;
            }
            return options.request(kind, payload, operation, requestSignal);
          };
          const human =
            kind === 'approval' ||
            kind === 'ui' ||
            (operation.capability === 'sandbox_allow_domains' && kind === 'sandbox') ||
            (operation.capability === 'unsandboxed_bash' && kind === 'sandbox') ||
            (operation.capability === 'browser_handoff' &&
              kind === 'browser' &&
              payload.op === 'wait_control');
          const brokerWork = (human ? this.budget!.humanWait(work()) : work())
            .then(
              (value) => {
                this.brokerRequests.delete(message.id);
                if (this.cancelledBrokers.delete(message.id)) {
                  if (this.active === active)
                    this.send({ type: 'executor.cancelled_request', id: message.id });
                  return;
                }
                if (this.active === active)
                  this.send({ type: 'executor.response', id: message.id, value: value ?? null });
              },
              (error) => {
                this.brokerRequests.delete(message.id);
                if (this.cancelledBrokers.delete(message.id)) {
                  if (this.active === active)
                    this.send({ type: 'executor.cancelled_request', id: message.id });
                  return;
                }
                if (this.active === active)
                  this.send({
                    type: 'executor.response',
                    id: message.id,
                    error: String(error).slice(0, 8192),
                  });
              },
            )
            .catch(fail)
            .finally(() => {
              this.brokerRequests.delete(message.id);
              this.brokerWork.delete(brokerWork);
            });
          this.brokerWork.add(brokerWork);
        } else fail(new Error('Unknown executor message'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch (error) {
          fail(error as Error);
        }
      });
      child.stderr.on('data', () => undefined); // Drain without retaining private hook/config output.
      child.on('error', fail);
      child.on('exit', () => fail(new Error('Sandbox executor exited; effects may be unknown')));
    });
  }
  private coreSchema(name: string): Record<string, unknown> | undefined {
    return builtinTools().find((tool) => tool.name === name)?.parameters;
  }
  remainingAbsoluteMs(): number {
    return this.budget?.remainingAbsolute() ?? 0;
  }
  updateNetwork(domains: Iterable<string>): void {
    if (!this.healthy || !this.control?.writable) throw new Error('Sandbox control unavailable');
    this.control.write(`${JSON.stringify(this.options.sandbox.settings(domains))}\n`);
  }
  private operationController: AbortController | undefined;
  get healthy(): boolean {
    return this.ready && !this.closed;
  }
  private send(value: unknown): void {
    if (this.closed || this.child.stdin.writableLength > REQUEST_BYTES)
      throw new Error('Executor IPC unavailable');
    this.child.stdin.write(`${canonicalJson(value, REQUEST_BYTES)}\n`);
  }
  async execute(
    intent: ExecutionIntent,
    signal: AbortSignal,
    event: (kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']) => void,
    remainingBudgetMs = intent.budgetMs,
  ): Promise<Terminal> {
    return this.dispatch(intent, signal, event, undefined, remainingBudgetMs);
  }
  async executeHook(
    intent: ExecutionIntent,
    phase: 'preflight' | 'post',
    signal: AbortSignal,
    result?: Terminal,
  ): Promise<Terminal> {
    const entry = this.options.descriptor?.capabilityCatalog.find(
      (item) => item.name === intent.capability,
    );
    if (!entry || entry.placement !== 'gateway')
      throw new Error('Unavailable gateway hook capability');
    return this.dispatch(intent, signal, () => {}, {
      phase,
      schema: entry.argumentSchema,
      ...(result ? { result } : {}),
    });
  }
  private async dispatch(
    intent: ExecutionIntent,
    signal: AbortSignal,
    event: (kind: ExecutionEvent['kind'], payload: ExecutionEvent['payload']) => void,
    hook?: unknown,
    remainingBudgetMs = intent.budgetMs,
  ): Promise<Terminal> {
    await this.admitted;
    await this.started;
    signal.throwIfAborted();
    // Hooks may rewrite actions; reserve ownership before the crash-before-inventory interval.
    this.backgroundOutstanding = true; // A compromised shipped child can launch descendants on any dispatch.
    if (!this.healthy || this.active) throw new Error('Executor unavailable or busy');
    return new Promise((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      this.budget = new ExecutionBudget(remainingBudgetMs);
      this.operationController = new AbortController();
      const abort = () => {
        this.operationController?.abort();
        try {
          this.send({ type: 'executor.cancel', executionId: intent.executionId });
        } catch {
          /* kill below */
        }
        killTimer = setTimeout(
          () => this.fail(new Error('Executor cancelled; effects may be unknown')),
          1000,
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      this.budget.controller.signal.addEventListener('abort', abort, { once: true });
      this.active = {
        intent,
        operations: new Map(),
        resolve,
        reject,
        event,
        cleanup: () => {
          clearTimeout(killTimer);
          this.operationController?.abort();
          for (const request of this.brokerRequests.values()) request.abort();
          this.brokerRequests.clear();
          this.cancelledBrokers.clear();
          signal.removeEventListener('abort', abort);
          this.budget?.controller.signal.removeEventListener('abort', abort);
          this.budget?.close();
          this.budget = undefined;
        },
      };
      try {
        let ptc;
        if (intent.capability === 'ptc') {
          if (
            !this.options.descriptor ||
            !this.options.inner ||
            (!this.options.ptcSnapshot && !intent.ptc)
          )
            throw new Error('PTC executor dependencies unavailable');
          const plan = planPtc(intent.arguments, this.options.descriptor.capabilityCatalog);
          if (plan.placement !== 'node') throw new Error('Gateway-only PTC cannot run on node');
          this.options.inner.register(intent, plan.manifest);
          ptc = {
            ...(intent.ptc ?? this.options.ptcSnapshot!(intent)),
            capabilities: plan.manifest,
            catalog: this.options.descriptor.capabilityCatalog,
          };
        }
        this.send({
          type: 'executor.start',
          intent,
          ...(hook ? { hook } : {}),
          ...(ptc ? { ptc } : {}),
        });
      } catch (error) {
        this.fail(error as Error);
      }
      if (signal.aborted) abort();
    });
  }
  private fail(error: Error): void {
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.cleanup();
      active.reject(error);
    }
    this.close();
  }
  async closeAndWait(): Promise<void> {
    if (!this.closed) {
      try {
        this.orderlyStop = true;
        this.send({ type: 'executor.shutdown' });
      } catch {
        /* fencing below */
      }
      await Promise.race([this.stopped, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
    }
    this.close();
    // Kill escaped descendants holding inherited pipes before waiting for 'close'.
    // Child 'exit' alone is not aggregate process or descriptor cleanup.
    if (this.cgroup) {
      await this.admitted.catch(() => {});
      await this.cgroup.fence();
      this.cgroup = undefined;
      this.backgroundCleaned = true;
    }
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.stopped,
        new Promise<never>((_resolve, reject) => {
          stopTimer = setTimeout(
            () => reject(new Error('Executor descriptors unclosed; binding quarantined')),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(stopTimer);
    }
    await Promise.allSettled([...this.brokerWork]);
    // Never use executor-reported namespace PIDs as host kill authority.
    // Abrupt loss with owned jobs is quarantined until independently verified
    // aggregate cleanup; eventual watchdog EOF is not a regrant proof.
    if (this.backgroundOutstanding && !this.backgroundCleaned)
      throw new EnvironmentCleanupUnverified(
        'Background cleanup unverified; keep binding and write leases quarantined',
      );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.operationController?.abort();
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.cleanup();
      active.reject(new Error('Executor stopped; outcome unknown'));
    }
    killGroup(this.child.pid, 'SIGKILL');
    this.options.sandbox.cleanup();
  }
}
