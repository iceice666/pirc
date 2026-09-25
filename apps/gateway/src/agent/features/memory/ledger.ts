/**
 * Observational-memory ledger (port of the Pi extension's V3 ledger).
 * Append-only custom entries; folding and projections are pure functions of
 * the session branch.
 */
import { createHash } from 'node:crypto';
import { estimateTokens, type Message } from '../../messages.js';
import type { SessionEntry } from '../../session-store.js';

export type Relevance = 'low' | 'medium' | 'high' | 'critical';
export const RELEVANCES: Relevance[] = ['low', 'medium', 'high', 'critical'];
export interface Observation {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
}
export interface Reflection {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}
export const OBS_RECORDED = 'om.observations.recorded';
export const REF_RECORDED = 'om.reflections.recorded';
export const OBS_DROPPED = 'om.observations.dropped';
export type LedgerType = typeof OBS_RECORDED | typeof REF_RECORDED | typeof OBS_DROPPED;
export interface FoldedDetails {
  type: 'om.folded';
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}

export const ID_PATTERN = /^[a-f0-9]{12}$/;
const MAX_CONTENT = 10_000;

export function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT) return content;
  const marker = ` … [truncated ${content.length - MAX_CONTENT} chars]`;
  return content.slice(0, MAX_CONTENT - marker.length) + marker;
}
export const hashId = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12);
export const estimateStringTokens = (text: string) => Math.ceil(text.length / 4);

export const observationLine = (o: Observation) =>
  `[${o.id}] ${o.timestamp} [${o.relevance}] ${o.content}`;
export const reflectionLine = (r: Reflection) => `[${r.id}] ${r.content}`;
export const observationTokens = (o: Observation) => estimateStringTokens(observationLine(o));

export function localStamp(time: number | Date = Date.now()): string {
  const date = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(date.getTime())) return '????-??-?? ??:??';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- validation ----------
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
export function isObservation(value: any): value is Observation {
  return (
    value &&
    typeof value.id === 'string' &&
    ID_PATTERN.test(value.id) &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'string' &&
    RELEVANCES.includes(value.relevance) &&
    strings(value.sourceEntryIds) &&
    typeof value.tokenCount === 'number'
  );
}
export function isReflection(value: any): value is Reflection {
  return (
    value &&
    typeof value.id === 'string' &&
    ID_PATTERN.test(value.id) &&
    typeof value.content === 'string' &&
    !/[\r\n]/.test(value.content) &&
    strings(value.supportingObservationIds) &&
    typeof value.tokenCount === 'number'
  );
}
type Custom = Extract<SessionEntry, { type: 'custom' }>;
function ledgerData(entry: SessionEntry): { type: LedgerType; data: any } | undefined {
  if (entry.type !== 'custom') return undefined;
  const data = (entry as Custom).data as any;
  if (!data || typeof data.coversUpToId !== 'string') return undefined;
  switch (entry.customType) {
    case OBS_RECORDED:
      return Array.isArray(data.observations) &&
        data.observations.length &&
        data.observations.every(isObservation)
        ? { type: OBS_RECORDED, data }
        : undefined;
    case REF_RECORDED:
      return Array.isArray(data.reflections) &&
        data.reflections.length &&
        data.reflections.every(isReflection)
        ? { type: REF_RECORDED, data }
        : undefined;
    case OBS_DROPPED:
      return strings(data.observationIds) ? { type: OBS_DROPPED, data } : undefined;
  }
  return undefined;
}
export function isFoldedDetails(value: any): value is FoldedDetails {
  return (
    value?.type === 'om.folded' &&
    value.version === 1 &&
    typeof value.fullFold === 'boolean' &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    Array.isArray(value.reflections) &&
    value.reflections.every(isReflection)
  );
}

// ---------- source entries & coverage ----------
export const isSource = (
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: 'message' }> => entry.type === 'message';
export function entryTokens(entry: SessionEntry): number {
  return isSource(entry) ? estimateTokens(entry.message as Message) : 0;
}
export function latestCoverageIndex(branch: SessionEntry[], type: LedgerType): number {
  const index = new Map(branch.map((entry, i) => [entry.id, i]));
  let best = -1;
  for (const entry of branch) {
    const ledger = ledgerData(entry);
    if (ledger?.type !== type) continue;
    const at = index.get(ledger.data.coversUpToId);
    if (at !== undefined && at > best) best = at;
  }
  return best;
}
export function latestCoverageId(branch: SessionEntry[], type: LedgerType): string | undefined {
  const index = latestCoverageIndex(branch, type);
  return index >= 0 ? branch[index]!.id : undefined;
}

// ---------- fold ----------
export interface Folded {
  observations: Observation[];
  activeObservations: Observation[];
  dropped: Set<string>;
  reflections: Reflection[];
  observationsById: Map<string, Observation>;
}
function collect(entries: Iterable<{ type: LedgerType; data: any }>): Folded {
  const observationsById = new Map<string, Observation>();
  const reflectionsById = new Map<string, Reflection>();
  const dropped = new Set<string>();
  for (const { type, data } of entries) {
    if (type === OBS_RECORDED)
      for (const o of data.observations as Observation[])
        if (!observationsById.has(o.id)) observationsById.set(o.id, o);
    if (type === REF_RECORDED)
      for (const r of data.reflections as Reflection[])
        if (!reflectionsById.has(r.id)) reflectionsById.set(r.id, r);
    if (type === OBS_DROPPED) for (const id of data.observationIds as string[]) dropped.add(id);
  }
  const observations = [...observationsById.values()];
  return {
    observations,
    activeObservations: observations.filter((o) => !dropped.has(o.id)),
    dropped,
    reflections: [...reflectionsById.values()],
    observationsById,
  };
}
export function foldLedger(branch: SessionEntry[]): Folded {
  return collect(branch.map(ledgerData).filter((item) => item !== undefined));
}

