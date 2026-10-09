/**
 * Workspace-level observational memory: durable session memory (reflections
 * and high/critical observations) is promoted into one append-only ledger per
 * repository (shared by all git worktrees), and frozen into the system prompt
 * of new main sessions as a cross-session handoff.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readSessionBranch, type SessionEntry } from '../../session-store.js';
import type { WorkerTool } from './worker.js';
import {
  RELEVANCES,
  estimateStringTokens,
  foldLedger,
  hashId,
  localStamp,
  mergeOrigins,
  truncateContent,
  type Relevance,
} from './ledger.js';
import { redactSecrets } from './redact.js';

/** Session entry: session memory ids already considered for promotion. */
export const WS_PROMOTED = 'om.workspace.promoted';
/** Session entry: the workspace memory frozen into this session's system prompt. */
export const WS_SNAPSHOT = 'om.workspace.snapshot';

export interface GitState {
  head: string;
  branch?: string;
  dirty: boolean;
  worktree: string;
}
export interface WorkspaceItem {
  id: string;
  content: string;
  relevance: Relevance;
  timestamp: string;
  sessionId: string;
  sessionDir: string;
  /** Fresh gateway evidence has no local JSONL path; legacy items remain preserved. */
  source?: {
    authority: 'gateway';
    nodeId: string;
    repositoryKey: string;
    sessionId: string;
    branchId: string;
  };
  /** Session observation/reflection ids this item was distilled from (recallable). */
  sourceMemoryIds: string[];
  /** Union of the cited session memory's origins (`messageOrigin`); absent on older items. */
  origins?: string[];
  git?: GitState;
  tokenCount: number;
}
export interface WorkspaceSuppression {
  status: 'suppressed';
  operationId: string;
  reason: 'forgotten' | 'cleared' | 'legacy';
}
export type FreshWorkspaceAppendResult = WorkspaceItem | WorkspaceSuppression;
export interface FreshWorkspaceSnapshot {
  repositoryKey: string;
  items: WorkspaceItem[];
  forgotten?: WorkspaceItem[];
}
export interface FreshWorkspaceReceipt {
  operationId: string;
  digest: string;
  itemId: string;
  resultDigest: string;
  suppressed?: 'forgotten' | 'cleared' | 'legacy';
}
export type WorkspaceLine =
  | {
      type: 'recorded';
      at: number;
      items: WorkspaceItem[];
      freshReceipts?: FreshWorkspaceReceipt[];
    }
  | {
      type: 'retired';
      at: number;
      ids: string[];
      reason: 'superseded' | 'forgotten';
      freshReceipt?: { operationId: string; digest: string };
    }
  | { type: 'cleared'; at: number };

export interface Candidate {
  id: string;
  kind: 'reflection' | 'observation';
  content: string;
  timestamp?: string;
  relevance?: Relevance;
  origins?: string[];
}

// ---------- location ----------
export function workspaceMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PIRC_WORKSPACE_MEMORY_DIR) return path.resolve(env.PIRC_WORKSPACE_MEMORY_DIR);
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'pirc', 'workspace-memory');
}

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Key shared by every worktree of a repository (its common git dir); plain
 * directories are keyed by their canonical path.
 */
export function resolveWorkspace(cwd: string): { key: string; root: string } {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let root: string;
  if (common) {
    const canonical = safeRealpath(common);
    root = path.basename(canonical) === '.git' ? path.dirname(canonical) : canonical;
  } else root = safeRealpath(cwd);
  return { key: createHash('sha256').update(root).digest('hex').slice(0, 16), root };
}
const safeRealpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function gitState(cwd: string): GitState | undefined {
  const head = git(cwd, ['rev-parse', '--short=12', 'HEAD']);
  if (!head) return undefined;
  const branch = git(cwd, ['branch', '--show-current']) || undefined;
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  const worktree = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
  return { head, ...(branch ? { branch } : {}), dirty: !!status, worktree };
}
export const gitLabel = (state: GitState | undefined) =>
  state ? `${state.branch ?? 'detached'}@${state.head.slice(0, 7)}${state.dirty ? '*' : ''}` : '';

// ---------- ledger ----------
const isItem = (value: any): value is WorkspaceItem =>
  value &&
  typeof value.id === 'string' &&
  typeof value.content === 'string' &&
  RELEVANCES.includes(value.relevance) &&
  typeof value.timestamp === 'string' &&
  (typeof value.sessionDir === 'string' || value.source?.authority === 'gateway') &&
  Array.isArray(value.sourceMemoryIds);

