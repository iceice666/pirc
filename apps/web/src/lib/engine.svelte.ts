/**
 * The engine's state (plans/rewrite/11-web.md): the gateway's workspaces,
 * nodes and sessions, the open session (read-only) and its event stream, its
 * control lease and the questions it asks. Components read it directly
 * instead of receiving it as props. The rooms keep their own (rooms.svelte.ts).
 */
import { api, connectEvents, ApiError, type EventConnection } from './api';
import { isReadOnly, modeOf } from './modes';
import {
  interactionFromUrl,
  isPushInteraction,
  targetFromUrl,
  type PushInteraction,
  type PushTarget,
} from './push';
import { syncControl } from './control';
import { errorMessage } from './errors';
import { PanelStateResource } from './panel-state.svelte';
import { fromSnapshot, reduceEvent } from './state';
import { isOverviewSection, type OverviewSection } from './routes';
import { getClientId } from './storage';
import { needsInput } from './work';
import type {
  ClientSessionState,
  ConnectionState,
  InteractionAnswer,
  ModeInfo,
  NewWorkspace,
  NodeSummary,
  RelayedApproval,
  SessionSummary,
  SessionUpdateInput,
  Workspace,
} from './types';
import { isRelayed } from './types';

/** What the main column shows: a session, a workspace's page, or the front page. */
export type MainView = 'session' | 'workspace' | 'overview';

/** Something waiting for you, shown under "Needs you". */
export type InboxItem = { kind: 'session'; id: string; session: SessionSummary };

/** Side-panel refresh signals: a `panel_changed` event, or the end of a run. */
export type PanelSignal = { type: 'changed'; sections: string[] } | { type: 'run-finished' };

/** The timeline registers itself so incoming events can keep the newest entry in view. */
export interface Scroller {
  /** Scroll to the newest entry and keep following new content. */
  toLatest(smooth?: boolean): Promise<void>;
}

type Demo = typeof import('./mock');

/**
 * A long transcript is rendered from the end: opening a session mounts only
 * the newest `MESSAGE_PAGE` entries (each one parses Markdown synchronously).
 */
export const MESSAGE_PAGE = 60;

/** Returning after this long in the background reloads the open session's snapshot. */
const RESUME_SNAPSHOT_AFTER = 15_000;

class EngineState {
  workspaces = $state.raw<Workspace[]>([]);
  nodes = $state.raw<NodeSummary[]>([]);
  /** The gateway's workspace modes (empty from older gateways: the legacy `kind` decides). */
  modeCatalog = $state.raw<ModeInfo[]>([]);
  /** Bumped whenever the gateway says your memory changed; open memory views reload. */
  memoryRevision = $state(0);
  /** The front page's tab (view `overview`), as `?open=` names it. */
  overviewSection = $state<OverviewSection>('nodes');
  sessions = $state.raw<SessionSummary[]>([]);
  view = $state<MainView>('session');
  /** The workspace whose page is showing (view `workspace`). */
  workspaceViewId = $state<string>();
  activeSessionId = $state<string>();
  connection = $state<ConnectionState>(navigator.onLine ? 'reconnecting' : 'offline');
  loading = $state(true);
  pageError = $state('');
  interactionNotice = $state('');
  answeringInteractionIds = $state.raw<string[]>([]);
  /** Offline demo data (dev builds without a gateway). */
  demo = $state.raw<Demo>();
  /** Earliest transcript entries not yet mounted. */
  hiddenMessages = $state(0);
  clientId = '';
  /** `/panel/state` of the open session (jobs menu, Memory and Tasks tabs). */
  readonly panel = new PanelStateResource();

