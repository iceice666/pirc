// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, normalizeEvent } from './api';
import { engine } from './engine.svelte';
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
  defaults: {},
};

const questionCreated = normalizeEvent({
  sessionId: 's1',
  epoch: 'demo-epoch',
  sequence: 2,
  type: 'interaction_created',
  data: {
    id: 'interaction:q0',
    runnerEpoch: 0,
    kind: 'confirm',
    status: 'pending',
    request: {
      title: 'Continue?',
      message: 'The agent asks.',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    },
  },
});
if (questionCreated.event.type !== 'interaction_updated')
  throw new Error('Expected an interaction.');
const questionInteraction = questionCreated.event.interaction;

it('keeps a newer interaction when a legacy removal has no row epoch', () => {
  const session = { ...demoSnapshot.session, id: 's-legacy-event' };
  const newer = { ...questionInteraction, id: 'interaction:reused', runnerEpoch: '5' };
  const state = fromSnapshot(snapshotFor(session, [newer]));
  const legacyRemoval = normalizeEvent({
    sessionId: session.id,
    epoch: state.runnerEpoch,
    sequence: 1,
    type: 'interaction_answered',
    data: { interactionId: newer.id },
  });

  const updated = reduceEvent(state, legacyRemoval);

  expect(updated.interactions).toEqual([newer]);
  expect(updated.needsSnapshot).toBe(true);
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
  engine.draft = '';
  engine.uploads = [];
  engine.pageError = '';
  engine.interactionNotice = '';
  engine.answeringInteractionIds = [];
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('message branch commands', () => {
  function setup() {
    engine.connection = 'connected';
    engine.demo = undefined;
    engine.commandBusy = false;
    engine.activeSessionId = demoSnapshot.session.id;
    engine.sessionState = fromSnapshot({
      ...demoSnapshot,
      run: null,
      partialMessage: undefined,
      runnerStatus: 'ready',
      control: { ...demoSnapshot.control, heldByCurrentClient: true, generation: 1 },
      messages: [
        {
          id: 'user-1',
          entryId: 'entry-1',
          role: 'user',
          content: 'Original',
          createdAt: new Date(1).toISOString(),
          branches: [
            { entryId: 'entry-1', text: 'Original', selected: true },
            { entryId: 'entry-2', text: 'Edited', selected: false },
          ],
        },
      ],
    });
    const command = vi
      .spyOn(api, 'command')
      .mockResolvedValue({ commandId: 'branch', status: 'accepted' });
    const refresh = vi
      .spyOn(api, 'snapshot')
      .mockResolvedValue({ ...demoSnapshot, run: null, messages: engine.sessionState!.messages });
    return { command, refresh };
  }
  it('refreshes stable branch metadata after accepted editing and switching', async () => {
    const { command, refresh } = setup();
    expect(await engine.changeBranch('edit_message', 'entry-1', 'Revised')).toBe(true);
    expect(command).toHaveBeenLastCalledWith(
      engine.activeSessionId,
      expect.objectContaining({ kind: 'edit_message', entryId: 'entry-1', content: 'Revised' }),
    );
    expect(await engine.changeBranch('switch_branch', 'entry-2')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('reports rejected edits without discarding the composer draft or refreshing', async () => {
    const { command, refresh } = setup();
    engine.draft = 'Unrelated unsent draft';
    command.mockResolvedValue({ commandId: 'branch', status: 'rejected', message: 'Busy' });
    expect(await engine.changeBranch('edit_message', 'entry-1', 'Revised')).toBe(false);
    expect(engine.draft).toBe('Unrelated unsent draft');
    expect(engine.pageError).toContain('Busy');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('keeps mutation controls gated until a post-edit snapshot arrives, including failed refreshes', async () => {
    const { refresh } = setup();
    const pending = deferred<SessionSnapshot>();
    refresh.mockReturnValueOnce(pending.promise);
    engine.hiddenMessages = 120;
    const edit = engine.changeBranch('edit_message', 'entry-1', 'Revised');
    await Promise.resolve();
    expect(engine.canChangeBranch).toBe(false);
    pending.resolve({ ...demoSnapshot, run: null, messages: [] });
    expect(await edit).toBe(true);
    expect(engine.hiddenMessages).toBe(0);
    expect(engine.commandBusy).toBe(false);
  });
  it('does not offer to resubmit accepted edits when snapshot refresh fails', async () => {
    const { refresh } = setup();
    refresh.mockRejectedValueOnce(new Error('Refresh unavailable'));
    expect(await engine.changeBranch('edit_message', 'entry-1', 'Revised')).toBe(true);
    expect(engine.commandBusy).toBe(false);
    expect(engine.canChangeBranch).toBe(false);
    expect(engine.pageError).toContain('Refresh unavailable');
    expect(await engine.changeBranch('edit_message', 'entry-1', 'Duplicate')).toBe(false);
    await engine.refreshSnapshot();
    expect(engine.canChangeBranch).toBe(true);
  });
  it('waits for its own authoritative fetch even if a lifecycle snapshot is pending', async () => {
    const { refresh } = setup();
    const before = deferred<SessionSnapshot>();
    const after = deferred<SessionSnapshot>();
    refresh.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const lifecycle = engine.refreshSnapshot();
    const edit = engine.changeBranch('edit_message', 'entry-1', 'Revised');
    await Promise.resolve();
    before.resolve({ ...demoSnapshot, run: null, messages: [] });
    await lifecycle;
    expect(engine.canChangeBranch).toBe(false);
    expect(engine.sessionState!.messages).toHaveLength(1);
    after.resolve({ ...demoSnapshot, run: null, messages: [] });
    expect(await edit).toBe(true);
    expect(engine.sessionState!.messages).toEqual([]);
  });
  it('guards control, busy runs, unknown entries, and duplicate commands', async () => {
    const { command } = setup();
    expect(await engine.changeBranch('edit_message', 'missing', 'Revised')).toBe(false);
    engine.sessionState = { ...engine.sessionState!, run: { id: 'run', status: 'running' } };
    expect(await engine.changeBranch('switch_branch', 'entry-2')).toBe(false);
    engine.sessionState = {
      ...engine.sessionState!,
      run: null,
      control: { ...engine.sessionState!.control, heldByCurrentClient: false },
    };
    expect(await engine.changeBranch('edit_message', 'entry-1', 'Revised')).toBe(false);
    engine.sessionState = {
      ...engine.sessionState!,
      control: { ...engine.sessionState!.control, heldByCurrentClient: true },
    };
    engine.commandBusy = true;
    expect(await engine.changeBranch('switch_branch', 'entry-2')).toBe(false);
    engine.commandBusy = false;
    expect(command).not.toHaveBeenCalled();
  });
});

describe('app asynchronous refreshes', () => {
  it('ignores a session list fetched before creating and opening a session', async () => {
    engine.demo = undefined;
    vi.stubGlobal('WebSocket', TestWebSocket);
    const existing = { ...demoSnapshot.session, id: 's-old', workspaceId: workspace.id };
    const created = { ...existing, id: 's-new', name: 'New session' };
    const list = deferred<SessionSummary[]>();
    vi.spyOn(api, 'sessions').mockReturnValueOnce(list.promise);
    vi.spyOn(api, 'createSession').mockResolvedValue(created);
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshotFor(created));
    vi.spyOn(api, 'models').mockResolvedValue([]);
    vi.spyOn(api, 'heartbeatControl').mockResolvedValue(snapshotFor(created).control);

    engine.workspaces = [workspace];
    engine.sessions = [existing];
    engine.activeSessionId = existing.id;
    engine.sessionState = fromSnapshot(snapshotFor(existing));
    const staleRefresh = engine.refreshSessions();

    expect(await engine.createSession(workspace.id)).toBe(true);
    saveDraft(created.id, 'keep this draft');
    list.resolve([existing]);
    await staleRefresh;

    expect(engine.activeSessionId).toBe(created.id);
    expect(engine.sessionState?.session.id).toBe(created.id);
    expect(engine.sessions.some((session) => session.id === created.id)).toBe(true);
    expect(loadDraft(created.id)).toBe('keep this draft');
  });

  it('removes a session and its draft when a fresh list confirms it is gone', async () => {
    engine.demo = undefined;
    const gone = { ...demoSnapshot.session, id: 's-gone', workspaceId: workspace.id };
    engine.sessions = [gone];
    engine.workspaces = [workspace];
    engine.activeSessionId = gone.id;
    engine.sessionState = fromSnapshot(snapshotFor(gone));
    saveDraft(gone.id, 'draft for deleted session');
    vi.spyOn(api, 'sessions').mockResolvedValue([]);

    await engine.refreshSessions();

    expect(engine.sessions).toEqual([]);
    expect(engine.activeSessionId).toBeUndefined();
    expect(loadDraft(gone.id)).toBe('');
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

  it.each([
    {
      name: 'an approval while an older snapshot is loading',
      initial: [questionInteraction],
      incoming: normalizeEvent({
        sessionId: 's1',
        epoch: 'demo-epoch',
        sequence: 3,
        type: 'interaction_answered',
        data: {
          interactionId: 'interaction:q0',
          interactionEpoch: questionInteraction.runnerEpoch,
        },
      }),
      stale: [questionInteraction],
      fresh: [],
      expected: [],
    },
    {
      name: 'a new question while an older snapshot is loading',
      initial: [],
      incoming: questionCreated,
      stale: [],
      fresh: [questionInteraction],
      expected: ['interaction:q0'],
    },
  ])('$name', async ({ initial, incoming, stale, fresh, expected }) => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's1' };
    engine.activeSessionId = session.id;
    engine.sessions = [session];
    engine.sessionState = fromSnapshot(snapshotFor(session, initial));

    const first = deferred<SessionSnapshot>();
    const correction = deferred<SessionSnapshot>();
    const snapshot = vi
      .spyOn(api, 'snapshot')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(correction.promise);
    const loading = engine.refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(1);

    engine.sessionState = reduceEvent(engine.sessionState!, incoming);
    if (engine.sessionState.needsSnapshot) void engine.refreshSnapshot();
    expect(engine.sessionState.interactions.map((item) => item.id)).toEqual(
      incoming.event.type === 'interaction_removed' ? [] : ['interaction:q0'],
    );

    first.resolve(snapshotFor(session, stale));
    await loading;
    expect(snapshot).toHaveBeenCalledTimes(2);
    correction.resolve(snapshotFor(session, fresh));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.sessionState?.interactions.map((item) => item.id)).toEqual(expected);
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
    vi.spyOn(api, 'models').mockResolvedValue([]);
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
    newRefresh.resolve(snapshotFor(newSession, [questionInteraction]));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.activeSessionId).toBe(newSession.id);
    expect(engine.sessionState?.session.id).toBe(newSession.id);
    expect(engine.sessionState?.interactions.map((item) => item.id)).toEqual(['interaction:q0']);
  });

  it('confirms a stale answer as handled only after the exact question disappears from a fresh snapshot', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-answer' };
    const interaction = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '4' };
    engine.activeSessionId = session.id;
    engine.sessionState = {
      ...fromSnapshot(snapshotFor(session, [interaction])),
      control: { heldByCurrentClient: true, generation: 7 },
    };
    const answer = vi
      .spyOn(api, 'answerInteraction')
      .mockRejectedValueOnce(new ApiError('Already answered', 409, 'stale_interaction'));
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshotFor(session, []));

    await engine.answerInteraction(interaction.id, { action: 'answer', value: true });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(engine.interactionNotice).toBe('This request has already been handled.');
    expect(engine.sessionState?.interactions).toEqual([]);
  });

  it('keeps a conflicting answer available when the exact question is still pending', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-answer' };
    const interaction = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '4' };
    engine.activeSessionId = session.id;
    engine.sessionState = {
      ...fromSnapshot(snapshotFor(session, [interaction])),
      control: { heldByCurrentClient: true, generation: 7 },
    };
    const answer = vi
      .spyOn(api, 'answerInteraction')
      .mockRejectedValueOnce(new ApiError('Control changed', 409, 'lost_control'));
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshotFor(session, [interaction]));
    vi.spyOn(api, 'heartbeatControl').mockResolvedValue({ heldByCurrentClient: false });

    await engine.answerInteraction(interaction.id, { action: 'answer', value: true });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(engine.interactionNotice).toBe(
      'This request is still waiting. Take control to answer it.',
    );
    expect(engine.sessionState?.interactions).toEqual([interaction]);
  });

  it('does not claim an answer was handled when the authoritative check fails', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-answer' };
    const interaction = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '4' };
    engine.activeSessionId = session.id;
    engine.sessionState = {
      ...fromSnapshot(snapshotFor(session, [interaction])),
      control: { heldByCurrentClient: true, generation: 7 },
    };
    const answer = vi
      .spyOn(api, 'answerInteraction')
      .mockRejectedValueOnce(new ApiError('Stale', 409, 'stale_interaction'));
    vi.spyOn(api, 'snapshot').mockRejectedValueOnce(new Error('offline'));

    await engine.answerInteraction(interaction.id, { action: 'answer', value: true });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(engine.interactionNotice).toContain('couldn’t verify');
    expect(engine.sessionState?.interactions).toEqual([interaction]);
  });

  it('recognizes a stale card callback after remote removal without touching a reused id', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-answer' };
    const oldQuestion = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '4' };
    const newQuestion = { ...questionInteraction, id: oldQuestion.id, runnerEpoch: '5' };
    engine.activeSessionId = session.id;
    engine.sessionState = fromSnapshot(snapshotFor(session, [oldQuestion]));
    const oldState = engine.sessionState;
    engine.sessionState = reduceEvent(
      oldState,
      normalizeEvent({
        sessionId: session.id,
        epoch: oldState.runnerEpoch,
        sequence: 1,
        type: 'interaction_answered',
        data: { interactionId: oldQuestion.id, interactionEpoch: oldQuestion.runnerEpoch },
      }),
    );
    engine.sessionState = reduceEvent(engine.sessionState, {
      sessionId: session.id,
      runnerEpoch: oldState.runnerEpoch,
      sequence: 2,
      cursor: 'new-question',
      event: { type: 'interaction_updated', interaction: newQuestion },
    });
    const answer = vi.spyOn(api, 'answerInteraction');
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshotFor(session, [newQuestion]));

    await engine.answerInteraction(
      oldQuestion.id,
      { action: 'answer', value: true },
      oldQuestion.runnerEpoch,
    );

    expect(answer).not.toHaveBeenCalled();
    expect(engine.interactionNotice).toBe('This request has already been handled.');
    expect(engine.sessionState?.interactions).toEqual([newQuestion]);
  });

  it('reports a duplicate callback as processing instead of submitting twice', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-answer' };
    const interaction = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '4' };
    engine.activeSessionId = session.id;
    engine.sessionState = {
      ...fromSnapshot(snapshotFor(session, [interaction])),
      control: { heldByCurrentClient: true, generation: 7 },
    };
    const pending = deferred<void>();
    const answer = vi.spyOn(api, 'answerInteraction').mockReturnValueOnce(pending.promise);

    const first = engine.answerInteraction(
      interaction.id,
      { action: 'answer', value: true },
      interaction.runnerEpoch,
    );
    await Promise.resolve();
    await engine.answerInteraction(
      interaction.id,
      { action: 'answer', value: true },
      interaction.runnerEpoch,
    );

    expect(answer).toHaveBeenCalledTimes(1);
    expect(engine.interactionNotice).toBe('This request is already being processed.');
    pending.resolve();
    await first;
  });

  it('answers a relayed confirm without holding the control lease', async () => {
    engine.demo = undefined;
    const session = { ...demoSnapshot.session, id: 's-chat' };
    const relayed = { ...questionInteraction, id: 'relay.d1.interaction_1', runnerEpoch: '0' };
    const local = { ...questionInteraction, id: 'interaction:q1', runnerEpoch: '0' };
    engine.activeSessionId = session.id;
    engine.sessionState = {
      ...fromSnapshot(snapshotFor(session, [relayed, local])),
      control: { heldByCurrentClient: false, holderClientId: 'other', generation: 3 },
    };
    const answer = vi.spyOn(api, 'answerInteraction').mockResolvedValue();
    const takeControl = vi.spyOn(api, 'takeControl');

    await engine.answerInteraction(relayed.id, { action: 'answer', value: false }, '0');

    expect(answer).toHaveBeenCalledWith(
      session.id,
      relayed.id,
      { action: 'answer', value: false },
      undefined,
    );
    expect(takeControl).not.toHaveBeenCalled();
    expect(engine.sessionState?.interactions).toEqual([local]);
  });

  it('applies delegations_changed to the open chat', () => {
    const session = { ...demoSnapshot.session, id: 's-chat' };
    const state = fromSnapshot(snapshotFor(session));
    const delegation = {
      id: 'd1',
      title: 'Fix the tests',
      workspace: 'repo on node',
      status: 'running',
      dispatch: 'approved',
      targetSessionId: 'worker',
    };
    const updated = reduceEvent(
      state,
      normalizeEvent({
        sessionId: session.id,
        epoch: state.runnerEpoch,
        sequence: 1,
        type: 'delegations_changed',
        data: { delegations: [delegation] },
      }),
    );
    expect(updated.delegations).toEqual([delegation]);
    expect(updated.needsSnapshot).toBe(false);
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
