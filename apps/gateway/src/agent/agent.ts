import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  captureContext,
  joinPrompt,
  trimSections,
  withReportedUsage,
  writeContext,
  type ContextSnapshot,
  type PromptSection,
} from './context.js';
import { memoryPanel } from './features/memory/panel.js';
import { isFoldedDetails } from './features/memory/ledger.js';
import { memoryConfigFrom } from './features/memory/index.js';
import { capabilities, capabilityForTool, type Capabilities } from './capabilities.js';
import type {
  AgentConfig,
  ModelConfig,
  ModelRef,
  ProviderConfig,
  ThinkingLevel,
} from './config.js';
import { configRoles, sessionSettings, thinkingLevels } from './config.js';
import { expandModels, type AgentRole } from './roles.js';

/** Session entry recording the role a session started in (`Agent.setRole`). */
const ROLE_ENTRY = 'agent.role';
import { listModels } from '../models.js';
import { createRemoteStream, fetchRemoteModels } from './providers/remote.js';
import {
  contextTokens,
  defaultCompaction,
  isContextOverflow,
  runCompaction,
  type CompactionSettings,
} from './compaction.js';
import { AutoMode } from './auto-mode/index.js';
import type { Feature } from './feature.js';
import { HookRunner } from './hooks.js';
import type {
  AssistantMessage,
  CustomMessage,
  ImageContent,
  Message,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from './messages.js';
import { isRetryable, streamFor } from './providers/index.js';
import type { StreamFn, ToolSpec } from './providers/types.js';
import { PathGuard } from './sandbox.js';
import { OPERATION_ENTRY, type OperationEntry, type SessionStore } from './session-store.js';
import type { Tool, ToolContext, ToolResult, UiApi } from './tools/types.js';
import type { AcquireWrite } from './write-lease.js';
import { WRAPPER_NAMES } from './ptc/contracts.js';
import { capabilityIndexPrompt, modelTools } from './ptc/index.js';
import { DIRECT_CAPABILITIES } from './ptc/signatures.js';
import { CapabilityRegistry } from './ptc/registry.js';
import {
  executeLocalOperation,
  type OperationOptions,
  type OperationOutcome,
} from '../environment/local.js';
export type { OperationStage, OperationOptions, OperationOutcome } from '../environment/local.js';

export type Emit = (event: Record<string, unknown>) => void;

type QueueItem =
  | { kind: 'user'; text: string; images?: ImageContent[] }
  | { kind: 'custom'; message: CustomMessage };

export interface ResolvedModel {
  providerName: string;
  provider: ProviderConfig;
  model: ModelConfig;
}

export interface AgentOptions {
  config: AgentConfig;
  store: SessionStore;
  emit: Emit;
  ui: UiApi;
  hasUI: boolean;
  tools: Tool[];
  features?: Feature[];
  /** Test seam: override the provider stream function. */
  streamOverride?: StreamFn;
  /** Extra environment for tools (e.g. team broker variables). */
  toolEnv?: Record<string, string>;
  /** When set, only these tools are exposed (e.g. a restricted subagent kind). */
  allowedTools?: string[];
  capabilities?: Capabilities;
  /** A chat project's instructions from the node (features/project-instructions.ts). */
  projectInstructions?: string;
  /** A team child's role, from its configure line (features/team). */
  role?: AgentRole;
  /** Write-permission broker transport (see write-lease.ts); default grants everything. */
  acquireWrite?: AcquireWrite;
}

const RETRY_DELAYS = [2_000, 5_000, 15_000];

/** Ensure every tool call has a result and no result is orphaned, so providers accept the history. */
export function sanitizeHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  const open = new Map<string, ToolCall>();
  const flush = () => {
    for (const call of open.values())
      out.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'Tool call was interrupted before producing a result.' }],
        isError: true,
        timestamp: Date.now(),
      });
    open.clear();
  };
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (!open.has(message.toolCallId)) continue;
      open.delete(message.toolCallId);
      out.push(message);
      continue;
    }
    flush();
    out.push(message);
    if (
      message.role === 'assistant' &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted'
    )
      for (const part of message.content) if (part.type === 'toolCall') open.set(part.id, part);
  }
  flush();
  return out;
}

const INTERRUPTED_PARTIAL_CHARS = 2000;

/**
 * Providers drop aborted assistant messages from the context, so tell the
 * model its reply was cut off by the user and what it had written so far.
 */
function interruptedNote(message: AssistantMessage): QueueItem {
  let partial = message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
  if (partial.length > INTERRUPTED_PARTIAL_CHARS)
    partial = `${partial.slice(0, INTERRUPTED_PARTIAL_CHARS)}…`;
  return {
    kind: 'custom',
    message: {
      role: 'custom',
      customType: 'interrupted',
      display: false,
      timestamp: Date.now(),
      content: partial
        ? `[Your previous response was interrupted by the user.] Partial output:\n\n${partial}`
        : '[Your previous response was interrupted by the user before it produced any text.]',
    },
  };
}

/**
 * A direct call's arguments as `main` accepted them before schemas were checked: null for an
 * optional argument means absent, and a closed schema ignores unknown keys (models often add a
 * `description`). Scripts keep strict checking.
 */
export function lenientArgs(
  tool: Tool | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = tool?.parameters as
    | { properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown }
    | undefined;
  if (!schema?.properties || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  // Malformed JSON stays as parsed, so the model hears that its arguments were cut off.
  if ('__invalid_json' in args) return args;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        !(value === null && !required.has(key)) &&
        (schema.additionalProperties !== false || Object.hasOwn(schema.properties!, key)),
    ),
  );
}

/** Longest argument string kept in operation events and session entries, and the total. */
const RECORDED_STRING_CHARS = 16_384;
const RECORDED_ARGS_CHARS = 65_536;

/** Arguments as recorded for an operation: long strings cut, the whole bounded. */
export function recordedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const cut = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string')
      return value.length > RECORDED_STRING_CHARS
        ? `${value.slice(0, 4096)}…[${value.length} characters, truncated]`
        : value;
    if (!value || typeof value !== 'object') return value;
    if (depth >= 4) {
      const json = JSON.stringify(value) ?? '';
      return json.length > 1024
        ? `${json.slice(0, 1024)}…[${json.length} characters, truncated]`
        : value;
    }
    if (Array.isArray(value))
      return [
        ...value.slice(0, 200).map((item) => cut(item, depth + 1)),
        ...(value.length > 200 ? [`…[${value.length - 200} more items]`] : []),
      ];
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cut(item, depth + 1),
      ]),
    );
  };
  const bounded = cut(args, 0) as Record<string, unknown>;
  const size = JSON.stringify(bounded).length;
  return size <= RECORDED_ARGS_CHARS ? bounded : { truncated: true, characters: size };
}

/** A result as observers and the session see it: the script-only `data` stays out. */
function observed(result: ToolResult): ToolResult {
  if (result.data === undefined) return result;
  const { data: _data, ...rest } = result;
  return rest;
}