  #sessionState = $state.raw<ClientSessionState>();
  #events: EventConnection | undefined;
  #controlSyncing: string | undefined;
  /** Bumped per openSession; a slower, superseded open must not apply its result. */
  #openSeq = 0;
  /** Local list changes invalidate session lists fetched before them. */
  #sessionsVersion = 0;
  #sessionsRequest = 0;
  /** Snapshot requests coalesce per open session, so old requests cannot block a new one. */
  #snapshotLoading = new Set<number>();
  #snapshotAgain = new Set<number>();
  #panelListeners = new Set<(signal: PanelSignal) => void>();
  /** The start could not reach the gateway (e.g. an offline cold start from the cached shell). */
  #bootstrapFailed = false;
  scroller: Scroller | undefined;

  get usingDemo() {
    return !!this.demo;
  }

  get sessionState() {
    return this.#sessionState;
  }
  set sessionState(next: ClientSessionState | undefined) {
    const before = this.#sessionState;
    this.#sessionState = next;
    // A finished run may have changed the working tree and memory.
    if (
      before &&
      next &&
      before.session.id === next.session.id &&
      before.run?.status === 'running' &&
      next.run?.status !== 'running'
    )
      this.#emitPanel({ type: 'run-finished' });
  }

  activeWorkspace = $derived(
    this.workspaces.find((workspace) => workspace.id === this.#sessionState?.session.workspaceId),
  );
  runStatus = $derived(this.#sessionState?.run?.status);
  hasControl = $derived(this.#sessionState?.control.heldByCurrentClient ?? false);
  generation = $derived(this.#sessionState?.control.generation);
  pendingInteractions = $derived(
    this.#sessionState?.interactions.filter((item) => item.status === 'pending') ?? [],
  );
  /** Answers need a live connection and the control lease. */
  canCommand = $derived(this.hasControl && this.connection === 'connected');

  /** Everything waiting for you: sessions with a question. */
  inbox = $derived<InboxItem[]>(
    this.sessions
      .filter(
        (session) =>
          needsInput(session) ||
          // Its confirm waits in the chat that delegated it.
          (session.origin?.kind === 'delegation' && !!session.origin.approval),
      )
      .map((session) => ({ kind: 'session' as const, id: `session:${session.id}`, session })),
  );

  /** Show the engine's front page, on one of its tabs. */
  showOverview(section: OverviewSection = this.overviewSection) {
    this.overviewSection = section;
    this.view = 'overview';
    this.#address(`?open=${section}`);
  }

  /**
   * Show a workspace's page: its sessions and its settings. The open session
   * stays connected behind it, so going back is instant.
   */
  showWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    this.workspaceViewId = workspaceId;
    this.view = 'workspace';
    this.#address(`?workspace=${encodeURIComponent(workspaceId)}`);
  }

  /** The address names what is on screen: a reload or a shared link comes back to it. */
  #address(search: string) {
    if (!this.demo && typeof history !== 'undefined')
      history.replaceState(history.state, '', search);
  }

  /**
   * Clear the open session's unread mark (on every device) while you are
   * looking at it: the page is visible and the session is on screen.
   */
  markActiveRead() {
    const id = this.activeSessionId;
    if (!id || this.view !== 'session') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const session = this.sessions.find((item) => item.id === id);
    if (!session?.unread) return;
    this.sessions = this.sessions.map((item) =>
      item.id === id ? { ...item, unread: false } : item,
    );
    this.#sessionsVersion++;
    if (!this.demo) void api.markRead(id).catch(() => undefined);
  }

  /** Listen for side-panel refresh signals. Returns the unsubscribe function. */
  onPanel(listener: (signal: PanelSignal) => void): () => void {
    this.#panelListeners.add(listener);
    return () => this.#panelListeners.delete(listener);
  }
  #emitPanel(signal: PanelSignal) {
    for (const listener of this.#panelListeners) listener(signal);
  }

  /** Start up: load the gateway's lists and open the most recent session. */
  async bootstrap() {
    this.clientId = getClientId();
    this.loading = true;
    this.#bootstrapFailed = false;
    this.pageError = '';
    let linkedTarget: PushTarget | undefined;
    let linkedInteraction: PushInteraction | undefined;
    try {
      [this.workspaces, this.sessions, this.nodes, this.modeCatalog] = await Promise.all([
        api.workspaces(),
        api.sessions(),
        api.nodes(),
        this.#loadModes(),
      ]);
      this.#sessionsVersion++;
      this.activeSessionId = this.sessions[0]?.id;
      // A notification or a shared link names what to open.
      const bootstrapUrl = new URL(location.href);
      linkedTarget = targetFromUrl(bootstrapUrl);
      linkedInteraction = interactionFromUrl(bootstrapUrl);
      if (linkedTarget && 'sessionId' in linkedTarget) {
        const linkedSessionId = linkedTarget.sessionId;
        if (this.sessions.some((session) => session.id === linkedSessionId))
          this.activeSessionId = linkedSessionId;
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        const demo = await import('./mock');
        this.demo = demo;
        this.connection = navigator.onLine ? 'connected' : 'offline';
        this.workspaces = demo.demoWorkspaces;
        this.nodes = demo.demoNodes;
        this.modeCatalog = demo.demoModes;
        this.sessions = demo.demoSessions;
        this.#sessionsVersion++;
        this.activeSessionId = demo.demoSnapshot.session.id;
      } else {
        this.#bootstrapFailed = true;
        this.pageError = errorMessage(error, 'Unable to connect to the gateway.');
      }
    }
    // A workspace page the address names stays in front of the session behind it.
    const address = new URL(location.href).searchParams;
    const page = address.get('workspace');
    const pageWorkspace = page ? this.workspaces.find((item) => item.id === page) : undefined;
    const open = address.get('open');
    if (pageWorkspace) {
      this.workspaceViewId = pageWorkspace.id;
      this.view = 'workspace';
    } else if (isOverviewSection(open) || !address.has('session')) {
      // The engine opens on its front page unless the address names a session.
      this.overviewSection = isOverviewSection(open) ? open : 'nodes';
      this.view = 'overview';
    }
    if (this.activeSessionId) {
      await this.openSession(this.activeSessionId, { show: this.view === 'session' });
      if (
        linkedInteraction &&
        linkedTarget &&
        'sessionId' in linkedTarget &&
        linkedInteraction.sessionId === linkedTarget.sessionId &&
        linkedInteraction.sessionId === this.activeSessionId
      )
        await this.verifyNotificationInteraction(linkedInteraction);
    }
    this.loading = false;
  }

  /** Refresh the node and workspace lists (they change as devices come and go). */
  async refreshNodes() {
    if (this.demo) return;
    try {
      const [online, available, modes] = await Promise.all([
        api.nodes(),
        api.workspaces(),
        this.#loadModes(),
      ]);
      this.nodes = online;
      this.workspaces = available;
      this.modeCatalog = modes;
    } catch {
      /* keep the last lists */
    }
  }

  /** Sessions can appear without this client creating them (a delegated task's session). */
  async refreshSessions() {
    if (this.demo) return;
    const version = this.#sessionsVersion;
    const request = ++this.#sessionsRequest;
    try {
      const sessions = await api.sessions();
      // A selection or local session change means this response may predate a
      // session we already know is valid. It must not remove that session or its draft.
      if (version !== this.#sessionsVersion || request !== this.#sessionsRequest) return;
      this.sessions = sessions;
      if (this.activeSessionId && !this.sessions.some((s) => s.id === this.activeSessionId))
        this.removeSession(this.activeSessionId);
      this.markActiveRead();
    } catch {
      /* keep the last list */
    }
  }

  #sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runs start and end in bursts: one reload per burst. */
  #sessionsChanged() {
    this.#sessionsTimer ??= setTimeout(() => {
      this.#sessionsTimer = undefined;
      void this.refreshSessions();
    }, 250);
  }

