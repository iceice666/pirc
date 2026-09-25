import type { AgentConfig } from '../config.js';
import type { ImageContent, TextContent } from '../messages.js';
import type { PathGuard } from '../sandbox.js';

export interface ToolResult {
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
}

export interface DialogOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
  /** Stream partial output to observers (`tool_execution_update`). */
  update(partial: ToolResult): void;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Tool can be called from PTC code (`tools.<name>(args)`). */
  ptc?: boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export const text = (value: string, details?: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(details === undefined ? {} : { details }),
  ...(isError ? { isError: true } : {}),
});

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
