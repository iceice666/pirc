// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, normalizeEvent } from './api';
import { engine } from './engine.svelte';
import { demoSnapshot } from './mock';
import { fromSnapshot, reduceEvent } from './state';
import type { SessionSnapshot, SessionSummary, Workspace } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function snapshotFor(session: SessionSummary, run: SessionSnapshot['run'] = null) {
  return { ...demoSnapshot, session, run } satisfies SessionSnapshot;
}

class TestWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = TestWebSocket.CONNECTING;

  constructor(_url: string) {
    super();
  }

  close() {
    this.readyState = 3;
  }
}

const workspace: Workspace = {
  id: 'w1',
  hostId: 'host',
  displayName: 'Workspace',
  defaults: {},
};

describe('the open session’s stream', () => {
  const state = () => fromSnapshot(snapshotFor({ ...demoSnapshot.session, id: 's1' }));
  const event = (raw: Record<string, unknown>) =>
    normalizeEvent({ sessionId: 's1', epoch: 'demo-epoch', sequence: 7, ...raw });

  it('asks for a fresh snapshot when a question is asked or answered, keeping none', () => {
    for (const raw of [
      { type: 'interaction_created', data: { id: 'q0', runnerEpoch: 0, kind: 'confirm' } },
      { type: 'interaction_answered', data: { interactionId: 'q0', interactionEpoch: 0 } },
    ]) {
      const updated = reduceEvent(state(), event(raw));
      expect(updated.needsSnapshot).toBe(true);
      expect(updated).not.toHaveProperty('interactions');
    }
  });

  it('only moves the cursor for what the agent says (no conversation here)', () => {
    for (const raw of [
      { type: 'pi_event', data: { type: 'message_update', assistantMessageEvent: {} } },
      { type: 'pi_event', data: { type: 'tool_execution_start', toolCallId: 't1' } },
      { type: 'notification', data: { method: 'notify', message: 'hi' } },
      { type: 'delegations_changed', data: { delegations: [] } },
    ]) {
      const updated = reduceEvent(state(), event(raw));
      expect(updated.needsSnapshot).toBe(false);
      expect(updated.cursor).toBe('demo-epoch:7');
      expect(updated).not.toHaveProperty('messages');
    }
  });
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  } satisfies Storage);
});

afterEach(() => {
  engine.dispose();
  engine.demo = undefined;
  engine.activeSessionId = undefined;
  engine.sessionState = undefined;
  engine.sessions = [];
  engine.workspaces = [];
  engine.pageError = '';
  engine.answeringInteractionIds = [];
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('app asynchronous refreshes', () => {
  it('removes a session when a fresh list confirms it is gone', async () => {
    engine.demo = undefined;
    const gone = { ...demoSnapshot.session, id: 's-gone', workspaceId: workspace.id };
    engine.sessions = [gone];
    engine.workspaces = [workspace];
    engine.activeSessionId = gone.id;
    engine.sessionState = fromSnapshot(snapshotFor(gone));
    vi.spyOn(api, 'sessions').mockResolvedValue([]);

    await engine.refreshSessions();

    expect(engine.sessions).toEqual([]);
    expect(engine.activeSessionId).toBeUndefined();
  });

  it('ignores an older session list when a newer refresh finishes first', async () => {
    engine.demo = undefined;
    const older = { ...demoSnapshot.session, id: 's-older' };
    const newer = { ...demoSnapshot.session, id: 's-newer' };
    const first = deferred<SessionSummary[]>();
    const second = deferred<SessionSummary[]>();
    vi.spyOn(api, 'sessions')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstRefresh = engine.refreshSessions();
    const secondRefresh = engine.refreshSessions();
    second.resolve([newer]);
    await secondRefresh;
    first.resolve([older]);
    await firstRefresh;

    expect(engine.sessions.map((session) => session.id)).toEqual(['s-newer']);
  });

  it('lets a new session reconcile after an older session snapshot is pending', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    engine.demo = undefined;
    const oldSession = { ...demoSnapshot.session, id: 's-old' };
    const newSession = { ...demoSnapshot.session, id: 's-new' };
    engine.activeSessionId = oldSession.id;
    engine.sessions = [oldSession, newSession];
    engine.sessionState = fromSnapshot(snapshotFor(oldSession));

    const oldSnapshot = deferred<SessionSnapshot>();
    const newRefresh = deferred<SessionSnapshot>();
    const snapshot = vi
      .spyOn(api, 'snapshot')
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockResolvedValueOnce(snapshotFor(newSession))
      .mockReturnValueOnce(newRefresh.promise);
    vi.spyOn(api, 'heartbeatControl').mockResolvedValue(snapshotFor(newSession).control);

    const oldRefresh = engine.refreshSnapshot();
    await engine.openSession(newSession.id);
    const reset = normalizeEvent({
      sessionId: newSession.id,
      epoch: 'demo-epoch',
      sequence: 4,
      type: 'reset',
      reason: 'cursor_expired',
    });
    engine.sessionState = reduceEvent(engine.sessionState!, reset);
    if (engine.sessionState.needsSnapshot) void engine.refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(3);

    oldSnapshot.resolve(snapshotFor(oldSession));
    await oldRefresh;
    newRefresh.resolve(snapshotFor(newSession, { id: 'run-2', status: 'succeeded' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.activeSessionId).toBe(newSession.id);
    expect(engine.sessionState?.session.id).toBe(newSession.id);
    expect(engine.sessionState?.run?.status).toBe('succeeded');
  });

  it('answers a delegated approval from "Needs you" in the chat that holds it', async () => {
    engine.demo = undefined;
    const approval = {
      sessionId: 's-chat',
      interactionId: 'relay.d1.interaction_1',
      title: 'Allow network access?',
    };
    const answer = vi.spyOn(api, 'answerRelayed').mockResolvedValue();
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    await engine.answerApproval(approval, true);
    expect(answer).toHaveBeenCalledWith('s-chat', 'relay.d1.interaction_1', true);
    expect(engine.pageError).toBe('');

    answer.mockRejectedValueOnce(new ApiError('Already answered', 409, 'conflict'));
    await engine.answerApproval(approval, false);
    expect(engine.pageError).toBe('Already answered');
    expect(engine.answeringInteractionIds).toEqual([]);
  });
});
