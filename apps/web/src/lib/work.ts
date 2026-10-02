/**
 * Session lists: the sidebar's rows under each project and workspace, and the
 * project and workspace pages, where repeated runs of one schedule fold into
 * one row. Pure functions, shared by the components and tests.
 */
import type { ConversationMessage, SessionSummary, ToolCall } from './types';

/** A run is open and working (waiting for an answer is "Needs you" instead). */
export const isRunning = (session: SessionSummary) =>
  session.runStatus === 'running' ||
  session.runStatus === 'queued' ||
  session.runStatus === 'stopping';

export const needsInput = (session: SessionSummary) => session.runStatus === 'waiting_input';

export type RecentRow =
  | { kind: 'session'; session: SessionSummary }
  | {
      kind: 'schedule';
      scheduleId: string;
      title: string;
      /** Newest first. */
      sessions: SessionSummary[];
    };

/**
 * Sessions in list order (pinned first, then by activity), with every session
 * a schedule started folded into one row where its newest run appears.
 */
export function foldRecent(sessions: SessionSummary[]): RecentRow[] {
  const rows: RecentRow[] = [];
  const folds = new Map<string, Extract<RecentRow, { kind: 'schedule' }>>();
  for (const session of sessions) {
    const origin = session.origin;
    if (origin?.kind !== 'schedule' || session.pinned) {
      rows.push({ kind: 'session', session });
      continue;
    }
    const fold = folds.get(origin.scheduleId);
    if (fold) fold.sessions.push(session);
    else {
      const row = {
        kind: 'schedule' as const,
        scheduleId: origin.scheduleId,
        title: origin.title,
        sessions: [session],
      };
      folds.set(origin.scheduleId, row);
      rows.push(row);
    }
  }
  // A schedule with a single run reads better as the session itself.
  return rows.map((row) =>
    row.kind === 'schedule' && row.sessions.length === 1
      ? { kind: 'session', session: row.sessions[0]! }
      : row,
  );
}

/** Pinned first, keeping the gateway's order (by activity) otherwise. */
export function pinnedFirst(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions.filter((item) => item.pinned), ...sessions.filter((item) => !item.pinned)];
}

/**
 * The sessions the sidebar lists under a project or workspace row: the unread
 * ones, and the open one so you can see where you are. The page lists the rest.
 * `skipWaiting`: Work's "Needs you" already lists sessions waiting for an answer.
 */
export function sidebarSessions(
  sessions: SessionSummary[],
  workspaceId: string,
  activeId: string | undefined,
  skipWaiting = false,
): SessionSummary[] {
  return pinnedFirst(
    sessions.filter(
      (session) =>
        session.workspaceId === workspaceId &&
        (session.id === activeId || (session.unread && !(skipWaiting && needsInput(session)))),
    ),
  );
}

/** A write refused because another session holds the lease (node/runner.ts `grantWrite`). */
export interface WriteBlock {
  path: string;
  holderName: string;
}

const WRITE_BLOCKED =
  /(\S+) is being written by session "(.+?)" \([^)]*\); wait until its run finishes/;

export function writeBlock(tool: Pick<ToolCall, 'status' | 'output'>): WriteBlock | undefined {
  if (tool.status !== 'failed' || !tool.output) return undefined;
  const match = WRITE_BLOCKED.exec(tool.output);
  return match ? { path: match[1]!, holderName: match[2]! } : undefined;
}

/** The session named in a refusal: one holding a lease now, else any of that name. */
export function blockingSession(
  sessions: SessionSummary[],
  name: string,
): SessionSummary | undefined {
  return (
    sessions.find((session) => session.writeLease && session.name === name) ??
    sessions.find((session) => session.name === name)
  );
}

/** An assistant turn that only called tools: no text, error or images. */
export const toolsOnly = (message: ConversationMessage) =>
  message.role === 'assistant' &&
  !message.content &&
  !message.stopReason &&
  !message.errorMessage &&
  !message.images?.length &&
  !!message.tools?.length;

export type TimelineItem =
  | { kind: 'message'; message: ConversationMessage }
  /** Consecutive tool-only assistant turns, shown as one run card. */
  | { kind: 'run'; id: string; messages: ConversationMessage[] };

/** Group consecutive tool-only turns (two or more) into run cards. */
export function timelineItems(messages: ConversationMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: ConversationMessage[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ kind: 'run', id: `run:${run[0]!.id}`, messages: run });
    else if (run.length) items.push({ kind: 'message', message: run[0]! });
    run = [];
  };
  for (const message of messages) {
    if (toolsOnly(message)) run.push(message);
    else {
      flush();
      items.push({ kind: 'message', message });
    }
  }
  flush();
  return items;
}

export interface RunSummary {
  count: number;
  status: 'running' | 'failed' | 'succeeded';
  /** Milliseconds from the first start to the last end, when known. */
  durationMs: number | undefined;
  /** File names the tools read or changed, in order, without repeats. */
  files: string[];
}

const FILE_TOOLS = new Set(['read', 'edit', 'write']);

export function summarizeRun(tools: ToolCall[]): RunSummary {
  const status = tools.some((tool) => tool.status === 'failed')
    ? 'failed'
    : tools.some((tool) => tool.status === 'running')
      ? 'running'
      : 'succeeded';
  const starts = tools.map((tool) => Date.parse(tool.startedAt ?? '')).filter(Number.isFinite);
  const ends = tools.map((tool) => Date.parse(tool.endedAt ?? '')).filter(Number.isFinite);
  const durationMs =
    starts.length && ends.length && status !== 'running'
      ? Math.max(0, Math.max(...ends) - Math.min(...starts))
      : undefined;
  const files: string[] = [];
  for (const tool of tools) {
    const path = (tool.input as { path?: unknown } | undefined)?.path;
    if (!FILE_TOOLS.has(tool.name) || typeof path !== 'string' || !path) continue;
    const parts = path.split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? path;
    if (!files.includes(name)) files.push(name);
  }
  return { count: tools.length, status, durationMs, files };
}