export class Agent {
  capabilities: Capabilities;
  readonly projectInstructions: string | undefined;
  /** The role this agent runs in: a team child's from its parent, else one set for this session. */
  role: AgentRole | undefined;
  readonly config: AgentConfig;
  readonly store: SessionStore;
  readonly guard: PathGuard;
  readonly hooks: HookRunner;
  readonly autoMode: AutoMode;
  readonly ui: UiApi;
  readonly hasUI: boolean;
  readonly features: Feature[];
  private readonly emitRaw: Emit;
  /** Internal capabilities, by name; the model reaches them through `ptc`, core ones also directly. */
  private readonly tools = new Map<string, Tool>();
  /** The script tools: `ptc` and `ptc_docs` (direct core capabilities are listed separately). */
  private readonly wrappers = new Map<string, Tool>();
  readonly capabilityRegistry: CapabilityRegistry;
  /**
   * Capabilities started by `ptc` executions still running. Their results
   * are not in the session yet, so features that judge where content came
   * from (memory provenance) consult this too.
   */
  readonly runningScripts = new Set<Set<string>>();
  private openDialogs = 0;
  /** The `ptc` operation running in the current async context, if any. */
  private readonly operationScope = new AsyncLocalStorage<{ toolCallId: string }>();
  /**
   * Operations still running. Work an operation started may outlive it and
   * keep its async context; only a live operation is named on a dialog.
   */
  private readonly activeOperations = new Set<string>();
  private readonly humanWaitListeners = new Set<(waiting: boolean) => void>();
  private readonly streamOverride: StreamFn | undefined;
  private readonly toolEnv: Record<string, string>;
  private readonly writeLease: AcquireWrite;
  private steering: QueueItem[] = [];
  private followUps: QueueItem[] = [];
  private running = false;
  private completionWake: (() => void) | undefined;
  private completionWaiting: string[] = [];
  private completionRevision = 0;

  /** Feature state changed; recheck completion without polling or calling the model. */
  completionChanged(): void {
    this.completionRevision++;
    this.completionWake?.();
  }

  /** Remove only matching custom notifications; never discard human input. */
  discardNotifications(predicate: (message: CustomMessage) => boolean): void {
    const keep = (item: QueueItem) => item.kind !== 'custom' || !predicate(item.message);
    this.steering = this.steering.filter(keep);
    this.followUps = this.followUps.filter(keep);
  }

  /** Batch only adjacent team events; never reorder a human follow-up. */
  private teamBatchSize(): number {
    let count = 0;
    let bytes = 0;
    while (count < 50) {
      const next = this.followUps[count];
      if (next?.kind !== 'custom' || next.message.customType !== 'agent-team') break;
      bytes += Buffer.byteLength(JSON.stringify(next.message));
      if (count && bytes > 40_000) break;
      count++;
    }
    return count;
  }

  private admitted(message: Message): void {
    for (const feature of this.features) feature.messageAdmitted?.(this, message);
  }

