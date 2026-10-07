import type { AgentConfig } from '../config.js';
import type { ImageContent, TextContent } from '../messages.js';
import type { PathGuard } from '../sandbox.js';

export interface ToolResult {
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
  /**
   * Typed fields for `ptc` scripts, described by the tool's `resultSchema`
   * (plans/ptc-m1-contracts.md "SDK v1"). The script receives them next to
   * `text`, the output above; never shown to the model or stored by itself.
   */
  data?: Record<string, unknown>;
}

export interface DialogOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The `ptc` operation this dialog belongs to, so clients can show it there. */
  toolCallId?: string;
}

export interface UiApi {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  /**
   * Rich choice dialog (web client renders descriptions and multi-select).
   * Returns selected labels, or undefined when cancelled.
   */
  choose(
    title: string,
    options: Array<{ label: string; description?: string }>,
    multiple: boolean,
    opts?: DialogOptions,
  ): Promise<string[] | undefined>;
  confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean | undefined>;
  input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptions): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, text?: string): void;
  setWidget(key: string, lines?: string[]): void;
}

export interface ToolContext {
  cwd: string;
  config: AgentConfig;
  guard: PathGuard;
  signal: AbortSignal;
  toolCallId: string;
  ui: UiApi;
  /** Whether a human can answer dialogs (false for headless team workers). */
  hasUI: boolean;
  env: Record<string, string>;
  /**
   * Obtain the node's write lease for the workspace root containing `file`
   * (an absolute path from `guard.resolve(…, 'write')`). Throws when another
   * session is writing there. Call right before modifying the file.
   */
  acquireWrite(file: string): Promise<void>;
  /** Stream partial output to observers (`tool_execution_update`). */
  update(partial: ToolResult): void;
  /**
   * Wait for something only a human can settle (an approval asked by the
   * node, a browser handoff): a `ptc` script's active-time budget pauses
   * meanwhile. Dialogs through `ui` count already.
   */
  humanWait<T>(work: Promise<T>): Promise<T>;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Tool can be called from PTC code (`tools.<name>(args)`). */
  ptc?: boolean;
  /**
   * JSON schema of the typed `data` fields a result carries besides `text`
   * (an object schema; `oneOf` for action-dependent results). Every
   * capability declares one; `ptc` checks results against it.
   */
  resultSchema?: Record<string, unknown>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export const text = (value: string, details?: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(details === undefined ? {} : { details }),
  ...(isError ? { isError: true } : {}),
});

/** `text(…)` with typed `data` for `ptc` scripts. */
export const typed = (
  value: string,
  data: Record<string, unknown>,
  options: { details?: unknown; isError?: boolean } = {},
): ToolResult => ({ ...text(value, options.details, options.isError), data });

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${key} must be a number`);
  return value;
}
