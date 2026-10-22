import { describe, expect, it } from 'vitest';
import type { SessionSummary } from './types';
import { sidebarSessions } from './work';

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId: 'n:ws',
  name: id,
  lastActivityAt: '2026-09-29T00:00:00Z',
  runnerStatus: 'ready',
  ...extra,
});
describe('sidebarSessions', () => {
  const sessions = [
    session('read'),
    session('new', { unread: true }),
    session('wait', { unread: true, runStatus: 'waiting_input' }),
    session('open'),
    session('late', { unread: true }),
    session('other', { workspaceId: 'n:other', unread: true }),
  ];
  const ids = (list: SessionSummary[]) => list.map((item) => item.id);

  it('lists the unread sessions of one workspace and the open one, in the gateway’s order', () => {
    expect(ids(sidebarSessions(sessions, 'n:ws', 'open'))).toEqual(['new', 'wait', 'open', 'late']);
  });

  it('can leave sessions waiting for an answer to "Needs you"', () => {
    expect(ids(sidebarSessions(sessions, 'n:ws', undefined, true))).toEqual(['new', 'late']);
  });
});