  /** Show what a notification points at. */
  async openTarget(target: PushTarget | undefined) {
    if (!target) return;
    if ('sessionId' in target) {
      // A session a delegation just started may be new to this list.
      if (!this.sessions.some((session) => session.id === target.sessionId))
        await this.refreshSessions();
      if (this.sessions.some((session) => session.id === target.sessionId))
        await this.openSession(target.sessionId);
      return;
    }
    if ('roomId' in target) {
      // Rooms are the other page.
      location.assign(`/?room=${encodeURIComponent(target.roomId)}`);
      return;
    }
    this.showOverview('memory');
  }

  /** Open an exact-question notification and check its status against a fresh snapshot. */
  async openNotificationTarget(target: PushTarget | undefined, interaction: unknown) {
    await this.openTarget(target);
    if (
      !interaction ||
      !isPushInteraction(interaction) ||
      !target ||
      !('sessionId' in target) ||
      target.sessionId !== interaction.sessionId
    )
      return;
    await this.verifyNotificationInteraction(interaction);
  }

  /** A clicked notification may outlive its question; never answer on click. */
  async verifyNotificationInteraction(identity: PushInteraction, showPendingNotice = false) {
    const sessionId = identity.sessionId;
    if (this.activeSessionId !== sessionId || this.demo) return;
    try {
      const snapshot = await api.snapshot(sessionId);
      const current = this.sessionState;
      if (this.activeSessionId !== sessionId || current?.session.id !== sessionId) {
        if (this.activeSessionId === sessionId)
          this.interactionNotice =
            'We couldn’t verify whether this request was handled. Check the session before submitting an answer.';
        return;
      }
      const question = snapshot.interactions.find(
        (item) =>
          item.id === identity.interactionId && item.runnerEpoch === identity.interactionEpoch,
      );
      if (question?.status === 'pending') {
        if (showPendingNotice) {
          this.interactionNotice =
            'This request is still waiting. Refresh the session before answering.';
        }
        return;
      }
      this.sessionState = {
        ...current,
        interactions: current.interactions.filter(
          (item) =>
            item.id !== identity.interactionId || item.runnerEpoch !== identity.interactionEpoch,
        ),
      };
      this.interactionNotice = 'This request has already been handled.';
    } catch {
      this.interactionNotice =
        'We couldn’t verify whether this request was handled. Check the session before submitting an answer.';
    }
  }

