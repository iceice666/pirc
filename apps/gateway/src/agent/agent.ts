import { randomUUID } from 'node:crypto';
import { capabilities, capabilityForTool, type Capabilities } from './capabilities.js';
import type { AgentConfig, ModelConfig, ProviderConfig, ThinkingLevel } from './config.js';
import { sessionSettings, thinkingLevels } from './config.js';
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
import type { SessionStore } from './session-store.js';
import type { Tool, ToolContext, ToolResult, UiApi } from './tools/types.js';
import type { AcquireWrite } from './write-lease.js';

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

export class Agent {
  capabilities: Capabilities;
  readonly projectInstructions: string | undefined;
  readonly config: AgentConfig;
  readonly store: SessionStore;
  readonly guard: PathGuard;
  readonly hooks: HookRunner;
  readonly autoMode: AutoMode;
  readonly ui: UiApi;
  readonly hasUI: boolean;
  readonly features: Feature[];
  private readonly emitRaw: Emit;
  private readonly tools = new Map<string, Tool>();
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
  private runPrompt = '';
  private compacting: AbortController | null = null;
  private closed = false;
  modelRef: { provider: string; id: string } | null = null;
  thinking: ThinkingLevel = 'medium';
  sessionName: string | null = null;
  nameSource: 'user' | 'auto' | null = null;

  constructor(options: AgentOptions) {
    this.capabilities = capabilities(options.capabilities);
    this.projectInstructions = options.projectInstructions;
    this.config = options.config;
    this.store = options.store;
    this.emitRaw = options.emit;
    this.ui = options.ui;
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
    for (const tool of options.tools) this.tools.set(tool.name, tool);
    for (const feature of this.features)
      for (const tool of feature.tools?.(this) ?? []) this.tools.set(tool.name, tool);
    if (options.allowedTools) {
      const allowed = new Set(options.allowedTools);
      for (const name of [...this.tools.keys()]) if (!allowed.has(name)) this.tools.delete(name);
    }
    this.restoreSettings();
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

  get toolList(): Tool[] {
    return [...this.tools.values()].filter((tool) => this.getTool(tool.name));
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
    const parts = [this.config.systemPrompt, this.extraSystemPrompt, extra];
    parts.push(`Current working directory: ${this.config.workspace}`);
    return parts.filter(Boolean).join('\n\n');
  }

  toolSpecs(): ToolSpec[] {
    return this.toolList.map(({ name, description, parameters }) => ({
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
    const { providerName, provider, model } = this.resolveModel();
    const streamFn = this.streamFunction(provider);
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
      let message: AssistantMessage;
      try {
        message = await streamFn(
          {
            providerName,
            provider,
            model,
            apiKey: provider.apiKey,
            systemPrompt,
            messages: [
              ...sanitizeHistory(this.contextFor(options.upTo)),
              ...(options.extraMessages ?? []),
            ],
            tools: this.toolSpecs(),
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
      message.timestamp = timestamp;
      message.completedAt = Date.now();
      const retry =
        message.stopReason === 'error' &&
        options.retries !== false &&
        attempt < RETRY_DELAYS.length &&
        !signal.aborted &&
        isRetryable(message.errorMessage) &&
        !message.content.some((part) => part.type === 'text' && part.text);
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
    let extraPrompt = '';
    try {
      const hidden: CustomMessage[] = [];
      for (const feature of this.features) {
        const result = await feature.beforeAgentStart?.(this);
        if (result?.systemPrompt) extraPrompt += `\n\n${result.systemPrompt}`;
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
    this.runPrompt = extraPrompt.trim();
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
   * Obtain the write lease for the allowed root containing `file`. Team
   * children's requests arrive here too, so they share this session's lease.
   */
  async acquireWrite(file: string, signal?: AbortSignal): Promise<void> {
    await this.writeLease(this.guard.rootOf(file) ?? file, signal);
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
    };
  }

  /**
   * Execute one tool with hooks. Used by the main loop and by PTC callbacks
   * (`emit:false` keeps nested calls out of the event stream).
   */
  async invokeTool(
    name: string,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    toolCallId: string = randomUUID(),
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const tool = this.getTool(name);
    const capability = capabilityForTool(name);
    if (!tool && capability && this.tools.has(name))
      return {
        content: [
          {
            type: 'text',
            text: `The ${capability} capability is disabled for this project; ${name} is unavailable. Ask the user to enable it in the project settings if needed.`,
          },
        ],
        isError: true,
      };
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    if ('__invalid_json' in rawArgs)
      return {
        content: [
          {
            type: 'text',
            text: `Invalid JSON arguments for ${name}: ${String(rawArgs.__invalid_json).slice(0, 500)}`,
          },
        ],
        isError: true,
      };
    const gate = await this.hooks.beforeTool(name, rawArgs);
    if (gate.blocked)
      return {
        content: [{ type: 'text', text: `Blocked by hook: ${gate.blocked}` }],
        isError: true,
      };
    // Auto mode judges the final (hook-rewritten) arguments and takes the write lease.
    let refusal: string | undefined;
    try {
      refusal = await this.autoMode.gate(name, gate.args, signal);
    } catch (error) {
      return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    }
    if (refusal)
      return {
        content: [{ type: 'text', text: `Blocked by auto mode: ${refusal}` }],
        isError: true,
      };
    let result: ToolResult;
    try {
      result = await tool.execute(gate.args, this.toolContext(toolCallId, signal, onUpdate));
    } catch (error) {
      // The model only sees the message; keep the stack for diagnosis (`runner_stderr`).
      process.stderr.write(
        `tool ${name} threw: ${(error as Error).stack ?? String(error)}\n`.slice(0, 8192),
      );
      result = { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    }
    if (this.config.hooks.afterTool.length) {
      const hookOutput = (
        await this.hooks.run(
          'afterTool',
          {
            tool: name,
            args: gate.args,
            isError: !!result.isError,
            output: result.content
              .filter((part) => part.type === 'text')
              .map((part) => (part as { text: string }).text)
              .join('')
              .slice(0, 65_536),
          },
          name,
        )
      )
        .filter((item) => item.exitCode === 0 && item.stdout.trim())
        .map((item) => item.stdout.trim())
        .join('\n');
      if (hookOutput)
        result = {
          ...result,
          content: [...result.content, { type: 'text', text: `\n[hook]\n${hookOutput}` }],
        };
    }
    return result;
  }

  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
    this.emit({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    let lastUpdate = 0;
    const result = await this.invokeTool(call.name, call.arguments, signal, call.id, (partial) => {
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