// ---------- projections ----------
type Boundary = number;
export const entryBoundary = (branch: SessionEntry[], id: string | undefined): Boundary =>
  id ? branch.findIndex((entry) => entry.id === id) : -1;
export function foldProjection(
  branch: SessionEntry[],
  bounds: { observations: Boundary; reflections: Boundary; drops: Boundary },
): { observations: Observation[]; reflections: Reflection[] } {
  const index = new Map(branch.map((entry, i) => [entry.id, i]));
  const selected = branch
    .map(ledgerData)
    .filter((item) => item !== undefined)
    .filter((item) => {
      const at = index.get(item.data.coversUpToId);
      if (at === undefined) return false;
      const limit =
        item.type === OBS_RECORDED
          ? bounds.observations
          : item.type === REF_RECORDED
            ? bounds.reflections
            : bounds.drops;
      return at <= limit;
    });
  const folded = collect(selected);
  return { observations: folded.activeObservations, reflections: folded.reflections };
}
export function fullProjection(branch: SessionEntry[], upTo?: string) {
  const bound = upTo ? entryBoundary(branch, upTo) : branch.length - 1;
  return foldProjection(branch, { observations: bound, reflections: bound, drops: bound });
}
function latestFullFoldBoundaryId(branch: SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'compaction' || !isFoldedDetails(entry.details) || !entry.details.fullFold)
      continue;
    if (branch.some((item) => item.id === entry.firstKeptEntryId)) return entry.firstKeptEntryId;
  }
  return undefined;
}
/**
 * Observations are current up to the cut; reflections/drops stay frozen at
 * the last full fold so the summary prefix is stable (prompt cache) until the
 * visible pool crosses `poolMax`.
 */
export function buildCompactionProjection(
  branch: SessionEntry[],
  firstKeptEntryId: string,
  poolMax: number,
): FoldedDetails {
  const cut = entryBoundary(branch, firstKeptEntryId);
  const maint = entryBoundary(branch, latestFullFoldBoundaryId(branch));
  const normal = foldProjection(branch, { observations: cut, reflections: maint, drops: maint });
  const fullFold = normal.observations.reduce((sum, o) => sum + o.tokenCount, 0) >= poolMax;
  const projection = fullFold ? fullProjection(branch, firstKeptEntryId) : normal;
  return { type: 'om.folded', version: 1, fullFold, ...projection };
}
export function visibleProjection(branch: SessionEntry[]): {
  observations: Observation[];
  reflections: Reflection[];
} {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === 'compaction' && isFoldedDetails(entry.details)) return entry.details;
  }
  return { observations: [], reflections: [] };
}

export const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
  if (!reflections.length && !observations.length) return '';
  let out = CONTEXT_USAGE_INSTRUCTIONS;
  if (reflections.length)
    out += `\n\n## Reflections\n${reflections.map(reflectionLine).join('\n')}`;
  if (observations.length)
    out += `\n\n## Observations\n${observations.map(observationLine).join('\n')}`;
  return out;
}

// ---------- token clocks ----------
function assistantUsage(entry: SessionEntry): number | undefined {
  if (!isSource(entry) || entry.message.role !== 'assistant') return undefined;
  const message = entry.message;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined;
  const u = message.usage;
  if (u.totalTokens > 0) return u.totalTokens;
  const sum = u.input + u.output + u.cacheRead + u.cacheWrite;
  return sum > 0 ? sum : undefined;
}
export function rawTokensSinceCoverage(branch: SessionEntry[], type: LedgerType): number {
  const from = latestCoverageIndex(branch, type) + 1;
  return branch.slice(from).reduce((sum, entry) => sum + entryTokens(entry), 0);
}
export function tokensSinceCoverage(
  branch: SessionEntry[],
  type: LedgerType,
  current: number | undefined,
): number {
  const raw = rawTokensSinceCoverage(branch, type);
  if (current === undefined || !Number.isFinite(current)) return raw;
  const cov = latestCoverageIndex(branch, type);
  let cmp = -1;
  for (let i = branch.length - 1; i >= 0; i--)
    if (branch[i]!.type === 'compaction') {
      cmp = i;
      break;
    }
  let baseline: number | undefined;
  if (cmp > cov) {
    for (const entry of branch.slice(cmp + 1)) {
      baseline = assistantUsage(entry);
      if (baseline !== undefined) break;
    }
  } else if (cov >= 0) {
    for (let i = cov; i >= 0; i--) {
      baseline = assistantUsage(branch[i]!);
      if (baseline !== undefined) break;
    }
  } else return Math.max(0, current);
  if (baseline === undefined || current - baseline < 0) return raw;
  return current - baseline;
}
export function rawTokensSinceLastCompaction(branch: SessionEntry[]): number {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'compaction') continue;
    const kept = branch.findIndex((item) => item.id === entry.firstKeptEntryId);
    start = kept === -1 ? i + 1 : kept;
    break;
  }
  return branch.slice(start).reduce((sum, entry) => sum + entryTokens(entry), 0);
}
