/**
 * The gateway starts work in a node session on its own: a delegation
 * (daemon/delegations.ts) or a scheduled run (daemon/schedules.ts). Both
 * create and name a session on the node, deliver a custom message into it,
 * and read the session back to learn whether it finished or waits for the
 * user.
 */
import type { GatewayDatabase, SessionRow } from '../database.js';
import type { EventHub } from '../events.js';
import { applySessionName } from '../session-name.js';
import type { GatewayEvent, Workspace } from '../types.js';
import type { NodeRegistry } from './nodes.js';

export const TERMINAL_RUNS = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** Events of a followed session after which it may have finished or started waiting. */
const WATCHED_EVENTS = new Set([
  'interaction_created',
  'interaction_answered',
  'runner_exit',
  'runner_error',
  'node_reconnected',
]);

/** An event after which a followed session should be read again. */
export const isWatchedEvent = (event: GatewayEvent): boolean =>
  (event.type === 'pi_event' &&
    (event.data as { type?: unknown } | null)?.type === 'agent_settled') ||
  WATCHED_EVENTS.has(event.type);

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const part = encodeURIComponent;

/** The text of a history message (an agent's answer). */
export function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim();
}

export interface DispatchDeps {
  db: GatewayDatabase;
  events: EventHub;
  nodes: NodeRegistry;
  /** Browsers reload their lists: a session appeared. */
  directoryChanged(): void;
}

/** The workspace's node is connected and still serves it. */
export function workspaceOnline(nodes: NodeRegistry, workspace: Workspace): boolean {
  return !!nodes
    .get(workspace.hostId)
    ?.workspaces.some((item) => `${workspace.hostId}:${item.id}` === workspace.id);
}

/** A node request that must succeed; throws its error message otherwise. */
export async function nodeRequest(
  nodes: NodeRegistry,
  nodeId: string,
  user: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<any> {
  const response = await nodes.request(nodeId, {
    method,
    url,
    user,
    ...(payload === undefined ? {} : { payload }),
  });
  if (response.status >= 400)
    throw new Error(
      (response.body as { error?: { message?: string } } | null)?.error?.message ??
        `${nodeId} answered ${response.status}`,
    );
  return response.body ?? {};
}

/** Create a session for `user` in `workspace` on its node, named `title` (best effort). */
export async function startSession(
  deps: DispatchDeps,
  workspace: Workspace,
  user: string,
  title: string,
): Promise<SessionRow> {
  const { db, events, nodes } = deps;
  const nodeId = workspace.hostId;
  const created = await nodeRequest(nodes, nodeId, user, 'POST', '/api/sessions', {
    workspaceId: workspace.id.slice(nodeId.length + 1),
  });
  const remoteId = String(created.session?.id ?? '');
  if (!remoteId) throw new Error(`${nodeId} did not create a session`);
  const session = db.createSession(
    workspace.id,
    `node://${nodeId}/${remoteId}`,
    nodeId,
    remoteId,
    user,
  );
  try {
    await nodeRequest(nodes, nodeId, user, 'PATCH', `/api/sessions/${part(remoteId)}`, {
      name: title,
    });
    applySessionName(db, events, session.id, session.runnerEpoch, { name: title, source: 'user' });
  } catch {
    /* it keeps its default name */
  }
  deps.directoryChanged();
  return session;
}

export interface DeliveredMessage {
  customType: string;
  content: string;
  details?: Record<string, unknown>;
  /** Switch the session to this model (and thinking level) before it runs. */
  model?: { provider: string; id: string };
  thinking?: string;
}

/** Push a custom message into a node session; it wakes the agent. */
export async function deliver(
  nodes: NodeRegistry,
  session: SessionRow,
  user: string,
  message: DeliveredMessage,
): Promise<void> {
  await nodeRequest(
    nodes,
    session.nodeId!,
    user,
    'POST',
    `/api/sessions/${part(session.piSessionId!)}/deliver`,
    message,
  );
}

export type SessionProgress =
  /** The node is gone or the session unknown: read it again later. */
  | { state: 'unknown' }
  /** The message is still queued behind other work. */
  | { state: 'queued' }
  /** The agent stopped before it took the message. */
  | { state: 'dropped' }
  | { state: 'waiting' }
  | { state: 'working' }
  | {
      state: 'over';
      status: string;
      failureReason: string | null;
      /** The last answer after the message. */
      answer: string;
    };

/**
 * Where a session stands with the custom message `isOurs` picks out, which
 * was delivered at `deliveredAt`.
 */
export async function readProgress(
  nodes: NodeRegistry,
  session: SessionRow,
  user: string,
  deliveredAt: number,
  isOurs: (message: any) => boolean,
): Promise<SessionProgress> {
  if (!session.nodeId || !session.piSessionId || !nodes.get(session.nodeId))
    return { state: 'unknown' };
  const snapshot = await nodeRequest(
    nodes,
    session.nodeId,
    user,
    'GET',
    `/api/sessions/${part(session.piSessionId)}/snapshot`,
  );
  const history: any[] = Array.isArray(snapshot.history) ? snapshot.history : [];
  const run = snapshot.run as {
    status?: unknown;
    createdAt?: unknown;
    failureReason?: unknown;
  } | null;
  const over = !!run && TERMINAL_RUNS.has(String(run.status));
  const taken = history.findLastIndex((message) => message?.role === 'custom' && isOurs(message));
  if (taken === -1)
    return over && Number(run!.createdAt ?? 0) >= deliveredAt
      ? { state: 'dropped' }
      : { state: 'queued' };
  if (Array.isArray(snapshot.interactions) && snapshot.interactions.length)
    return { state: 'waiting' };
  if (!over) return { state: 'working' };
  const answers = history.slice(taken + 1).filter((message) => message?.role === 'assistant');
  return {
    state: 'over',
    status: String(run!.status),
    failureReason: typeof run!.failureReason === 'string' ? run!.failureReason : null,
    answer: textOf(answers[answers.length - 1]),
  };
}
