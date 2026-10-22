/**
 * Session lists: the sidebar's rows under each workspace, and the workspace
 * pages. Pure functions, shared by the components and tests.
 */
import type { SessionSummary } from './types';

/** A run is open and working (waiting for an answer is "Needs you" instead). */
export const isRunning = (session: SessionSummary) =>
  session.runStatus === 'running' ||
  session.runStatus === 'queued' ||
  session.runStatus === 'stopping';

export const needsInput = (session: SessionSummary) => session.runStatus === 'waiting_input';

/**
 * The sessions the sidebar lists under a workspace row: the unread
 * ones, and the open one so you can see where you are. The page lists the rest.
 * `skipWaiting`: Work's "Needs you" already lists sessions waiting for an answer.
 */
export function sidebarSessions(
  sessions: SessionSummary[],
  workspaceId: string,
  activeId: string | undefined,
  skipWaiting = false,
): SessionSummary[] {
  return sessions.filter(
    (session) =>
      session.workspaceId === workspaceId &&
      (session.id === activeId || (session.unread && !(skipWaiting && needsInput(session)))),
  );
}