  private async waitForCompletion(signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.config.limits.completionWaitMs;
    try {
      while (!signal.aborted && !this.pendingCount) {
        const revision = this.completionRevision;
        const blockers = this.features.flatMap(
          (feature) => feature.completionBlockers?.(this) ?? [],
        );
        if (!blockers.length) return false;
        this.completionWaiting = blockers;
        this.ui.setStatus('completion-wait', 'Waiting for team: ' + blockers.join(', '));
        if (Date.now() >= deadline) {
          this.deliver(
            {
              customType: 'completion-timeout',
              display: true,
              content:
                'Team completion wait timed out. These workers have NOT completed: ' +
                blockers.join(', ') +
                '. Report the pending work honestly; do not claim completion. Workers were not stopped.',
            },
            { deliverAs: 'followUp' },
          );
          return true;
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', wake);
            if (this.completionWake === wake) this.completionWake = undefined;
            resolve();
          };
          const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
          this.completionWake = wake;
          signal.addEventListener('abort', wake, { once: true });
          if (signal.aborted || this.pendingCount || revision !== this.completionRevision) wake();
        });
      }
      return false;
    } finally {
      if (this.completionWaiting.length) this.ui.setStatus('completion-wait', undefined);
      this.completionWaiting = [];
    }
  }
  private controller: AbortController | null = null;
  /** Aborts only the current model call and tool batch; the run continues. */
  private turn: AbortController | null = null;
  private endTurn: () => void = () => {};
  /** `sendNow` arrived between turns: deliver the queue before the next model call. */
  private interruptPending = false;
  private runPromise: Promise<void> | null = null;
  private extraSystemPrompt = '';
  /**
   * What features added to the system prompt for the latest run
   * (`beforeAgentStart`: skills, browser, …). Side requests such as the
   * compaction summary reuse it, so their prefix matches the turns the
   * provider has cached.
   */
  private runPrompt: PromptSection[] = [];
  lastContext: ContextSnapshot | null = null;
  private compacting: AbortController | null = null;
  private closed = false;
  modelRef: { provider: string; id: string } | null = null;
  thinking: ThinkingLevel = 'medium';
  sessionName: string | null = null;
  nameSource: 'user' | 'auto' | null = null;

  constructor(options: AgentOptions) {
    this.capabilities = capabilities(options.capabilities);
    this.projectInstructions = options.projectInstructions;
    this.role = options.role;
    this.config = options.config;
    this.store = options.store;
    this.emitRaw = options.emit;
    this.ui = this.trackDialogs(options.ui);
    this.hasUI = options.hasUI;
    this.features = options.features ?? [];
    this.streamOverride = options.streamOverride;
    this.toolEnv = options.toolEnv ?? {};
    this.writeLease = options.acquireWrite ?? (async () => undefined);
    this.guard = new PathGuard(
      options.config.workspace,
      options.config.pathPolicy,
      options.config.protectedPaths,
    );
    this.hooks = new HookRunner(
      options.config.hooks,
      options.config.workspace,
      options.config.env,
      { sessionId: options.store.sessionId, cwd: options.config.workspace },
      (message) => this.ui.notify(message, 'warning'),
    );
    this.autoMode = new AutoMode(this);
    this.capabilityRegistry = new CapabilityRegistry(() => this.toolList, options.store.sessionId);
    const register = (tool: Tool) => {
      // The wrappers are never capabilities: no recursive dispatch.
      if (!WRAPPER_NAMES.has(tool.name)) this.tools.set(tool.name, tool);
    };
    for (const tool of options.tools) register(tool);
    for (const feature of this.features)
      for (const tool of feature.tools?.(this) ?? []) register(tool);
    for (const tool of modelTools(this)) this.wrappers.set(tool.name, tool);
    if (options.allowedTools) this.restrictTools(options.allowedTools);
    this.restoreSettings();
    // A session started in a role keeps its role (and its tool allowlist) on restart.
    const recorded = this.recordedRole();
    if (recorded && !this.role) {
      const { tools, ...role } = recorded;
      this.role = role;
      if (tools) this.restrictTools(tools);
    }
  }

  emit(event: Record<string, unknown>): void {
    if (!this.closed) this.emitRaw(event);
  }

  async init(): Promise<void> {
    this.extraSystemPrompt = await this.hooks.collect('sessionStart', {});
    for (const feature of this.features) await feature.init?.(this);
  }

  private restoreSettings(): void {
    const settings = sessionSettings(this.store.branch(), this.config);
    const info = this.store.latest('session_info');
    if (settings.model) this.modelRef = settings.model;
    this.thinking = settings.thinking;
    if (info) {
      this.sessionName = info.name;
      this.nameSource = info.source ?? 'user';
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pendingCount(): number {
    return this.steering.length + this.followUps.length;
  }

  /** Some feature will start another run after this one settles (see `Feature.willContinue`). */
  willContinue(): boolean {
    return this.features.some((feature) => {
      try {
        return feature.willContinue?.(this) === true;
      } catch {
        return false;
      }
    });
  }

  /** Available internal capabilities. */
  get toolList(): Tool[] {
    return [...this.tools.values()].filter((tool) => this.getTool(tool.name));
  }

  /** Core capabilities the model may also call directly (hybrid surface), when available. */
  get directToolList(): Tool[] {
    return DIRECT_CAPABILITIES.flatMap((name) => {
      const tool = this.getTool(name);
      return tool && this.tools.get(name) === tool ? [tool] : [];
    });
  }

  /**
   * What the provider sees: `ptc` and `ptc_docs` when any capability is
   * available, then the core capabilities that are also direct tools.
   */
  get modelToolList(): Tool[] {
    return this.toolList.length ? [...this.wrappers.values(), ...this.directToolList] : [];
  }

  /** Listen for "a human is being asked" (dialogs open); returns an unsubscribe function. */
  onHumanWait(listener: (waiting: boolean) => void): () => void {
    this.humanWaitListeners.add(listener);
    if (this.openDialogs) listener(true);
    return () => this.humanWaitListeners.delete(listener);
  }

  private humanWaitChanged(delta: number): void {
    const before = this.openDialogs > 0;
    this.openDialogs += delta;
    const after = this.openDialogs > 0;
    if (before !== after) for (const listener of this.humanWaitListeners) listener(after);
  }

  /** Wait for a human (see `ToolContext.humanWait`): a running ptc script's budget pauses. */
  humanWait<T>(work: Promise<T>): Promise<T> {
    this.humanWaitChanged(1);
    return work.finally(() => this.humanWaitChanged(-1));
  }

  /** The `ptc` operation running in this async context (dialogs are linked to it). */
  get currentOperation(): string | undefined {
    const id = this.operationScope.getStore()?.toolCallId;
    return id && this.activeOperations.has(id) ? id : undefined;
  }

  /**
   * Count open dialogs so a ptc execution's active-time budget pauses while a
   * human answers, and link each dialog to the operation that opened it.
   */
  private trackDialogs(ui: UiApi): UiApi {
    /** Dialog methods and the position of their options argument. */
    const dialogs = new Map([
      ['select', 2],
      ['choose', 3],
      ['confirm', 2],
      ['input', 2],
      ['editor', 2],
    ]);
    return new Proxy(ui, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== 'string' || typeof value !== 'function') return value;
        const at = dialogs.get(key);
        if (at === undefined) return value.bind(target);
        return (...args: unknown[]) => {
          const operation = this.currentOperation;
          if (operation) {
            const options = (args[at] ?? {}) as Record<string, unknown>;
            if (options.toolCallId === undefined) args[at] = { ...options, toolCallId: operation };
          }
          this.humanWaitChanged(1);
          let result: unknown;
          try {
            result = value.apply(target, args);
          } catch (error) {
            this.humanWaitChanged(-1);
            throw error;
          }
          return Promise.resolve(result).finally(() => this.humanWaitChanged(-1));
        };
      },
    });
  }

  getTool(name: string): Tool | undefined {
    const capability = capabilityForTool(name);
    return capability && !this.capabilities[capability] ? undefined : this.tools.get(name);
  }

  resolveModel(ref = this.modelRef): ResolvedModel {
    if (!ref) throw new Error('No model configured. Add providers to the gateway models.json');
    const provider = this.config.providers[ref.provider];
    const model = provider?.models.find((item) => item.id === ref.id);
    if (!provider || !model) throw new Error(`Unknown model ${ref.provider}/${ref.id}`);
    return { providerName: ref.provider, provider, model };
  }

  availableModels(): Array<Record<string, unknown>> {
    return listModels(this.config.models);
  }

  state(): Record<string, unknown> {
    let model: Record<string, unknown> | null = null;
    try {
      const resolved = this.resolveModel();
      model = {
        provider: resolved.providerName,
        id: resolved.model.id,
        name: resolved.model.name ?? resolved.model.id,
        contextWindow: resolved.model.contextWindow,
        reasoning: resolved.model.reasoning,
      };
    } catch {
      /* unconfigured */
    }
    return {
      sessionId: this.store.sessionId,
      sessionFile: this.store.file,
      sessionName: this.sessionName,
      sessionNameSource: this.nameSource,
      model,
      thinkingLevel: this.thinking,
      isStreaming: this.running,
      completionWaiting: this.completionWaiting,
      isCompacting: this.compacting !== null,
      messageCount: this.store.allMessages().length,
      pendingMessageCount: this.pendingCount,
    };
  }

  setModel(provider: string, id: string): void {
    this.resolveModel({ provider, id });
    this.modelRef = { provider, id };
    this.store.append({ type: 'model_change', provider, modelId: id });
  }

  /**
   * Keep only the named capabilities. `code`, `ptc` and `ptc_docs` are
   * ignored (the wrappers come with any capability); unknown names grant
   * nothing. Both warn, so a typo does not silently narrow a role.
   */
  private restrictTools(names: string[]): void {
    const allowed = new Set(names);
    const ignored = names.filter((name) => WRAPPER_NAMES.has(name));
    const unknown = names.filter((name) => !WRAPPER_NAMES.has(name) && !this.tools.has(name));
    for (const name of [...this.tools.keys()]) if (!allowed.has(name)) this.tools.delete(name);
    if (ignored.length)
      this.ui.notify(
        `Tool list: ${[...new Set(ignored)].join(', ')} ignored; ptc and ptc_docs come with any capability`,
        'warning',
      );
    if (unknown.length)
      this.ui.notify(
        `Tool list: unknown or unavailable capabilities ${[...new Set(unknown)].join(', ')} grant nothing`,
        'warning',
      );
  }

  private recordedRole(): (AgentRole & { tools?: string[] }) | undefined {
    const entry = this.store
      .branch()
      .findLast((item) => item.type === 'custom' && item.customType === ROLE_ENTRY);
    if (entry?.type !== 'custom') return undefined;
    const data = entry.data as {
      name?: unknown;
      instructions?: unknown;
      tools?: unknown;
      models?: unknown;
    };
    if (typeof data?.name !== 'string') return undefined;
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      name: data.name,
      ...(typeof data.instructions === 'string' ? { instructions: data.instructions } : {}),
      ...(Array.isArray(data.tools) ? { tools: strings(data.tools) } : {}),
      ...(Array.isArray(data.models) ? { models: strings(data.models) } : {}),
    };
  }

  /**
   * The model to fall back to when the current one fails: the next catalog
   * model after it along the role's model patterns. None when the session has
   * no role models, or runs on a model outside them (the user picked it).
   * A current model that left the catalog falls back to the first match.
   */
  private nextFallback(): ModelRef | undefined {
    const patterns = this.role?.models;
    if (!patterns?.length || !this.modelRef) return undefined;
    const candidates = expandModels(patterns, this.config.providers);
    const { provider, id } = this.modelRef;
    const index = candidates.findIndex((item) => item.provider === provider && item.id === id);
    if (index >= 0) return candidates[index + 1];
    const known = this.config.providers[provider]?.models.some((model) => model.id === id);
    return known ? undefined : candidates[0];
  }

  /** Switch the session to the next fallback model (it stays there); false when there is none. */
  private fallBack(reason: string): boolean {
    const next = this.nextFallback();
    if (!next) return false;
    const from = this.modelRef ? `${this.modelRef.provider}/${this.modelRef.id}` : 'none';
    this.setModel(next.provider, next.id);
    this.ui.notify(
      `Model ${from} failed (${reason.slice(0, 200)}); switching to ${next.provider}/${next.id}`,
      'warning',
    );
    return true;
  }

  /**
   * Start this session in one of the workspace's roles (roles.ts): its model,
   * thinking level, tool allowlist and instructions. Only before the session
   * has any messages, and only once; setting the same role again is a no-op.
   */
  setRole(name: string): void {
    const current = this.role ?? this.recordedRole();
    if (current) {
      if (current.name === name) return;
      throw new Error(`This session already runs in role ${current.name}`);
    }
    if (this.store.branch().some((entry) => entry.type === 'message'))
      throw new Error('A role can only be set before the session starts');
    const roles = configRoles(this.config);
    const preset = Object.hasOwn(roles, name) ? roles[name] : undefined;
    if (!preset)
      throw new Error(`Unknown role: ${name}; available: ${Object.keys(roles).join(', ')}`);
    if (preset.models) {
      const [first] = expandModels(preset.models, this.config.providers);
      if (!first) throw new Error(`No model matches role ${name}: ${preset.models.join(', ')}`);
      this.setModel(first.provider, first.id);
    }
    if (preset.thinking) this.setThinking(preset.thinking === 'max' ? 'xhigh' : preset.thinking);
    this.store.append({
      type: 'custom',
      customType: ROLE_ENTRY,
      data: {
        name,
        ...(preset.instructions ? { instructions: preset.instructions } : {}),
        ...(preset.tools ? { tools: preset.tools } : {}),
        ...(preset.models ? { models: preset.models } : {}),
      },
    });
    this.role = {
      name,
      ...(preset.instructions ? { instructions: preset.instructions } : {}),
      ...(preset.models ? { models: preset.models } : {}),
    };
    if (preset.tools) this.restrictTools(preset.tools);
  }

  setThinking(level: string): void {
    if (!(thinkingLevels as readonly string[]).includes(level))
      throw new Error(`Unknown thinking level ${level}`);
    this.thinking = level as ThinkingLevel;
    this.store.append({ type: 'thinking_level_change', thinkingLevel: level });
  }

  /** `auto` names come from the title feature; the gateway never lets them replace a user name. */
  setName(name: string, source: 'user' | 'auto' = 'user'): void {
    if (name === this.sessionName && source === this.nameSource) return;
    this.sessionName = name;
    this.nameSource = source;
    this.store.append({ type: 'session_info', name, source });
    this.emit({ type: 'session_name_changed', name, source });
  }

  private emitQueue(): void {
    const texts = (items: QueueItem[]) =>
      items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text);
    this.emit({
      type: 'queue_update',
      steering: texts(this.steering),
      followUp: texts(this.followUps),
    });
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const texts = (items: QueueItem[]) =>
      items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text);
    const cleared = { steering: texts(this.steering), followUp: texts(this.followUps) };
    const notifications = [...this.steering, ...this.followUps].flatMap((item) =>
      item.kind === 'custom' ? [item.message] : [],
    );
    for (const feature of this.features) feature.notificationsCleared?.(this, notifications);
    this.steering = [];
    this.followUps = [];
    this.emitQueue();
    return cleared;
  }

  /** Run `/name args` if a feature registered it (names may be namespaced, e.g. `om:status`). Returns true when handled. */
  private tryCommand(text: string): boolean {
    const match = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match) return false;
    for (const feature of this.features) {
      const command = feature.commands?.[match[1]!];
      if (!command) continue;
      void command
        .run(this, (match[2] ?? '').trim())
        .catch((error) => this.ui.notify((error as Error).message, 'error'));
      return true;
    }
    return false;
  }

  /** Side-panel state contributed by features (see `Feature.panel`). */
  panelState(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const feature of this.features) {
      try {
        Object.assign(out, feature.panel?.(this));
      } catch {
        /* a broken panel must not break the others */
      }
    }
    return out;
  }

  /** Tell clients a side-panel section changed, coalesced per tick. */
  panelChanged(section: string): void {
    this.changedSections.add(section);
    if (this.changedSections.size > 1) return;
    queueMicrotask(() => {
      const sections = [...this.changedSections];
      this.changedSections.clear();
      this.emit({ type: 'panel_changed', sections });
    });
  }
  private readonly changedSections = new Set<string>();

  commandList(): Array<{ name: string; description: string; source: string }> {
    return this.features.flatMap((feature) =>
      Object.entries(feature.commands ?? {}).map(([name, command]) => ({
        name,
        description: command.description,
        source: 'extension',
      })),
    );
  }

  private userInput(text: string): void {
    for (const feature of this.features) feature.userInput?.(this, text);
  }

  /** Start a run with a user prompt. Throws if a run is active. */
  prompt(text: string, images?: ImageContent[]): void {
    if (this.tryCommand(text)) return;
    if (this.running) throw new Error('Agent is already running; use steer or follow_up');
    this.userInput(text);
    this.startRun([{ kind: 'user', text, ...(images?.length ? { images } : {}) }]);
  }

  steer(text: string, images?: ImageContent[]): void {
    if (this.tryCommand(text)) return;
    this.userInput(text);
    const item: QueueItem = { kind: 'user', text, ...(images?.length ? { images } : {}) };
    if (!this.running) return this.startRun([item]);
    this.steering.push(item);
    this.completionChanged();
    this.emitQueue();
  }

  followUp(text: string, images?: ImageContent[]): void {
    if (this.tryCommand(text)) return;
    this.userInput(text);
    const item: QueueItem = { kind: 'user', text, ...(images?.length ? { images } : {}) };
    if (!this.running) return this.startRun([item]);
    this.followUps.push(item);
    this.completionChanged();
    this.emitQueue();
  }

  /**
   * Deliver the `index`th queued user message (hidden notifications are not
   * counted) now: it moves to the front of the steering queue and interrupts
   * the current model call or tool. `text` must still match, so a message that
   * was already delivered or cleared is never sent twice.
   */
  sendNow(queue: 'steering' | 'followUp', index: number, text: string): void {
    const list = queue === 'steering' ? this.steering : this.followUps;
    const at = list.flatMap((item, i) => (item.kind === 'user' ? [i] : []))[index];
    const item = at === undefined ? undefined : list[at];
    if (item?.kind !== 'user' || item.text !== text)
      throw new Error('That message is no longer queued');
    list.splice(at!, 1);
    if (!this.running) {
      this.emitQueue();
      return this.startRun([item]);
    }
    this.steering.unshift(item);
    this.emitQueue();
    this.completionChanged();
    if (this.turn) this.turn.abort();
    else this.interruptPending = true;
  }

  /**
   * Deliver an extension message. While running it is queued; while idle it
   * either starts a run (`triggerTurn`) or is recorded without a turn.
   */
  deliver(
    input: Omit<CustomMessage, 'role' | 'timestamp'>,
    options: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' } = {},
  ): void {
    const message: CustomMessage = { role: 'custom', timestamp: Date.now(), ...input };
    const item: QueueItem = { kind: 'custom', message };
    if (this.running) {
      if (options.deliverAs === 'followUp') this.followUps.push(item);
      else this.steering.push(item);
      this.completionChanged();
      return;
    }
    if (options.triggerTurn) this.startRun([item]);
    else this.appendMessage(message);
  }

  abort(): void {
    for (const feature of this.features) feature.abort?.(this);
    this.controller?.abort();
    this.compacting?.abort();
  }

  async idle(): Promise<void> {
    while (this.runPromise) await this.runPromise;
  }

  appendMessage(message: Message): string {
    const entry = this.store.append({ type: 'message', message });
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
    return entry.id;
  }

  private startRun(initial: QueueItem[]): void {
    this.running = true;
    const run = this.run(initial)
      .catch((error) => {
        const message = `Agent loop crashed: ${(error as Error).message}`;
        // The run failed (no model, a broken session...): the node records it,
        // so nobody reads it as a success, least of all an unattended run.
        this.emit({ type: 'agent_error', error: message });
        this.ui.notify(message, 'error');
      })
      .finally(() => {
        this.running = false;
        this.controller = null;
        if (this.runPromise === run) this.runPromise = null;
        void this.settle();
      });
    this.runPromise = run;
  }

  private async settle(): Promise<void> {
    this.emit({ type: 'agent_settled' });
    if (this.config.hooks.agentSettled.length)
      void this.hooks.run('agentSettled', { messageCount: this.store.allMessages().length });
    for (const feature of this.features) {
      try {
        await feature.agentSettled?.(this);
      } catch (error) {
        this.ui.notify(`${feature.name}: ${(error as Error).message}`, 'warning');
      }
    }
    // A feature (e.g. background completion) may have queued work while settling.
    if (!this.running && this.steering.length + this.followUps.length) {
      const next = [...this.steering, ...this.followUps];
      this.steering = [];
      this.followUps = [];
      this.emitQueue();
      this.startRun(next);
    }
  }

  private async admit(items: QueueItem[]): Promise<void> {
    for (const item of items) {
      if (item.kind === 'custom') {
        this.appendMessage(item.message);
        this.admitted(item.message);
        continue;
      }
      if (this.config.hooks.beforePrompt.length) {
        const extra = await this.hooks.collect('beforePrompt', { prompt: item.text });
        if (extra)
          this.appendMessage({
            role: 'custom',
            customType: 'hook-context',
            content: extra,
            display: false,
            timestamp: Date.now(),
          });
      }
      const message: UserMessage = {
        role: 'user',
        content: item.images?.length
          ? [{ type: 'text', text: item.text }, ...item.images]
          : item.text,
        timestamp: Date.now(),
      };
      this.appendMessage(message);
    }
  }

  /** The system prompt; `extra` defaults to the latest run's feature additions. */
  systemPrompt(extra = this.runPrompt): string {
    return joinPrompt(this.promptSections(extra));
  }

  promptSections(extra = this.runPrompt): PromptSection[] {
    return [
      ...this.config.systemPrompt,
      ...(this.extraSystemPrompt
        ? [
            {
              id: 'hook:sessionStart',
              title: 'Session start hook',
              source: 'hook',
              text: this.extraSystemPrompt,
            },
          ]
        : []),
      ...extra,
      ...((index) =>
        index
          ? [{ id: 'capabilities', title: 'Capabilities', source: 'built-in', text: index }]
          : [])(capabilityIndexPrompt(this)),
      {
        id: 'cwd',
        title: 'Working directory',
        source: 'built-in',
        text: 'Current working directory: ' + this.config.workspace,
      },
    ];
  }

  private saveContext(snapshot: ContextSnapshot): void {
    this.lastContext = snapshot;
    try {
      writeContext(this.store.dir, snapshot);
    } catch {
      this.ui.notify(
        'Unable to persist the context snapshot; the live inspector is still available.',
        'warning',
      );
    }
    this.panelChanged('context');
  }

  toolSpecs(): ToolSpec[] {
    return this.modelToolList.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  get compactionSettings(): CompactionSettings {
    const raw = (this.config.features.compaction ?? {}) as Partial<CompactionSettings>;
    return { ...defaultCompaction, ...raw };
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  /** Manual `/compact` or RPC `compact`; only while idle. */
  async compact(instructions?: string) {
    if (this.running) throw new Error('Cannot compact while the agent is running');
    if (this.compacting) throw new Error('Compaction already in progress');
    const controller = new AbortController();
    this.compacting = controller;
    try {
      const result = await runCompaction(this, {
        reason: 'manual',
        signal: controller.signal,
        settings: this.compactionSettings,
        ...(instructions ? { instructions } : {}),
      });
      if (!result.ok) throw new Error(result.error ?? 'Compaction failed');
      return result;
    } finally {
      this.compacting = null;
    }
  }

  /** Compact before a turn when the context is near the window. */
  private async maybeCompact(signal: AbortSignal): Promise<void> {
    const settings = this.compactionSettings;
    if (!settings.enabled) return;
    let window: number;
    try {
      window = this.resolveModel().model.contextWindow;
    } catch {
      return;
    }
    const used = contextTokens(this.store.contextEntries());
    if (used <= window - settings.reserveTokens) return;
    const result = await this.withCompacting(signal, (inner) =>
      runCompaction(this, { reason: 'threshold', signal: inner, settings }),
    );
    if (!result.ok && !signal.aborted)
      this.ui.notify(`Automatic compaction failed: ${result.error}`, 'warning');
  }

  private async withCompacting<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    this.compacting = controller;
    try {
      return await fn(controller.signal);
    } finally {
      this.compacting = null;
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Refresh public metadata only; provider credentials never reach this process. */
  async refreshModels(): Promise<void> {
    const inference = this.config.models.inference;
    if (!inference) return;
    let latest;
    try {
      latest = await fetchRemoteModels(inference);
    } catch {
      return; // Keep the last catalog; inference reports its own availability errors.
    }
    // Mutate this shared snapshot so team managers retain the current catalog.
    this.config.models.providers = latest.providers;
    this.config.models.defaultModel = latest.defaultModel;
    this.config.providers = latest.providers;
    if (!this.modelRef) {
      const fallback = this.config.defaultModel ?? latest.defaultModel;
      const [name, provider] = Object.entries(latest.providers)[0] ?? [];
      this.modelRef = fallback
        ? { provider: fallback.provider, id: fallback.id }
        : name && provider?.models[0]
          ? { provider: name, id: provider.models[0].id }
          : null;
    }
  }

  /** Every feature uses the same gateway transport (tests may override it). */
  streamFunction(provider: ProviderConfig): StreamFn {
    if (this.streamOverride) return this.streamOverride;
    const inference = this.config.models.inference;
    return inference ? createRemoteStream(inference) : streamFor(provider);
  }

  private contextFor(upTo?: string): Message[] {
    const entries = this.store.contextEntries();
    if (!upTo || upTo === 'end') return entries.map((entry) => entry.message);
    const index = entries.findIndex((entry) => entry.entryId === upTo);
    return (index === -1 ? entries : entries.slice(0, index)).map((entry) => entry.message);
  }

  /** One provider call with retries; emits streaming events. */
  async stream(
    systemPrompt: string,
    signal: AbortSignal,
    options: {
      emit?: boolean;
      maxTokens?: number;
      toolChoice?: 'auto' | 'none';
      /** Appended after the history (not persisted), e.g. a summarization instruction. */
      extraMessages?: Message[];
      /** Only include context entries before this entry id ('end' = all). */
      upTo?: string;
      thinking?: ThinkingLevel;
      retries?: boolean;
      /**
       * Runs on the final reply just before its `message_end` (not on retried
       * attempts), so a caller can persist it first: the node reads history
       * from the session file, and an event must never be ahead of it.
       */
      beforeEnd?: (message: AssistantMessage) => void;
    } = {},
  ): Promise<AssistantMessage> {
    let resolved: ResolvedModel;
    try {
      resolved = this.resolveModel();
    } catch (error) {
      // The model left the catalog: a role falls back along its models.
      if (options.retries === false || !this.fallBack((error as Error).message)) throw error;
      resolved = this.resolveModel();
    }
    let { providerName, provider, model } = resolved;
    let streamFn = this.streamFunction(provider);
    const emit = options.emit !== false;
    for (let attempt = 0; ; attempt++) {
      const timestamp = Date.now();
      if (emit)
        this.emit({
          type: 'message_start',
          message: {
            role: 'assistant',
            content: [],
            timestamp,
            provider: providerName,
            model: model.id,
          },
        });
      const messages = [
        ...sanitizeHistory(this.contextFor(options.upTo)),
        ...(options.extraMessages ?? []),
      ];
      const tools = this.toolSpecs();
      const sections = this.promptSections();
      const branch = this.store.branch();
      const compaction = branch.findLast((entry) => entry.type === 'compaction');
      let memoryTokens = 0;
      if (
        compaction?.type === 'compaction' &&
        isFoldedDetails(compaction.details) &&
        messages.some(
          (m) =>
            m.role === 'compactionSummary' &&
            m.summary === compaction.summary &&
            m.timestamp === compaction.timestamp,
        )
      ) {
        const panel = memoryPanel(
          branch,
          memoryConfigFrom(this.config.features),
          model.contextWindow,
        );
        memoryTokens = [...panel.observations, ...panel.reflections]
          .filter((item) => item.visible)
          .reduce((sum, item) => sum + item.tokenCount, 0);
      }
      const snapshot = captureContext({
        sections:
          joinPrompt(sections) === systemPrompt
            ? sections
            : [
                {
                  id: 'request',
                  title: 'Request system prompt',
                  source: 'built-in',
                  text: systemPrompt,
                },
              ],
        tools,
        capabilities: this.capabilityRegistry.summaries(),
        messages,
        memoryTokens,
        model: {
          provider: providerName,
          id: model.id,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        },
      });
      this.saveContext(snapshot);
      let message: AssistantMessage;
      try {
        message = await streamFn(
          {
            providerName,
            provider,
            model,
            apiKey: provider.apiKey,
            systemPrompt,
            messages,
            tools,
            thinking: model.reasoning ? (options.thinking ?? this.thinking) : 'off',
            sessionId: this.store.sessionId,
            signal,
            ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
            ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
          },
          (delta) => {
            if (emit) this.emit({ type: 'message_update', assistantMessageEvent: delta });
          },
        );
      } catch (error) {
        message = {
          role: 'assistant',
          content: [],
          api: provider.api,
          provider: providerName,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: 'error',
          errorMessage: (error as Error).message,
          timestamp,
        };
      }
      if (this.lastContext?.id === snapshot.id)
        this.saveContext(withReportedUsage(snapshot, message.usage));
      message.timestamp = timestamp;
      message.completedAt = Date.now();
      const retryable =
        message.stopReason === 'error' &&
        options.retries !== false &&
        !signal.aborted &&
        isRetryable(message.errorMessage) &&
        !message.content.some((part) => part.type === 'text' && part.text);
      // A role with more models moves on at once instead of retrying this one.
      if (retryable && this.fallBack(message.errorMessage ?? 'error')) {
        if (emit) this.emit({ type: 'message_end', message });
        ({ providerName, provider, model } = this.resolveModel());
        streamFn = this.streamFunction(provider);
        attempt = -1;
        continue;
      }
      const retry = retryable && attempt < RETRY_DELAYS.length;
      if (!retry) {
        options.beforeEnd?.(message);
        if (emit) this.emit({ type: 'message_end', message });
        return message;
      }
      if (emit) this.emit({ type: 'message_end', message });
      const delayMs = RETRY_DELAYS[attempt]!;
      this.emit({
        type: 'auto_retry_start',
        attempt: attempt + 1,
        maxAttempts: RETRY_DELAYS.length,
        delayMs,
        errorMessage: message.errorMessage,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.emit({ type: 'auto_retry_end', success: !signal.aborted, attempt: attempt + 1 });
      if (signal.aborted) {
        message.stopReason = 'aborted';
        return message;
      }
    }
  }

  private async run(initial: QueueItem[]): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const produced: Message[] = [];
    this.emit({ type: 'agent_start' });
    const extraPrompt: PromptSection[] = [];
    try {
      const hidden: CustomMessage[] = [];
      for (const feature of this.features) {
        const result = await feature.beforeAgentStart?.(this);
        if (result?.systemPrompt)
          extraPrompt.push(
            ...(typeof result.systemPrompt === 'string'
              ? [
                  {
                    id: feature.name,
                    title: feature.name,
                    source: 'feature:' + feature.name,
                    text: result.systemPrompt,
                  },
                ]
              : result.systemPrompt),
          );
        if (result?.messages) hidden.push(...result.messages);
      }
      await this.admit([
        ...initial.slice(0, 1),
        ...hidden.map((message) => ({ kind: 'custom' as const, message })),
        ...initial.slice(1),
      ]);
    } catch (error) {
      this.ui.notify(`Failed to start run: ${(error as Error).message}`, 'error');
    }
    this.runPrompt = trimSections(extraPrompt);
    let turns = 0;
    let overflowRetried = false;
    let completionTimedOut = false;
    while (!signal.aborted) {
      if (++turns > this.config.limits.maxTurns) {
        this.ui.notify(`Stopped after ${this.config.limits.maxTurns} turns`, 'warning');
        break;
      }
      // Team reports are safe at tool boundaries. Admit them before the next
      // model call so a final synthesis cannot overlook already-queued results.
      const teamBatch = this.teamBatchSize();
      if (teamBatch) await this.admit(this.followUps.splice(0, teamBatch));
      this.endTurn();
      await this.maybeCompact(signal);
      if (signal.aborted) break;
      if (this.interruptPending) {
        // A `sendNow` during compaction or between turns: nothing to interrupt.
        this.interruptPending = false;
        const items = this.steering;
        this.steering = [];
        this.emitQueue();
        await this.admit(items);
      }
      const turn = new AbortController();
      const onRunAbort = () => turn.abort();
      signal.addEventListener('abort', onRunAbort, { once: true });
      this.turn = turn;
      this.endTurn = () => {
        signal.removeEventListener('abort', onRunAbort);
        if (this.turn === turn) this.turn = null;
      };
      const interrupted = () => turn.signal.aborted && !signal.aborted;
      this.emit({ type: 'turn_start' });
      const compactsInstead = (reply: AssistantMessage) =>
        isContextOverflow(reply) && !overflowRetried && this.compactionSettings.enabled;
      let persisted = false;
      const message = await this.stream(this.systemPrompt(this.runPrompt), turn.signal, {
        beforeEnd: (reply) => {
          if (compactsInstead(reply)) return;
          this.store.append({ type: 'message', message: reply });
          persisted = true;
        },
      });
      if (!persisted && compactsInstead(message)) {
        // Drop the failed reply, compact everything, and retry the turn once.
        overflowRetried = true;
        this.emit({ type: 'turn_end' });
        const result = await this.withCompacting(signal, (inner) =>
          runCompaction(this, {
            reason: 'overflow',
            signal: inner,
            settings: this.compactionSettings,
          }),
        );
        if (result.ok) continue;
      }
      // Normally already written by `beforeEnd`; an abort during a retry wait returns without it.
      if (!persisted) this.store.append({ type: 'message', message });
      produced.push(message);
      const results: ToolResultMessage[] = [];
      if (message.stopReason === 'toolUse') {
        const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
        for (const call of calls) {
          // Plain steers wait for the whole batch; only an abort or `sendNow` skips calls.
          if (turn.signal.aborted) {
            results.push(
              this.recordResult(call, {
                content: [
                  {
                    type: 'text',
                    text: signal.aborted
                      ? 'Aborted by the user before this tool ran.'
                      : 'Interrupted: the user sent a message before this tool ran.',
                  },
                ],
                isError: true,
              }),
            );
            continue;
          }
          results.push(await this.executeTool(call, turn.signal));
        }
      }
      // Markers only: every message already went out in its own message_end,
      // and repeating a turn's worth of tool output in one line could exceed
      // the node's per-line RPC limit and get the agent killed.
      this.emit({ type: 'turn_end' });
      for (const feature of this.features) await feature.turnEnd?.(this, message);
      if (message.stopReason === 'error') break;
      if (message.stopReason === 'aborted' && !interrupted()) break;
      if (this.steering.length) {
        const items: QueueItem[] = this.steering;
        this.steering = [];
        this.interruptPending = false;
        this.emitQueue();
        if (message.stopReason === 'aborted') items.unshift(interruptedNote(message));
        await this.admit(items);
        continue;
      }
      if (message.stopReason === 'toolUse') continue;
      // Do not remove/acknowledge reports unless another model turn can use
      // them. At the turn limit leave queued reports for settle's next run.
      if (turns >= this.config.limits.maxTurns) {
        this.ui.notify(
          `Stopped after ${this.config.limits.maxTurns} turns; team work may still be pending.`,
          'warning',
        );
        break;
      }
      if (!this.pendingCount && !completionTimedOut)
        completionTimedOut = await this.waitForCompletion(signal);
      if (signal.aborted) break;
      if (!this.followUps.length)
        for (const feature of this.features) await feature.agentEnd?.(this, produced);
      if (this.steering.length || this.followUps.length) {
        const count = this.teamBatchSize() || 1;
        const items = [...this.steering, ...this.followUps.splice(0, count)];
        this.steering = [];
        this.emitQueue();
        await this.admit(items);
        continue;
      }
      break;
    }
    this.endTurn();
    this.interruptPending = false;
    this.emit({ type: 'agent_end', willRetry: false });
  }

  private recordResult(call: ToolCall, result: ToolResult): ToolResultMessage {
    const message: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: result.content.length ? result.content : [{ type: 'text', text: '(no output)' }],
      ...(result.details === undefined ? {} : { details: result.details }),
      isError: !!result.isError,
      timestamp: Date.now(),
    };
    this.store.append({ type: 'message', message });
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
    this.admitted(message);
    return message;
  }

  /**
   * Obtain the write lease for the allowed root containing `file` (none for
   * shared roots such as /tmp). Team children's requests arrive here too, so
   * they share this session's lease.
   */
  async acquireWrite(file: string, signal?: AbortSignal): Promise<void> {
    const root = this.guard.leaseRoot(file);
    if (root) await this.writeLease(root, signal);
  }

  toolContext(
    toolCallId: string,
    signal: AbortSignal,
    onUpdate?: (r: ToolResult) => void,
  ): ToolContext {
    return {
      cwd: this.config.workspace,
      config: this.config,
      guard: this.guard,
      signal,
      toolCallId,
      ui: this.ui,
      hasUI: this.hasUI,
      env: { ...this.config.env, ...this.toolEnv },
      acquireWrite: (file) => this.acquireWrite(file, signal),
      update: onUpdate ?? (() => undefined),
      humanWait: (work) => this.humanWait(work),
    };
  }

  /** Run one internal capability with the full policy chain; the result only. */
  async invokeTool(
    name: string,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    toolCallId: string = randomUUID(),
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    return (await this.invokeOperation(name, rawArgs, signal, toolCallId, onUpdate)).result;
  }

  /**
   * Run one internal capability (a `ptc` operation): availability, argument
   * validation, hooks, validation of hook-rewritten arguments, auto mode and
   * the write lease, then the tool. `stage` tells how far it got.
   */
  async invokeOperation(
    name: string,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    toolCallId: string = randomUUID(),
    onUpdate?: (result: ToolResult) => void,
    options: OperationOptions = {},
  ): Promise<OperationOutcome> {
    const tool = this.getTool(name);
    const capability = capabilityForTool(name);
    if (!tool && capability && this.tools.has(name))
      return {
        stage: 'unavailable',
        result: {
          content: [
            {
              type: 'text',
              text: `The ${capability} capability is disabled for this project; ${name} is unavailable. Ask the user to enable it in the project settings if needed.`,
            },
          ],
          isError: true,
        },
      };
    if (!tool)
      return {
        stage: 'unavailable',
        result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
      };
    return this.runTool(tool, rawArgs, signal, toolCallId, onUpdate, options);
  }

  /**
   * One `ptc` operation, observable like a direct call (docs/evaluations/ptc/ptc-only.md §6):
   * `tool_execution_*` events under the capability's name, linked to the
   * `ptc` call by `parentToolCallId`, and a `ptc.operation` session entry with
   * the result as the tool returned it (never a `message`: the model sees
   * only what the script returns). Dialogs it opens carry its id.
   */
  async runOperation(
    parentToolCallId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    operationId: string,
    options: OperationOptions = {},
  ): Promise<OperationOutcome> {
    // What observers and the session see of the arguments: bounded, since a script can pass
    // large arguments without the model writing them out (the operation gets them in full).
    const shown = recordedArgs(args);
    this.emit({
      type: 'tool_execution_start',
      toolCallId: operationId,
      toolName: name,
      args: shown,
      parentToolCallId,
    });
    let lastUpdate = 0;
    this.activeOperations.add(operationId);
    let outcome: OperationOutcome | undefined;
    let failure: unknown;
    try {
      outcome = await this.operationScope.run({ toolCallId: operationId }, () =>
        this.invokeOperation(
          name,
          args,
          signal,
          operationId,
          (partial) => {
            const now = Date.now();
            if (now - lastUpdate < 100) return;
            lastUpdate = now;
            this.emit({
              type: 'tool_execution_update',
              toolCallId: operationId,
              toolName: name,
              args: shown,
              partialResult: observed(partial),
              parentToolCallId,
            });
          },
          options,
        ),
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
      // Always ended for observers, even if the call itself threw.
      const result = observed(
        outcome?.result ?? {
          content: [
            {
              type: 'text',
              text: signal.aborted
                ? 'Cancelled'
                : (failure as Error | undefined)?.message || 'The operation failed unexpectedly',
            },
          ],
          isError: true,
        },
      );
      const entry: OperationEntry = {
        parentToolCallId,
        toolCallId: operationId,
        toolName: name,
        args: shown,
        content: result.content.length ? result.content : [{ type: 'text', text: '(no output)' }],
        ...(result.details === undefined ? {} : { details: result.details }),
        isError: !!result.isError,
        timestamp: Date.now(),
      };
      // Written before it is announced, like messages: a snapshot is never behind the events.
      try {
        this.store.append({ type: 'custom', customType: OPERATION_ENTRY, data: entry });
      } catch (error) {
        process.stderr.write(`could not record operation ${operationId}: ${String(error)}\n`);
      }
      this.emit({
        type: 'tool_execution_end',
        toolCallId: operationId,
        toolName: name,
        result,
        isError: !!result.isError,
        parentToolCallId,
      });
      for (const feature of this.features)
        try {
          feature.operationRecorded?.(this, entry);
        } catch (error) {
          process.stderr.write(`operationRecorded failed in ${feature.name}: ${String(error)}\n`);
        }
    }
    return outcome;
  }

  private async runTool(
    tool: Tool,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    toolCallId: string,
    onUpdate?: (result: ToolResult) => void,
    options: OperationOptions = {},
  ): Promise<OperationOutcome> {
    return executeLocalOperation(
      {
        hooks: this.hooks,
        hasAfterHooks: () => !!this.config.hooks.afterTool.length,
        gate: (name, args, callSignal) => this.autoMode.gate(name, args, callSignal),
        context: (id, callSignal, update) => this.toolContext(id, callSignal, update),
        log: (message) => {
          process.stderr.write(message);
        },
      },
      tool,
      rawArgs,
      signal,
      toolCallId,
      onUpdate,
      options,
    );
  }

  /** A provider tool call: only the model-facing tools exist at this level. */
  private async invokeModelTool(
    call: ToolCall,
    signal: AbortSignal,
    onUpdate: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const wrapper = this.wrappers.get(call.name);
    if (wrapper && this.toolList.length)
      return (await this.runTool(wrapper, call.arguments, signal, call.id, onUpdate)).result;
    // A direct core capability: the same policy chain as a ptc operation, in an operation scope
    // so the dialogs it opens name its call; typed data stays here. A core capability disabled
    // by policy gets the same explanation as from a script.
    if (
      this.directToolList.some((tool) => tool.name === call.name) ||
      (DIRECT_CAPABILITIES.includes(call.name) &&
        this.tools.has(call.name) &&
        capabilityForTool(call.name))
    ) {
      this.activeOperations.add(call.id);
      try {
        return observed(
          (
            await this.operationScope.run({ toolCallId: call.id }, () =>
              this.invokeOperation(
                call.name,
                lenientArgs(this.getTool(call.name), call.arguments),
                signal,
                call.id,
                (partial) => onUpdate(observed(partial)),
              ),
            )
          ).result,
        );
      } finally {
        this.activeOperations.delete(call.id);
      }
    }
    const capability = this.getTool(call.name);
    return {
      content: [
        {
          type: 'text',
          text: capability
            ? `${call.name} is not a direct tool: call it from a ptc script, e.g. ptc({ code: "return await tools.${call.name}({ … })" }). ptc_docs({ names: ["${call.name}"] }) shows its arguments.`
            : `Unknown tool: ${call.name}. The tools are ${this.modelToolList.map((tool) => tool.name).join(', ') || 'none'}.`,
        },
      ],
      isError: true,
    };
  }

  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
    this.emit({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    let lastUpdate = 0;
    const result = await this.invokeModelTool(call, signal, (partial) => {
      const now = Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      this.emit({
        type: 'tool_execution_update',
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
        partialResult: partial,
      });
    });
    this.emit({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: !!result.isError,
    });
    return this.recordResult(call, result);
  }

  async shutdown(): Promise<void> {
    this.abort();
    await this.idle();
    for (const feature of this.features) {
      try {
        await feature.shutdown?.(this);
      } catch {
        /* best effort */
      }
    }
    this.closed = true;
  }
}
