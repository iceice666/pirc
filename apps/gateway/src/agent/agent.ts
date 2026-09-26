import { randomUUID } from 'node:crypto';
import type { AgentConfig, ModelConfig, ProviderConfig, ThinkingLevel } from './config.js';
import { thinkingLevels } from './config.js';
import { listModels } from '../models.js';
import {
  contextTokens,
  defaultCompaction,
  isContextOverflow,
  runCompaction,
  type CompactionSettings,
} from './compaction.js';
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

export class Agent {
  readonly config: AgentConfig;
  readonly store: SessionStore;
  readonly guard: PathGuard;
  readonly hooks: HookRunner;
  readonly ui: UiApi;
  readonly hasUI: boolean;
  readonly features: Feature[];
  private readonly emitRaw: Emit;
  private readonly tools = new Map<string, Tool>();
  private readonly streamOverride: StreamFn | undefined;
  private readonly toolEnv: Record<string, string>;
  private steering: QueueItem[] = [];
  private followUps: QueueItem[] = [];
  private running = false;
  private controller: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private extraSystemPrompt = '';
  private compacting: AbortController | null = null;
  private closed = false;
  modelRef: { provider: string; id: string } | null = null;
  thinking: ThinkingLevel = 'medium';
  sessionName: string | null = null;
  nameSource: 'user' | 'auto' | null = null;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.store = options.store;
    this.emitRaw = options.emit;
    this.ui = options.ui;
    this.hasUI = options.hasUI;
    this.features = options.features ?? [];
    this.streamOverride = options.streamOverride;
    this.toolEnv = options.toolEnv ?? {};
    this.guard = new PathGuard(
      options.config.workspace,
      options.config.allowedPaths,
      options.config.protectedPaths,
    );
    this.hooks = new HookRunner(
      options.config.hooks,
      options.config.workspace,
      options.config.env,
      { sessionId: options.store.sessionId, cwd: options.config.workspace },
      (message) => this.ui.notify(message, 'warning'),
    );
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
    const model = this.store.latest('model_change');
    const thinking = this.store.latest('thinking_level_change');
    const info = this.store.latest('session_info');
    const fallback = this.config.defaultModel;
    if (model) this.modelRef = { provider: model.provider, id: model.modelId };
    else if (fallback) this.modelRef = { provider: fallback.provider, id: fallback.id };
    else {
      const [name, provider] = Object.entries(this.config.providers)[0] ?? [];
      if (name && provider) this.modelRef = { provider: name, id: provider.models[0]!.id };
    }
    const level = thinking?.thinkingLevel ?? fallback?.thinking;
    if (level && (thinkingLevels as readonly string[]).includes(level))
      this.thinking = level as ThinkingLevel;
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

  get toolList(): Tool[] {
    return [...this.tools.values()];
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
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
    this.steering = [];
    this.followUps = [];
    this.emitQueue();
    return cleared;
  }

  /** Run `/name args` if a feature registered it. Returns true when handled. */
  private tryCommand(text: string): boolean {
    const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
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
    this.emitQueue();
  }

  followUp(text: string, images?: ImageContent[]): void {
    if (this.tryCommand(text)) return;
    this.userInput(text);
    const item: QueueItem = { kind: 'user', text, ...(images?.length ? { images } : {}) };
    if (!this.running) return this.startRun([item]);
    this.followUps.push(item);
    this.emitQueue();
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
      return;
    }
    if (options.triggerTurn) this.startRun([item]);
    else this.appendMessage(message);
  }

  abort(): void {
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
      .catch((error) => this.ui.notify(`Agent loop crashed: ${(error as Error).message}`, 'error'))
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

  systemPrompt(extra = ''): string {
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

  /** Provider stream function (tests may override all providers). */
  streamFunction(provider: ProviderConfig): StreamFn {
    return this.streamOverride ?? streamFor(provider);
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
    let turns = 0;
    let overflowRetried = false;
    while (!signal.aborted) {
      if (++turns > this.config.limits.maxTurns) {
        this.ui.notify(`Stopped after ${this.config.limits.maxTurns} turns`, 'warning');
        break;
      }
      await this.maybeCompact(signal);
      if (signal.aborted) break;
      this.emit({ type: 'turn_start' });
      const compactsInstead = (reply: AssistantMessage) =>
        isContextOverflow(reply) && !overflowRetried && this.compactionSettings.enabled;
      let persisted = false;
      const message = await this.stream(this.systemPrompt(extraPrompt.trim()), signal, {
        beforeEnd: (reply) => {
          if (compactsInstead(reply)) return;
          this.store.append({ type: 'message', message: reply });
          persisted = true;
        },
      });
      if (!persisted && compactsInstead(message)) {
        // Drop the failed reply, compact everything, and retry the turn once.
        overflowRetried = true;
        this.emit({ type: 'turn_end', message, toolResults: [] });
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
          if (signal.aborted || this.steering.length) {
            results.push(
              this.recordResult(call, {
                content: [
                  {
                    type: 'text',
                    text: signal.aborted
                      ? 'Aborted by the user before this tool ran.'
                      : 'Skipped: the user sent a new message before this tool ran.',
                  },
                ],
                isError: true,
              }),
            );
            continue;
          }
          results.push(await this.executeTool(call, signal));
        }
      }
      this.emit({ type: 'turn_end', message, toolResults: results });
      for (const feature of this.features) await feature.turnEnd?.(this, message);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') break;
      if (this.steering.length) {
        const items = this.steering;
        this.steering = [];
        this.emitQueue();
        await this.admit(items);
        continue;
      }
      if (message.stopReason === 'toolUse') continue;
      if (!this.followUps.length)
        for (const feature of this.features) await feature.agentEnd?.(this, produced);
      if (this.steering.length || this.followUps.length) {
        const items = [...this.steering, ...this.followUps.splice(0, 1)];
        this.steering = [];
        this.emitQueue();
        await this.admit(items);
        continue;
      }
      break;
    }
    this.emit({ type: 'agent_end', messages: produced, willRetry: false });
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
    return message;
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
    const tool = this.tools.get(name);
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
    let result: ToolResult;
    try {
      result = await tool.execute(gate.args, this.toolContext(toolCallId, signal, onUpdate));
    } catch (error) {
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
