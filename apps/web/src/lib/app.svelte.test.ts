// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, normalizeEvent } from './api';
import { app } from './app.svelte';
import { demoSnapshot } from './mock';
import { fromSnapshot, reduceEvent } from './state';
import { loadDraft, saveDraft } from './storage';
import type { SessionSnapshot, SessionSummary, Workspace } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function snapshotFor(
  session: SessionSummary,
  interactions = [] as SessionSnapshot['interactions'],
) {
  return {
    ...demoSnapshot,
    session,
    messages: [],
    interactions,
  } satisfies SessionSnapshot;
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
  kind: 'directory',
  defaults: {},
};

const memoryProposal = normalizeEvent({
  sessionId: 's1',
  epoch: 'demo-epoch',
  sequence: 2,
  type: 'interaction_created',
  data: {
    id: 'memory:p1:0',
    runnerEpoch: 0,
    kind: 'confirm',
    status: 'pending',
    request: {
      title: 'Add USER memory?',
      message: 'Proposed memory:\nLikes tea.',
      confirmLabel: 'Approve',
      cancelLabel: 'Reject',
    },
  },
});
if (memoryProposal.event.type !== 'interaction_updated')
  throw new Error('Expected a memory proposal interaction.');
const proposalInteraction = memoryProposal.event.interaction;

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
  app.dispose();
  app.demo = undefined;
  app.activeSessionId = undefined;
  app.sessionState = undefined;
  app.sessions = [];
  app.workspaces = [];
  app.draft = '';
  app.uploads = [];
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('app asynchronous refreshes', () => {
  it('ignores a session list fetched before creating and opening a session', async () => {
    app.demo = undefined;
    vi.stubGlobal('WebSocket', TestWebSocket);
    const existing = { ...demoSnapshot.session, id: 's-old', workspaceId: workspace.id };
    const created = { ...existing, id: 's-new', name: 'New session' };
    const list = deferred<SessionSummary[]>();
    vi.spyOn(api, 'sessions').mockReturnValueOnce(list.promise);
    vi.spyOn(api, 'createSession').mockResolvedValue(created);
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshotFor(created));
    vi.spyOn(api, 'models').mockResolvedValue([]);
    vi.spyOn(api, 'heartbeatControl').mockResolvedValue(snapshotFor(created).control);

    app.workspaces = [workspace];
    app.sessions = [existing];
    app.activeSessionId = existing.id;
    app.sessionState = fromSnapshot(snapshotFor(existing));
    const staleRefresh = app.refreshSessions();

    expect(await app.createSession(workspace.id)).toBe(true);
    saveDraft(created.id, 'keep this draft');
    list.resolve([existing]);
    await staleRefresh;

    expect(app.activeSessionId).toBe(created.id);
    expect(app.sessionState?.session.id).toBe(created.id);
    expect(app.sessions.some((session) => session.id === created.id)).toBe(true);
    expect(loadDraft(created.id)).toBe('keep this draft');
  });

  it('removes a session and its draft when a fresh list confirms it is gone', async () => {
    app.demo = undefined;
    const gone = { ...demoSnapshot.session, id: 's-gone', workspaceId: workspace.id };
    app.sessions = [gone];
    app.workspaces = [workspace];
    app.activeSessionId = gone.id;
    app.sessionState = fromSnapshot(snapshotFor(gone));
    saveDraft(gone.id, 'draft for deleted session');
    vi.spyOn(api, 'sessions').mockResolvedValue([]);

    await app.refreshSessions();

    expect(app.sessions).toEqual([]);
    expect(app.activeSessionId).toBeUndefined();
    expect(loadDraft(gone.id)).toBe('');
  });

  it('ignores an older session list when a newer refresh finishes first', async () => {
    app.demo = undefined;
    const older = { ...demoSnapshot.session, id: 's-older' };
    const newer = { ...demoSnapshot.session, id: 's-newer' };
    const first = deferred<SessionSummary[]>();
    const second = deferred<SessionSummary[]>();
    vi.spyOn(api, 'sessions')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstRefresh = app.refreshSessions();
    const secondRefresh = app.refreshSessions();
    second.resolve([newer]);
    await secondRefresh;
    first.resolve([older]);
    await firstRefresh;

    expect(app.sessions.map((session) => session.id)).toEqual(['s-newer']);
  });

  it.each([
    {
      name: 'an approval while an older snapshot is loading',
      initial: [proposalInteraction],
      incoming: normalizeEvent({
        sessionId: 's1',
        epoch: 'demo-epoch',
        sequence: 3,
        type: 'interaction_answered',
        data: { interactionId: 'memory:p1:0' },
      }),
      stale: [proposalInteraction],
      fresh: [],
      expected: [],
    },
    {
      name: 'a new proposal while an older snapshot is loading',
      initial: [],
      incoming: memoryProposal,
      stale: [],
      fresh: [proposalInteraction],
      expected: ['memory:p1:0'],
    },
  ])('$name', async ({ initial, incoming, stale, fresh, expected }) => {
    app.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's1' };
    app.activeSessionId = session.id;
    app.sessions = [session];
    app.sessionState = fromSnapshot(snapshotFor(session, initial));

    const first = deferred<SessionSnapshot>();
    const correction = deferred<SessionSnapshot>();
    const snapshot = vi
      .spyOn(api, 'snapshot')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(correction.promise);
    const loading = app.refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(1);

    app.sessionState = reduceEvent(app.sessionState!, incoming);
    if (app.sessionState.needsSnapshot) void app.refreshSnapshot();
    expect(app.sessionState.interactions.map((item) => item.id)).toEqual(
      incoming.event.type === 'interaction_removed' ? [] : ['memory:p1:0'],
    );

    first.resolve(snapshotFor(session, stale));
    await loading;
    expect(snapshot).toHaveBeenCalledTimes(2);
    correction.resolve(snapshotFor(session, fresh));
    await Promise.resolve();
    await Promise.resolve();

    expect(app.sessionState?.interactions.map((item) => item.id)).toEqual(expected);
  });

  it('lets a new session reconcile after an older session snapshot is pending', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    app.demo = undefined;
    const oldSession = { ...demoSnapshot.session, id: 's-old' };
    const newSession = { ...demoSnapshot.session, id: 's-new' };
    app.activeSessionId = oldSession.id;
    app.sessions = [oldSession, newSession];
    app.sessionState = fromSnapshot(snapshotFor(oldSession));

    const oldSnapshot = deferred<SessionSnapshot>();
    const newRefresh = deferred<SessionSnapshot>();
    const snapshot = vi
      .spyOn(api, 'snapshot')
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockResolvedValueOnce(snapshotFor(newSession))
      .mockReturnValueOnce(newRefresh.promise);
    vi.spyOn(api, 'models').mockResolvedValue([]);
    vi.spyOn(api, 'heartbeatControl').mockResolvedValue(snapshotFor(newSession).control);

    const oldRefresh = app.refreshSnapshot();
    await app.openSession(newSession.id);
    const reset = normalizeEvent({
      sessionId: newSession.id,
      epoch: 'demo-epoch',
      sequence: 4,
      type: 'reset',
      reason: 'cursor_expired',
    });
    app.sessionState = reduceEvent(app.sessionState!, reset);
    if (app.sessionState.needsSnapshot) void app.refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(3);

    oldSnapshot.resolve(snapshotFor(oldSession));
    await oldRefresh;
    newRefresh.resolve(snapshotFor(newSession, [proposalInteraction]));
    await Promise.resolve();
    await Promise.resolve();

    expect(app.activeSessionId).toBe(newSession.id);
    expect(app.sessionState?.session.id).toBe(newSession.id);
    expect(app.sessionState?.interactions.map((item) => item.id)).toEqual(['memory:p1:0']);
  });
});