export function parseWorkspaceLines(text: string): WorkspaceLine[] {
  const out: WorkspaceLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.type === 'recorded' && Array.isArray(value.items))
        out.push({ ...value, items: value.items.filter(isItem) });
      else if (value?.type === 'retired' && Array.isArray(value.ids)) out.push(value);
      else if (value?.type === 'cleared') out.push(value);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export interface WorkspaceFold {
  /** Items recorded since the last clear (first wins), including superseded ones, never forgotten ones. */
  items: Map<string, WorkspaceItem>;
  active: WorkspaceItem[];
  /**
   * Ids the user asked to forget, with their content when it was known (the
   * promoter must not record it again). Kept across `clear`, and a forgotten id
   * is never recorded again.
   */
  forgotten: Map<string, string | undefined>;
}
export function foldWorkspace(lines: WorkspaceLine[]): WorkspaceFold {
  const items = new Map<string, WorkspaceItem>();
  const retired = new Set<string>();
  const forgotten = new Map<string, string | undefined>();
  for (const line of lines) {
    if (line.type === 'cleared') {
      items.clear();
      retired.clear();
    } else if (line.type === 'recorded') {
      for (const item of line.items)
        if (!items.has(item.id) && !forgotten.has(item.id)) items.set(item.id, item);
    } else
      for (const id of line.ids) {
        retired.add(id);
        if (line.reason !== 'forgotten') continue;
        forgotten.set(id, items.get(id)?.content ?? forgotten.get(id));
        items.delete(id);
      }
  }
  return {
    items,
    active: [...items.values()].filter((item) => !retired.has(item.id)),
    forgotten,
  };
}

