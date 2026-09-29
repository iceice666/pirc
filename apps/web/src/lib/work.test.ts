import { describe, expect, it } from 'vitest';
import type { ConversationMessage, SessionSummary, ToolCall } from './types';
import {
  blockingSession,
  foldRecent,
  summarizeRun,
  timelineItems,
  workGroups,
  writeBlock,
} from './work';

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId: 'n:ws',
  name: id,
  lastActivityAt: '2026-09-29T00:00:00Z',
  runnerStatus: 'ready',
  unreadCount: 0,
  ...extra,
});
const scheduled = (scheduleId: string) => ({
  origin: { kind: 'schedule' as const, scheduleId, title: `Schedule ${scheduleId}`, dueAt: 0 },
});

describe('foldRecent', () => {
  it('folds runs of one schedule where its newest run is', () => {
    const rows = foldRecent([
      session('a'),
      session('s1', scheduled('x')),
      session('b'),
      session('s2', scheduled('x')),
      session('t1', scheduled('y')),
    ]);
    expect(rows.map((row) => (row.kind === 'session' ? row.session.id : row.title))).toEqual([
      'a',
      'Schedule x',
      'b',
      't1',
    ]);
    const fold = rows[1]!;
    expect(fold.kind === 'schedule' && fold.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps a pinned run on its own row', () => {
    const rows = foldRecent([
      session('s1', { ...scheduled('x'), pinned: true }),
      session('s2', scheduled('x')),
      session('s3', scheduled('x')),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['session', 'schedule']);
  });
});

describe('workGroups', () => {
  it('splits running from recent, leaves waiting sessions to "Needs you", hides done ones', () => {
    const groups = workGroups(
      [
        session('run', { runStatus: 'running' }),
        session('queued', { runStatus: 'queued' }),
        session('wait', { runStatus: 'waiting_input' }),
        session('done', { settled: true }),
        session('idle', { runStatus: 'succeeded' }),
        session('pin', { pinned: true }),
        session('other', { workspaceId: 'n:other' }),
      ],
      (item) => item.workspaceId === 'n:ws',
      false,
    );
    expect(groups.running.map((s) => s.id)).toEqual(['run', 'queued']);
    expect(groups.recent.map((row) => row.kind === 'session' && row.session.id)).toEqual([
      'pin',
      'idle',
    ]);
    expect(groups.settled).toBe(1);
  });
});

describe('writeBlock', () => {
  const output =
    'Error: /srv/code/pirc is being written by session "Fix the build" (pi_42); wait until its run finishes';

  it('reads the holder and path of a refused write', () => {
    expect(writeBlock({ status: 'failed', output })).toEqual({
      path: '/srv/code/pirc',
      holderName: 'Fix the build',
    });
    expect(writeBlock({ status: 'succeeded', output })).toBeUndefined();
    expect(writeBlock({ status: 'failed', output: 'ENOENT' })).toBeUndefined();
  });

  it('prefers the session holding a lease when names repeat', () => {
    const sessions = [
      session('old', { name: 'Fix the build' }),
      session('now', { name: 'Fix the build', writeLease: true }),
    ];
    expect(blockingSession(sessions, 'Fix the build')?.id).toBe('now');
    expect(blockingSession(sessions.slice(0, 1), 'Fix the build')?.id).toBe('old');
    expect(blockingSession(sessions, 'Nobody')).toBeUndefined();
  });
});

describe('run cards', () => {
  const tool = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({
    id,
    name: 'read',
    status: 'succeeded',
    ...extra,
  });
  const turn = (id: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-09-29T00:00:00Z',
    tools: [tool(`${id}-t`)],
    ...extra,
  });

  it('groups two or more consecutive tool-only turns', () => {
    const items = timelineItems([
      turn('a'),
      turn('b'),
      turn('text', { content: 'Done.', tools: [] }),
      turn('c'),
      turn('d', { content: 'With words' }),
    ]);
    expect(
      items.map((item) => (item.kind === 'run' ? item.messages.map((m) => m.id) : item.message.id)),
    ).toEqual([['a', 'b'], 'text', 'c', 'd']);
  });

  it('summarizes status, duration and file names', () => {
    const summary = summarizeRun([
      tool('1', {
        input: { path: 'apps/web/public/sw.js' },
        startedAt: '2026-09-29T00:00:00.000Z',
        endedAt: '2026-09-29T00:00:01.000Z',
      }),
      tool('2', {
        name: 'edit',
        input: { path: 'src/sw.js' },
        startedAt: '2026-09-29T00:00:02.000Z',
        endedAt: '2026-09-29T00:00:04.100Z',
      }),
      tool('3', { name: 'bash', input: { command: 'ls' } }),
    ]);
    expect(summary).toEqual({ count: 3, status: 'succeeded', durationMs: 4100, files: ['sw.js'] });
    expect(summarizeRun([tool('1'), tool('2', { status: 'failed' })]).status).toBe('failed');
    expect(summarizeRun([tool('1', { status: 'running' })]).durationMs).toBeUndefined();
  });
});