  /** Start again if the first start could not reach the gateway. Returns whether it did. */
  retryBootstrap(): boolean {
    if (!this.#bootstrapFailed || this.loading) return false;
    void this.bootstrap();
    return true;
  }

  /**
   * Back in the foreground after `hiddenFor` ms: reconnect the event stream at
   * once, renew control, and reload what a suspended page may have missed.
   */
  resume(hiddenFor: number) {
    if (this.retryBootstrap()) return;
    this.#events?.reconnectNow();
    void this.refreshControl();
    void this.refreshNodes();
    void this.refreshSessions();
    // A short switch away is covered by the stream's cursor replay.
    if (hiddenFor >= RESUME_SNAPSHOT_AFTER) void this.refreshSnapshot();
  }

  /** `show: false` connects the session behind the page on screen (a workspace page). */
  async openSession(id: string, { show = true }: { show?: boolean } = {}) {
    if (show) {
      this.view = 'session';
      // The address names the open session: a reload or a shared link comes back
      // to it, and the service worker skips notifications about what is on screen.
      this.#address(`?session=${encodeURIComponent(id)}`);
    }
    // Back from a page to the session still connected behind it.
    if (id === this.activeSessionId && this.sessionState?.session.id === id && this.#events) {
      this.markActiveRead();
      return;
    }
    this.#sessionsVersion++;
    const seq = ++this.#openSeq;
    this.activeSessionId = id;
    this.markActiveRead();
    this.#events?.close();
    this.#events = undefined;
    this.sessionState = undefined;
    this.pageError = '';
    const demo = this.demo;
    this.panel.reset(id, demo?.demoPanelState);
    try {
      const snapshot = demo
        ? {
            ...demo.demoSnapshot,
            session: this.sessions.find((item) => item.id === id) ?? demo.demoSnapshot.session,
          }
        : await api.snapshot(id);
      // Switched to another session while this snapshot was loading.
      if (seq !== this.#openSeq) return;
      this.sessionState = fromSnapshot(snapshot);
      this.hiddenMessages = Math.max(0, this.sessionState.messages.length - MESSAGE_PAGE);
      if (!demo) {
        void this.refreshControl();
        let reconnecting = false;
        this.#events = connectEvents({
          sessionId: id,
          cursor: snapshot.cursor,
          onState: (state) => {
            if (seq !== this.#openSeq) return;
            this.connection = state;
            if (state !== 'connected') {
              reconnecting = true;
              return;
            }
            void this.refreshControl();
            // Node changes while disconnected were not pushed.
            if (reconnecting) void this.refreshNodes();
          },
          onDirectory: () => {
            if (seq !== this.#openSeq) return;
            void this.refreshNodes();
            void this.refreshSessions();
          },
          onMemory: () => {
            if (seq !== this.#openSeq) return;
            this.memoryRevision++;
          },
          onSessions: () => {
            if (seq !== this.#openSeq) return;
            this.#sessionsChanged();
          },
          onEvent: (event) => {
            if (seq === this.#openSeq && event.event.type === 'session_deleted') {
              this.removeSession(id);
              return;
            }
            const current = this.sessionState;
            if (seq !== this.#openSeq || current?.session.id !== id) return;
            this.sessionState = reduceEvent(current, event);
            if (event.event.type === 'panel_changed')
              this.#emitPanel({ type: 'changed', sections: event.event.sections });
            if (event.event.type === 'session_renamed') {
              const name = event.event.name;
              this.sessions = this.sessions.map((item) =>
                item.id === id ? { ...item, name } : item,
              );
              this.#sessionsVersion++;
            }
            if (this.sessionState.needsSnapshot) void this.refreshSnapshot();
          },
        });
      }
      await this.scroller?.toLatest(false);
    } catch (error) {
      if (seq === this.#openSeq)
        this.pageError = errorMessage(error, 'Unable to load this session.');
    }
  }

  /** Reload the open session. Bursts coalesce into one request plus one follow-up. */
  async refreshSnapshot() {
    const id = this.activeSessionId;
    if (!id || this.demo) return;
    const seq = this.#openSeq;
    if (this.#snapshotLoading.has(seq)) {
      this.#snapshotAgain.add(seq);
      return;
    }
    this.#snapshotLoading.add(seq);
    try {
      const snapshot = await api.snapshot(id);
      if (seq !== this.#openSeq || id !== this.activeSessionId || this.#snapshotAgain.has(seq))
        return;
      this.sessionState = fromSnapshot(snapshot);
      this.hiddenMessages = Math.min(
        this.hiddenMessages,
        Math.max(0, snapshot.messages.length - 1),
      );
      const { id: snapshotSessionId, name } = this.sessionState.session;
      if (this.sessions.some((item) => item.id === snapshotSessionId && item.name !== name)) {
        this.sessions = this.sessions.map((item) =>
          item.id === snapshotSessionId ? { ...item, name } : item,
        );
        this.#sessionsVersion++;
      }
    } catch (error) {
      if (seq === this.#openSeq && !this.#snapshotAgain.has(seq))
        this.pageError = errorMessage(error, 'Could not refresh the session.');
    } finally {
      this.#snapshotLoading.delete(seq);
      if (this.#snapshotAgain.delete(seq) && seq === this.#openSeq) void this.refreshSnapshot();
    }
  }

  private removeSession(id: string) {
    const session =
      this.sessions.find((s) => s.id === id) ??
      (this.sessionState?.session.id === id ? this.sessionState.session : undefined);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.#sessionsVersion++;
    if (id === this.activeSessionId) {
      ++this.#openSeq;
      this.#events?.close();
      this.#events = undefined;
      this.sessionState = undefined;
      this.activeSessionId = undefined;
      this.panel.reset('');
      if (session) this.showWorkspace(session.workspaceId);
    }
  }

  /** Rename from the sidebar. Applied at once and rolled back on failure. */
  async renameSession(id: string, name: string) {
    const input: SessionUpdateInput = { name };
    const previous = this.sessions.find((item) => item.id === id);
    if (!previous) return;
    const apply = (patch: Partial<SessionSummary>) => {
      this.sessions = this.sessions.map((item) => (item.id === id ? { ...item, ...patch } : item));
      this.#sessionsVersion++;
      const state = this.sessionState;
      if (state?.session.id === id && patch.name !== undefined)
        this.sessionState = { ...state, session: { ...state.session, name: patch.name } };
    };
    apply(input);
    if (this.demo) return;
    try {
      const updated = await api.updateSession(id, input);
      apply({ name: updated.name });
    } catch (error) {
      apply({ name: previous.name });
      this.pageError = errorMessage(error, 'Could not rename the session.');
    }
  }

  /** Renew this client's lease, or pick control back up if nobody holds a live one. */
  async refreshControl() {
    const id = this.activeSessionId;
    const state = this.sessionState;
    if (this.demo || !id || !state || this.#controlSyncing === id) return;
    this.#controlSyncing = id;
    try {
      const control = await syncControl(api, id, state.control, {
        // A hidden tab only keeps what it has; it never grabs control.
        mayAcquire: document.visibilityState === 'visible',
      });
      const current = this.sessionState;
      if (control && current && this.activeSessionId === id)
        this.sessionState = { ...current, control };
    } finally {
      if (this.#controlSyncing === id) this.#controlSyncing = undefined;
    }
  }

  async takeControl() {
    const state = this.sessionState;
    if (!this.activeSessionId || !state) return;
    try {
      const control = this.demo
        ? {
            heldByCurrentClient: true,
            holderName: 'This browser',
            generation: (state.control.generation ?? 0) + 1,
          }
        : await api.takeControl(this.activeSessionId, this.clientId);
      if (this.sessionState) this.sessionState = { ...this.sessionState, control };
    } catch (error) {
      this.pageError = errorMessage(error, 'Control could not be transferred.');
    }
  }

  async answerInteraction(
    interactionId: string,
    answer: InteractionAnswer,
    expectedRunnerEpoch?: string,
  ) {
    const state = this.sessionState;
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    if (this.answeringInteractionIds.includes(interactionId)) {
      this.interactionNotice = 'This request is already being processed.';
      return;
    }
    const interaction = state?.interactions.find(
      (item) =>
        item.id === interactionId &&
        (expectedRunnerEpoch === undefined || item.runnerEpoch === expectedRunnerEpoch),
    );
    if (!interaction) {
      if (expectedRunnerEpoch !== undefined && !this.demo)
        await this.verifyNotificationInteraction(
          {
            sessionId,
            interactionId,
            interactionEpoch: expectedRunnerEpoch,
          },
          true,
        );
      return;
    }
    // A delegated session's relayed confirm needs no control lease: answer it
    // from any device that sees the chat.
    const relayed = isRelayed(interactionId);
    if (!relayed && !state?.control.generation) return;
    const runnerEpoch = interaction.runnerEpoch;
    this.answeringInteractionIds = [...this.answeringInteractionIds, interactionId];
    this.interactionNotice = '';
    try {
      if (!this.demo)
        await api.answerInteraction(
          sessionId,
          interactionId,
          answer,
          relayed ? undefined : state?.control.generation,
        );
      const current = this.sessionState;
      if (current?.session.id === sessionId)
        this.sessionState = {
          ...current,
          interactions: current.interactions.filter(
            (item) => item.id !== interactionId || item.runnerEpoch !== runnerEpoch,
          ),
        };
    } catch (error) {
      if (
        !this.demo &&
        error instanceof ApiError &&
        error.status === 409 &&
        (error.code === 'stale_interaction' || error.code === 'lost_control')
      ) {
        try {
          const snapshot = await api.snapshot(sessionId);
          if (this.activeSessionId !== sessionId || this.sessionState?.session.id !== sessionId)
            return;
          const snapshotQuestion = snapshot.interactions.find(
            (item) => item.id === interactionId && item.runnerEpoch === runnerEpoch,
          );
          const resolved = !snapshotQuestion || snapshotQuestion.status !== 'pending';
          if (resolved) {
            const current = this.sessionState;
            if (current?.session.id === sessionId)
              this.sessionState = {
                ...current,
                interactions: current.interactions.filter(
                  (item) => item.id !== interactionId || item.runnerEpoch !== runnerEpoch,
                ),
              };
            this.interactionNotice = 'This request has already been handled.';
          } else {
            this.interactionNotice =
              error.code === 'lost_control'
                ? 'This request is still waiting. Take control to answer it.'
                : 'This request is still waiting. Your answer was not accepted.';
          }
          if (error.code === 'lost_control') void this.refreshControl();
        } catch {
          this.interactionNotice =
            'We couldn’t verify whether this request was handled. Check the session before submitting another answer.';
        }
        return;
      }
      this.pageError = errorMessage(error, 'Your answer was not accepted.');
    } finally {
      this.answeringInteractionIds = this.answeringInteractionIds.filter(
        (id) => id !== interactionId,
      );
    }
  }

  /**
   * Allow or deny a delegated session's confirm from "Needs you": it is
   * relayed to the chat that started the delegation, so it is answered
   * there, without that chat's control lease.
   */
  async answerApproval(approval: RelayedApproval, confirmed: boolean) {
    if (this.demo || this.answeringInteractionIds.includes(approval.interactionId)) return;
    this.answeringInteractionIds = [...this.answeringInteractionIds, approval.interactionId];
    try {
      await api.answerRelayed(approval.sessionId, approval.interactionId, confirmed);
      const current = this.sessionState;
      if (current?.session.id === approval.sessionId)
        this.sessionState = {
          ...current,
          interactions: current.interactions.filter((item) => item.id !== approval.interactionId),
        };
    } catch (error) {
      this.pageError = errorMessage(
        error,
        confirmed ? 'The request could not be allowed.' : 'The request could not be denied.',
      );
    } finally {
      this.answeringInteractionIds = this.answeringInteractionIds.filter(
        (id) => id !== approval.interactionId,
      );
    }
    void this.refreshSessions();
  }

  /** The catalog without a failed refresh's gap: an error keeps the last one. */
  #loadModes() {
    return api.modes().catch(() => this.modeCatalog);
  }

  /** What a workspace can do: its mode's capabilities (or its legacy kind's). */
  modeOf(workspace: Workspace): ModeInfo;
  modeOf(workspace: Workspace | undefined): ModeInfo | undefined;
  modeOf(workspace: Workspace | undefined) {
    return modeOf(workspace, this.modeCatalog);
  }

  /** Whether a workspace's device is reachable (local workspaces always are). */
  workspaceOnline(workspace: Workspace | undefined) {
    return (
      !!workspace &&
      (!workspace.id.includes(':') || this.nodes.some((node) => node.id === workspace.hostId))
    );
  }

  /** Whether a new session can start there: online, and its mode still in the catalog. */
  acceptsSessions(workspace: Workspace | undefined) {
    return this.workspaceOnline(workspace) && !isReadOnly(workspace);
  }

  /** Add a workspace on a device. Throws with a displayable message on failure. */
  async createWorkspace(input: NewWorkspace) {
    const workspace = await api.createWorkspace(input);
    this.workspaces = [...this.workspaces.filter((item) => item.id !== workspace.id), workspace];
    this.nodes = await api.nodes();
    return workspace;
  }

  /** Release resources held for the page (the event socket). */
  dispose() {
    this.#events?.close();
  }
}

export const engine = new EngineState();