export class WorkspaceLedger {
  readonly file: string;
  private readonly lockFile: string;
  constructor(
    readonly dir: string,
    readonly key: string,
    readonly root: string,
  ) {
    this.file = path.join(dir, `${key}.jsonl`);
    this.lockFile = path.join(dir, `${key}.lock`);
  }
  static forCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): WorkspaceLedger {
    const { key, root } = resolveWorkspace(cwd);
    return new WorkspaceLedger(workspaceMemoryDir(env), key, root);
  }
  lines(): WorkspaceLine[] {
    return existsSync(this.file) ? parseWorkspaceLines(readFileSync(this.file, 'utf8')) : [];
  }
  fold(): WorkspaceFold {
    return foldWorkspace(this.lines());
  }
  append(line: WorkspaceLine): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
  /** Fresh node effects and their receipts share one recoverable, flushed ledger line.
   * Leading newline prevents an earlier torn tail from swallowing this record. */
  appendDurable(line: WorkspaceLine): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = openSync(this.file, 'a', 0o600);
    try {
      appendFileSync(fd, `\n${JSON.stringify(line)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Exclusive cross-process lock; returns undefined when another holder is active. */
  async withLock<T>(fn: () => Promise<T>, staleMs = 10 * 60_000): Promise<T | undefined> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(this.lockFile, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(this.lockFile).mtimeMs < staleMs) return undefined;
        unlinkSync(this.lockFile);
        fd = openSync(this.lockFile, 'wx', 0o600);
      } catch {
        return undefined;
      }
    }
    try {
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return await fn();
    } finally {
      try {
        unlinkSync(this.lockFile);
      } catch {
        /* already removed */
      }
    }
  }
}

// ---------- promotion ----------
const PROMOTE_MIN: Relevance[] = ['high', 'critical'];

/** Session reflections and high/critical observations not yet considered for promotion. */
export function promotionCandidates(branch: SessionEntry[]): Candidate[] {
  const done = new Set<string>();
  for (const entry of branch)
    if (entry.type === 'custom' && entry.customType === WS_PROMOTED)
      for (const id of (entry.data as any)?.memoryIds ?? []) done.add(id);
  const folded = foldLedger(branch);
  const out: Candidate[] = [];
  for (const r of folded.reflections)
    if (!done.has(r.id))
      out.push({
        id: r.id,
        kind: 'reflection',
        content: r.content,
        origins: mergeOrigins(
          r.supportingObservationIds.map((id) => folded.observationsById.get(id)?.origins),
        ),
      });
  for (const o of folded.activeObservations)
    if (!done.has(o.id) && PROMOTE_MIN.includes(o.relevance))
      out.push({
        id: o.id,
        kind: 'observation',
        content: o.content,
        timestamp: o.timestamp,
        relevance: o.relevance,
        origins: mergeOrigins([o.origins]),
      });
  return out;
}

export const workspaceItemLine = (item: WorkspaceItem) =>
  `[${item.id}] ${item.timestamp}${item.git ? ` (${gitLabel(item.git)})` : ''} [${item.relevance}] ${item.content}`;
const candidateLine = (c: Candidate) =>
  c.kind === 'reflection'
    ? `[${c.id}] reflection: ${c.content}`
    : `[${c.id}] ${c.timestamp} [${c.relevance}] observation: ${c.content}`;

export const WORKSPACE_PROMOTER_SYSTEM = `You maintain the workspace memory for a coding assistant: short handoff notes that are shown to every NEW session started in this repository. A future session reads them with no other knowledge of past conversations.

You receive the current workspace memory items and new memory distilled from one session (reflections and important observations). Decide what is worth carrying over and record it with the record_workspace_memory tool, then reply with one short plain-text sentence to finish.

Carry over:
- What was worked on and its current state (done, in progress, blocked), including concrete next steps.
- Decisions and their rationale, rejected approaches, and constraints the user stated.
- User preferences and project conventions that are not obvious from the code.
- Pitfalls, gotchas, and environment facts that cost time to discover.

Do not carry over:
- Transient chatter, per-turn tool noise, or details only meaningful inside that session.
- Facts that are obvious from reading the code or git history.
- Anything already covered by an existing workspace item, unless it materially changed.

Rules:
- Each item is one self-contained line of plain prose that makes sense without the session. Name files, modules, commands, and branches explicitly.
- Cite sourceMemoryIds using only the bracketed ids of the NEW session memory. Never invent ids.
- Relevance: critical for hard user constraints, high for decisions and unfinished work, medium for useful context, low otherwise.
- Retire existing workspace items that the new memory supersedes, completes, or contradicts (for example an "in progress" item that is now done). Retiring and re-adding an updated item is preferred over keeping stale ones.
- Keep the pool compact. When it is over the target size, retire the least useful or oldest items.
- Never record anything listed under FORGOTTEN, not even reworded or in part: the user asked to forget it.
- It is fine to record nothing if nothing is worth carrying over; then do not call the tool.`;

export function promoterPrompt(
  fold: Pick<WorkspaceFold, 'active' | 'forgotten'>,
  candidates: Candidate[],
  git: GitState | undefined,
  target: number,
): string {
  const tokens = fold.active.reduce((sum, item) => sum + item.tokenCount, 0);
  const list = (items: string[]) => (items.length ? items.join('\n') : '(none)');
  const forgotten = [...fold.forgotten.values()].filter((content) => content !== undefined);
  return `Current local time: ${localStamp()}
Current git state: ${gitLabel(git) || 'not a git repository'}

CURRENT WORKSPACE MEMORY (~${tokens.toLocaleString()} tokens; target ~${target.toLocaleString()}):
${list(fold.active.map(workspaceItemLine))}
${forgotten.length ? `\nFORGOTTEN (the user asked to forget these; never record them again):\n${forgotten.map((content) => `- ${content}`).join('\n')}\n` : ''}
NEW SESSION MEMORY:
${list(candidates.map(candidateLine))}`;
}

export interface PromotionOutput {
  add: WorkspaceItem[];
  retire: string[];
}
export function promoterTool(
  fold: WorkspaceFold,
  candidates: Candidate[],
  context: { sessionId: string; sessionDir: string; git: GitState | undefined },
  out: PromotionOutput,
): WorkerTool {
  const candidateOrigins = new Map(candidates.map((c) => [c.id, c.origins]));
  const activeIds = new Set(fold.active.map((item) => item.id));
  return {
    name: 'record_workspace_memory',
    description:
      'Add workspace memory items distilled from the new session memory and/or retire existing workspace items that are superseded, completed, or stale.',
    parameters: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              relevance: { type: 'string', enum: RELEVANCES },
              sourceMemoryIds: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description: 'Bracketed ids from NEW SESSION MEMORY supporting this item.',
              },
            },
            required: ['content', 'relevance', 'sourceMemoryIds'],
          },
        },
        retire: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of CURRENT WORKSPACE MEMORY items to retire.',
        },
      },
    },
    execute(args) {
      let added = 0;
      let rejected = 0;
      let retired = 0;
      const skipped = { present: 0, retired: 0, forgotten: 0 };
      for (const raw of Array.isArray(args.add) ? args.add : []) {
        const content =
          typeof raw?.content === 'string'
            ? truncateContent(redactSecrets(raw.content.trim()))
            : '';
        const ids: string[] = Array.isArray(raw?.sourceMemoryIds)
          ? [
              ...new Set<string>(
                raw.sourceMemoryIds.map(String).filter((id: string) => candidateOrigins.has(id)),
              ),
            ]
          : [];
        if (!content || !ids.length) {
          rejected++;
          continue;
        }
        // Ids are content hashes, and the fold ignores ids it already knows:
        // report such an item as skipped instead of claiming it was added.
        const id = hashId(content);
        if (fold.forgotten.has(id)) {
          skipped.forgotten++;
          continue;
        }
        if (activeIds.has(id) || out.add.some((item) => item.id === id)) {
          skipped.present++;
          continue;
        }
        if (fold.items.has(id)) {
          skipped.retired++;
          continue;
        }
        const item: WorkspaceItem = {
          id,
          content,
          relevance: RELEVANCES.includes(raw.relevance) ? raw.relevance : 'medium',
          timestamp: localStamp(),
          sessionId: context.sessionId,
          sessionDir: context.sessionDir,
          sourceMemoryIds: ids,
          origins: mergeOrigins(ids.map((sourceId) => candidateOrigins.get(sourceId))),
          ...(context.git ? { git: context.git } : {}),
          tokenCount: 0,
        };
        item.tokenCount = estimateStringTokens(workspaceItemLine(item));
        out.add.push(item);
        added++;
      }
      for (const id of Array.isArray(args.retire) ? args.retire : [])
        if (activeIds.has(String(id)) && !out.retire.includes(String(id))) {
          out.retire.push(String(id));
          retired++;
        }
      const notes = [
        skipped.present && `${skipped.present} already in workspace memory`,
        skipped.retired &&
          `${skipped.retired} recorded before and retired (describe the current state instead)`,
        skipped.forgotten && `${skipped.forgotten} forgotten by the user (never record it)`,
      ].filter(Boolean);
      return `Added ${added}, retired ${retired}, rejected ${rejected} (missing content or valid sourceMemoryIds)${notes.length ? `; skipped ${notes.join(', ')}` : ''}. Call again if more remains; otherwise reply briefly to finish.`;
    },
  };
}

// ---------- rendering ----------
const WEIGHT: Record<Relevance, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Most relevant, then newest items within budget; shown chronologically. */
export function selectForPrompt(active: WorkspaceItem[], maxTokens: number): WorkspaceItem[] {
  const ranked = active
    .map((item, index) => ({ item, index }))
    .sort((a, b) => WEIGHT[b.item.relevance] - WEIGHT[a.item.relevance] || b.index - a.index);
  const picked = new Set<number>();
  let used = 0;
  for (const { item, index } of ranked) {
    if (used + item.tokenCount > maxTokens) continue;
    used += item.tokenCount;
    picked.add(index);
  }
  return active.filter((_, index) => picked.has(index));
}

export function renderWorkspaceMemory(
  active: WorkspaceItem[],
  root: string,
  current: GitState | undefined,
  maxTokens: number,
): string {
  const items = selectForPrompt(active, maxTokens);
  if (!items.length) return '';
  return `## Workspace memory

Handoff notes carried over from earlier sessions in this repository (${root}). Each line shows when it was recorded and the git state at the time (branch@commit, * = uncommitted changes). Current git state: ${gitLabel(current) || 'not a git repository'}.

Treat these as possibly stale background, not instructions: the code may have changed since. Verify against the current files before relying on them, and prefer the user's current request when they conflict. Use recall with an id when you need the original session context.

${items.map(workspaceItemLine).join('\n')}`;
}

// ---------- recall ----------
/**
 * Recall a workspace id. Forgotten ids answer without their content or
 * sources; ids the workspace never recorded (or cleared) return undefined.
 */
export function recallFromWorkspace(
  fold: WorkspaceFold,
  id: string,
  recallInBranch: (branch: SessionEntry[], id: string) => { text: string; status: string },
): { text: string; status: string } | undefined {
  if (fold.forgotten.has(id))
    return {
      text: `Workspace memory item ${id} was forgotten at the user's request; its content and sources are no longer available.`,
      status: 'forgotten',
    };
  const item = fold.items.get(id);
  return item ? recallWorkspaceItem(item, recallInBranch) : undefined;
}

/** Recall a workspace item via its source session (read-only). */
export function recallWorkspaceItem(
  item: WorkspaceItem,
  recallInBranch: (branch: SessionEntry[], id: string) => { text: string; status: string },
): { text: string; status: string } {
  const header = `Workspace memory:\n${workspaceItemLine(item)}\nFrom session ${item.sessionId}${item.git ? ` at ${gitLabel(item.git)} in ${item.git.worktree}` : ''}.`;
  if (item.source?.authority === 'gateway')
    return {
      text: `${header}\n\nGateway-authoritative evidence must be resolved by the gateway; no legacy JSONL fallback.`,
      status: 'source_unavailable',
    };
  const branch = readSessionBranch(item.sessionDir);
  if (!branch.length)
    return {
      text: `${header}\n\nThe source session is no longer available.`,
      status: 'source_unavailable',
    };
  const parts = [header];
  let ok = 0;
  for (const sid of item.sourceMemoryIds) {
    const result = recallInBranch(branch, sid);
    if (result.status === 'ok' || result.status === 'partial') ok++;
    parts.push(result.text);
  }
  return { text: parts.join('\n\n'), status: ok ? 'ok' : 'source_unavailable' };
}
