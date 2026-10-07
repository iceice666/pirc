import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { estimateTokens, type Message, type Usage } from './messages.js';
import type { ToolSpec } from './providers/types.js';

export interface PromptSection {
  id: string;
  title: string;
  source: string;
  frozen?: boolean;
  text: string;
}
export const joinPrompt = (sections: PromptSection[]) =>
  sections
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
/** Preserve the old feature block's outer trim without changing interior whitespace. */
export function trimSections(sections: PromptSection[]): PromptSection[] {
  const result = sections.filter((s) => !!s.text).map((s) => ({ ...s }));
  while (result.length && !result[0]!.text.trim()) result.shift();
  while (result.length && !result.at(-1)!.text.trim()) result.pop();
  if (result.length) {
    result[0]!.text = result[0]!.text.trimStart();
    result.at(-1)!.text = result.at(-1)!.text.trimEnd();
  }
  return result;
}
export interface ContextSnapshot {
  version: 1;
  id: string;
  takenAt: number;
  model: { provider: string; id: string; contextWindow?: number };
  sections: Array<PromptSection & { estimatedTokens: number }>;
  /** The tools the provider sees (`ptc`, `ptc_docs` and the direct core capabilities). */
  tools: Array<ToolSpec & { estimatedTokens: number }>;
  /**
   * Internal capabilities `ptc` scripts may call (no schemas here: the direct
   * core ones appear under `tools`; the others are named in the system prompt
   * and documented by `ptc_docs`). Absent in
   * snapshots from before the PTC-only surface.
   */
  capabilities?: ContextCapability[];
  usage: {
    estimatedInput: number;
    reportedInput?: number;
    scale: number;
    remaining: number | null;
    buckets: { system: number; tools: number; messages: number; memory: number };
  };
}
export interface ContextCapability {
  name: string;
  category: string;
  uiLabel: string;
  effects: string[];
  approval: string;
}
const textTokens = (text: string) => estimateTokens({ role: 'user', content: text, timestamp: 0 });
export function captureContext(input: {
  sections: PromptSection[];
  tools: ToolSpec[];
  messages: Message[];
  model: ContextSnapshot['model'];
  memoryTokens: number;
  capabilities?: ContextCapability[];
}): ContextSnapshot {
  const sections = input.sections.map((section, index) => ({
    ...section,
    estimatedTokens: textTokens(section.text + (index ? '\n\n' : '')),
  }));
  const tools = input.tools.map((tool) => ({
    ...structuredClone(tool),
    estimatedTokens: textTokens(JSON.stringify(tool)),
  }));
  const messageTokens = input.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const summaryTokens = input.messages
    .filter((m) => m.role === 'compactionSummary')
    .reduce((sum, m) => sum + estimateTokens(m), 0);
  const memory = Math.min(Math.max(0, input.memoryTokens), summaryTokens);
  const buckets = {
    system: sections.reduce((sum, s) => sum + s.estimatedTokens, 0),
    tools: tools.reduce((sum, t) => sum + t.estimatedTokens, 0),
    messages: messageTokens - memory,
    memory,
  };
  const estimatedInput = Object.values(buckets).reduce((sum, n) => sum + n, 0);
  return {
    version: 1,
    id: randomUUID(),
    takenAt: Date.now(),
    model: { ...input.model },
    sections,
    tools,
    ...(input.capabilities
      ? { capabilities: input.capabilities.map((item) => ({ ...item })) }
      : {}),
    usage: {
      estimatedInput,
      scale: 1,
      buckets,
      remaining: input.model.contextWindow
        ? Math.max(0, input.model.contextWindow - estimatedInput)
        : null,
    },
  };
}
export function withReportedUsage(snapshot: ContextSnapshot, usage: Usage): ContextSnapshot {
  const reportedInput = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isFinite(reportedInput) || reportedInput <= 0) return snapshot;
  return {
    ...snapshot,
    usage: {
      ...snapshot.usage,
      reportedInput,
      scale: snapshot.usage.estimatedInput ? reportedInput / snapshot.usage.estimatedInput : 1,
      remaining: snapshot.model.contextWindow
        ? Math.max(0, snapshot.model.contextWindow - reportedInput)
        : null,
    },
  };
}
export const CONTEXT_FILE = 'context.json';
export function writeContext(dir: string, snapshot: ContextSnapshot): void {
  const file = path.join(dir, CONTEXT_FILE);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function readContext(dir: string): ContextSnapshot | null {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, CONTEXT_FILE), 'utf8')) as ContextSnapshot;
    if (
      value.version !== 1 ||
      !Array.isArray(value.sections) ||
      !Array.isArray(value.tools) ||
      !value.usage ||
      !value.model
    )
      throw new Error('Invalid context snapshot');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
