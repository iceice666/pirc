import type { Agent } from './agent.js';
import type { AssistantMessage, CustomMessage, Message } from './messages.js';
import type { Tool } from './tools/types.js';

/**
 * Coding-session features a chat leaves out (plans/assistant.md): their tools
 * cost context a personal assistant rarely needs, and chats hand real work to
 * a workspace with `delegate`. `features.<key>.enabled: true` in the node's
 * config brings one back.
 */
export function offInChat(agent: Agent, key: string): boolean {
  if (agent.config.workspaceKind !== 'chat') return false;
  const settings = agent.config.features[key] as { enabled?: unknown } | undefined;
  return settings?.enabled !== true;
}

export interface CompactionPlan {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

/**
 * Built-in extension. Features are compiled into the binary; this is the
 * small hook surface they need.
 */
export interface Feature {
  name: string;
  tools?(agent: Agent): Tool[];
  /** Slash commands (`/name args`), executed immediately instead of being sent to the model. */
  commands?: Record<
    string,
    { description: string; run(agent: Agent, args: string): Promise<void> }
  >;
  /** A human (not an extension) submitted input (slash commands excluded). */
  userInput?(agent: Agent, text: string): void;
  /** Called once after the session is loaded. */
  init?(agent: Agent): void | Promise<void>;
  /** Before each run: extend the system prompt or inject hidden context. */
  beforeAgentStart?(
    agent: Agent,
  ): Promise<{ systemPrompt?: string; messages?: CustomMessage[] } | void>;
  turnEnd?(agent: Agent, message: AssistantMessage): void | Promise<void>;
  /** Messages actually admitted to model history (not merely queued). */
  messageAdmitted?(agent: Agent, message: Message): void;
  /** Required background work that prevents a clean end. Empty means no runtime blocker. */
  completionBlockers?(agent: Agent): string[];
  /** Queued custom messages removed by clear_queue; features may retain them for later. */
  notificationsCleared?(agent: Agent, messages: CustomMessage[]): void;
  /** Explicit cancellation; late feature events must not immediately restart the run. */
  abort?(agent: Agent): void;
  /** Run loop is about to stop; may queue follow-ups to continue it. */
  agentEnd?(agent: Agent, messages: Message[]): void | Promise<void>;
  /**
   * The feature will start another run once idle (e.g. an active goal), so
   * end-of-run nudges such as the todo reminder can leave it to that run.
   */
  willContinue?(agent: Agent): boolean;
  /** Fully idle (after agent_end); may queue steer messages to wake the agent. */
  agentSettled?(agent: Agent): void | Promise<void>;
  /** Return a custom compaction, or undefined to fall back to the default summarizer. */
  beforeCompact?(
    agent: Agent,
    context: { firstKeptEntryId: string; tokensBefore: number; signal: AbortSignal },
  ): Promise<CompactionPlan | { cancel: true } | undefined>;
  afterCompact?(agent: Agent): void | Promise<void>;
  shutdown?(agent: Agent): void | Promise<void>;
  /**
   * Structured state for the web side panel (`get_panel_state`), merged across
   * features. Call `agent.panelChanged(section)` when it changes.
   */
  panel?(agent: Agent): Record<string, unknown>;
  /** Extra JSONL RPC commands, by `type`. */
  rpc?: Record<string, (agent: Agent, command: Record<string, any>) => Promise<unknown>>;
}
