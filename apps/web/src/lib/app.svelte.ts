/**
 * Session-wide client state: the gateway's workspaces, nodes and sessions, the
 * open session and its event stream, the draft and uploads, and every command
 * the UI sends. Components read it directly instead of receiving it as props.
 */
import { api, connectEvents, type EventConnection } from './api';
import { syncControl } from './control';
import { GOAL_WIDGET, parseGoalWidget } from './goal';
import { fromSnapshot, reduceEvent } from './state';
import { getClientId, loadDraft, saveDraft } from './storage';
import { parseTodoWidget, TODO_WIDGET } from './todo';
import type {
  Attachment,
  ClientSessionState,
  CommandKind,
  ConnectionState,
  InteractionAnswer,
  ModelOption,
  NodeSummary,
  SessionSummary,
  SessionUpdateInput,
  ThinkingLevel,
  Workspace,
} from './types';
import { modelKey } from './types';

export type Upload = Attachment & { preview?: string; uploading?: boolean };

/** Side-panel refresh signals: a `panel_changed` event, or the end of a run. */
export type PanelSignal = { type: 'changed'; sections: string[] } | { type: 'run-finished' };

/** The timeline registers itself so incoming events can keep the newest entry in view. */
export interface Scroller {
  /** True when the reader is at (or near) the bottom. */
  following(): boolean;
  toLatest(smooth?: boolean): Promise<void>;
}

type Demo = typeof import('./mock');

/**
 * A long transcript is rendered from the end: opening a session mounts only
 * the newest `MESSAGE_PAGE` entries (each one parses Markdown synchronously).
 */
export const MESSAGE_PAGE = 60;

const DOCKED_WIDGETS = new Set([TODO_WIDGET, GOAL_WIDGET]);
/**
 * Status-line entries not already shown elsewhere: background tasks and team
 * members live in the jobs menu. Other extension widgets show their header.
 */
const SHOWN_ELSEWHERE = new Set(['background-task', 'agent-team']);

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

class AppState {
  workspaces = $state.raw<Workspace[]>([]);
  nodes = $state.raw<NodeSummary[]>([]);
  sessions = $state.raw<SessionSummary[]>([]);
  models = $state.raw<ModelOption[]>([]);
  activeSessionId = $state<string>();
  connection = $state<ConnectionState>(navigator.onLine ? 'reconnecting' : 'offline');
  draft = $state('');
  uploads = $state.raw<Upload[]>([]);
  loading = $state(true);
  commandBusy = $state(false);
  pageError = $state('');
  /** Offline demo data (dev builds without a gateway). */
  demo = $state.raw<Demo>();
  /** Earliest transcript entries not yet mounted. */
  hiddenMessages = $state(0);
  clientId = '';

  #sessionState = $state.raw<ClientSessionState>();
  #events: EventConnection | undefined;
  #controlSyncing: string | undefined;
  /** Bumped per openSession; a slower, superseded open must not apply its result. */
  #openSeq = 0;
  #snapshotLoading = false;
  #snapshotAgain = false;
  #panelListeners = new Set<(signal: PanelSignal) => void>();
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
  selectedModelOption = $derived(
    this.models.find(
      (model) =>
        model.id === this.#sessionState?.selectedModelId &&
        (!this.#sessionState?.selectedModelProvider ||
          model.provider === this.#sessionState.selectedModelProvider),
    ) ?? this.models[0],
  );
  selectedModel = $derived(this.selectedModelOption ? modelKey(this.selectedModelOption) : '');
  thinking = $derived<ThinkingLevel>(this.#sessionState?.thinkingLevel ?? 'medium');
  todo = $derived(parseTodoWidget(this.#sessionState?.widgets?.[TODO_WIDGET]));
  goal = $derived(parseGoalWidget(this.#sessionState?.widgets?.[GOAL_WIDGET]));
  statusLine = $derived([
    ...Object.entries(this.#sessionState?.widgets ?? {})
      .filter(([key, lines]) => !DOCKED_WIDGETS.has(key) && lines.length)
      .map(([, lines]) => lines[0]!),
    ...Object.entries(this.#sessionState?.statuses ?? {})
      .filter(([key, text]) => !SHOWN_ELSEWHERE.has(key) && text)
      .map(([, text]) => text),
  ]);
  pendingInteractions = $derived(
    this.#sessionState?.interactions.filter((item) => item.status === 'pending') ?? [],
  );
  /** Commands need a live connection and the control lease. */
  canCommand = $derived(this.hasControl && this.connection === 'connected');

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
    try {
      [this.workspaces, this.sessions, this.models, this.nodes] = await Promise.all([
        api.workspaces(),
        api.sessions(),
        api.models(),
        api.nodes(),
      ]);
      this.activeSessionId = this.sessions[0]?.id;
    } catch (error) {
      if (import.meta.env.DEV) {
        const demo = await import('./mock');
        this.demo = demo;
        this.connection = navigator.onLine ? 'connected' : 'offline';
        this.workspaces = demo.demoWorkspaces;
        this.sessions = demo.demoSessions;
        this.models = demo.demoModels;
        this.activeSessionId = demo.demoSnapshot.session.id;
      } else {
        this.pageError = message(error, 'Unable to connect to the gateway.');
      }
    }
    if (this.activeSessionId) await this.openSession(this.activeSessionId);
    this.loading = false;
  }

  /** Refresh the node and workspace lists (they change as devices come and go). */
  async refreshNodes() {
    if (this.demo) return;
    try {
      const [online, available] = await Promise.all([api.nodes(), api.workspaces()]);
      this.nodes = online;
      this.workspaces = available;
    } catch {
      /* keep the last lists */
    }
  }

  async openSession(id: string) {
    const seq = ++this.#openSeq;
    this.activeSessionId = id;
    this.#events?.close();
    this.#events = undefined;
    this.sessionState = undefined;
    this.pageError = '';
    this.draft = loadDraft(id);
    this.uploads = [];
    const demo = this.demo;
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
        void this.loadModels(id);
        void this.refreshControl();
        this.#events = connectEvents({
          sessionId: id,
          cursor: snapshot.cursor,
          onState: (state) => {
            if (seq !== this.#openSeq) return;
            this.connection = state;
            if (state === 'connected') void this.refreshControl();
          },
          onEvent: (event) => {
            const current = this.sessionState;
            if (seq !== this.#openSeq || current?.session.id !== id) return;
            const followLatest = this.scroller?.following() ?? false;
            this.sessionState = reduceEvent(current, event);
            if (event.event.type === 'panel_changed')
              this.#emitPanel({ type: 'changed', sections: event.event.sections });
            if (event.event.type === 'session_renamed') {
              const name = event.event.name;
              this.sessions = this.sessions.map((item) =>
                item.id === id ? { ...item, name } : item,
              );
            }
            if (this.sessionState.needsSnapshot) void this.refreshSnapshot();
            if (followLatest) void this.scroller?.toLatest();
          },
        });
      }
      await this.scroller?.toLatest(false);
    } catch (error) {
      if (seq === this.#openSeq) this.pageError = message(error, 'Unable to load this session.');
    }
  }

  async loadModels(id = this.activeSessionId) {
    try {
      const list = await api.models(id);
      if (this.activeSessionId === id) this.models = list;
    } catch {
      /* keep the previous list; the runner may still be starting */
    }
  }

  /** Reload the open session. Bursts coalesce into one request plus one follow-up. */
  async refreshSnapshot() {
    if (!this.activeSessionId || this.demo) return;
    if (this.#snapshotLoading) {
      this.#snapshotAgain = true;
      return;
    }
    this.#snapshotLoading = true;
    const seq = this.#openSeq;
    try {
      const snapshot = await api.snapshot(this.activeSessionId);
      if (seq !== this.#openSeq) return;
      this.sessionState = fromSnapshot(snapshot);
      const { id, name } = this.sessionState.session;
      this.sessions = this.sessions.map((item) => (item.id === id ? { ...item, name } : item));
    } catch (error) {
      if (seq === this.#openSeq) this.pageError = message(error, 'Could not refresh the session.');
    } finally {
      this.#snapshotLoading = false;
      if (this.#snapshotAgain) {
        this.#snapshotAgain = false;
        if (seq === this.#openSeq) void this.refreshSnapshot();
      }
    }
  }

  /** Rename, pin or settle from the sidebar. Applied at once and rolled back on failure. */
  async updateSession(id: string, input: SessionUpdateInput) {
    const previous = this.sessions.find((item) => item.id === id);
    if (!previous) return;
    const apply = (patch: Partial<SessionSummary>) => {
      this.sessions = this.sessions.map((item) => (item.id === id ? { ...item, ...patch } : item));
      const state = this.sessionState;
      if (state?.session.id === id && patch.name !== undefined)
        this.sessionState = { ...state, session: { ...state.session, name: patch.name } };
    };
    apply(input);
    if (this.demo) return;
    try {
      const updated = await api.updateSession(id, input);
      apply({ name: updated.name, pinned: updated.pinned, settled: updated.settled });
    } catch (error) {
      apply({ name: previous.name, pinned: previous.pinned, settled: previous.settled });
      this.pageError = message(error, 'Could not update the session.');
    }
  }

  setDraft(value: string) {
    this.draft = value;
    if (this.activeSessionId) saveDraft(this.activeSessionId, value);
  }

  async sendCommand(kind: CommandKind, content = this.draft) {
    const state = this.sessionState;
    const sessionId = this.activeSessionId;
    if (!state || !sessionId || !state.control.generation || this.connection !== 'connected')
      return;
    this.commandBusy = true;
    this.pageError = '';
    const attachmentIds = this.uploads.filter((item) => !item.uploading).map((item) => item.id);
    try {
      if (!this.demo) {
        await api.command(sessionId, {
          commandId: crypto.randomUUID(),
          kind,
          controlGeneration: state.control.generation,
          content: content || undefined,
          modelId: this.selectedModelOption?.id,
          provider: this.selectedModelOption?.provider,
          thinkingLevel: this.thinking,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        });
      } else if (kind === 'follow_up') {
        this.sessionState = {
          ...state,
          queue: [
            ...state.queue,
            { id: crypto.randomUUID(), kind, content, createdAt: new Date().toISOString() },
          ],
        };
      } else if (kind === 'prompt' || kind === 'steer') {
        this.sessionState = {
          ...state,
          messages: [
            ...state.messages,
            {
              id: crypto.randomUUID(),
              role: 'user',
              content,
              createdAt: new Date().toISOString(),
              attachments: this.uploads,
            },
          ],
        };
      }
      if (kind === 'prompt' || kind === 'steer' || kind === 'follow_up') {
        this.setDraft('');
        this.uploads = [];
        await this.scroller?.toLatest();
      }
    } catch (error) {
      this.pageError = message(error, 'The command was not accepted.');
    } finally {
      this.commandBusy = false;
    }
  }

  /**
   * Goal dock buttons send `/goal pause|resume`. As a steer it works both idle
   * and mid-run, and it does not open a run record the way a prompt does.
   */
  async goalAction(action: 'pause' | 'resume') {
    const state = this.sessionState;
    const sessionId = this.activeSessionId;
    if (
      this.demo ||
      !state ||
      !sessionId ||
      !state.control.generation ||
      this.connection !== 'connected'
    )
      return;
    this.commandBusy = true;
    this.pageError = '';
    try {
      await api.command(sessionId, {
        commandId: crypto.randomUUID(),
        kind: 'steer',
        controlGeneration: state.control.generation,
        content: `/goal ${action}`,
      });
    } catch (error) {
      this.pageError = message(error, 'The command was not accepted.');
    } finally {
      this.commandBusy = false;
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

  async stopRun() {
    await this.sendCommand('stop', '');
  }

  async clearQueue() {
    await this.sendCommand('clear_queue', '');
    if (this.demo && this.sessionState) this.sessionState = { ...this.sessionState, queue: [] };
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
      this.pageError = message(error, 'Control could not be transferred.');
    }
  }

  async answerInteraction(interactionId: string, answer: InteractionAnswer) {
    const state = this.sessionState;
    if (!this.activeSessionId || !state?.control.generation) return;
    try {
      if (!this.demo)
        await api.answerInteraction(
          this.activeSessionId,
          interactionId,
          answer,
          state.control.generation,
        );
      const current = this.sessionState;
      if (current)
        this.sessionState = {
          ...current,
          interactions: current.interactions.filter((item) => item.id !== interactionId),
        };
    } catch (error) {
      this.pageError = message(error, 'Your answer was not accepted.');
    }
  }

  async uploadImages(files: ArrayLike<File>) {
    // Images are stored on the node that runs the session's agent.
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const localId = `local-${crypto.randomUUID()}`;
      const preview = URL.createObjectURL(file);
      this.uploads = [
        ...this.uploads,
        {
          id: localId,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          preview,
          uploading: true,
        },
      ];
      try {
        const attachment = this.demo
          ? { id: localId, name: file.name, mimeType: file.type, size: file.size }
          : await api.upload(sessionId, file);
        this.uploads = this.uploads.map((item) =>
          item.id === localId ? { ...attachment, preview } : item,
        );
      } catch (error) {
        this.uploads = this.uploads.filter((item) => item.id !== localId);
        URL.revokeObjectURL(preview);
        this.pageError = message(error, `Could not upload ${file.name}.`);
      }
    }
  }

  removeUpload(id: string) {
    const upload = this.uploads.find((item) => item.id === id);
    if (upload?.preview) URL.revokeObjectURL(upload.preview);
    this.uploads = this.uploads.filter((item) => item.id !== id);
  }

  async changeModel(key: string) {
    const model = this.models.find((item) => modelKey(item) === key);
    const state = this.sessionState;
    if (!state || !model) return;
    this.sessionState = {
      ...state,
      selectedModelId: model.id,
      selectedModelProvider: model.provider,
    };
    if (!this.demo && this.activeSessionId && state.control.generation) {
      try {
        await api.command(this.activeSessionId, {
          commandId: crypto.randomUUID(),
          kind: 'set_model',
          controlGeneration: state.control.generation,
          provider: model.provider,
          modelId: model.id,
        });
      } catch (error) {
        this.pageError = message(error, 'Model could not be changed.');
      }
    }
  }

  async changeThinking(level: ThinkingLevel) {
    const state = this.sessionState;
    if (!state) return;
    this.sessionState = { ...state, thinkingLevel: level };
    if (!this.demo && this.activeSessionId && state.control.generation) {
      try {
        await api.command(this.activeSessionId, {
          commandId: crypto.randomUUID(),
          kind: 'set_thinking',
          controlGeneration: state.control.generation,
          thinkingLevel: level,
        });
      } catch (error) {
        this.pageError = message(error, 'Thinking level could not be changed.');
      }
    }
  }

  /** Whether a workspace's device is reachable (local workspaces always are). */
  workspaceOnline(workspace: Workspace | undefined) {
    return (
      !!workspace &&
      (!workspace.id.includes(':') || this.nodes.some((node) => node.id === workspace.hostId))
    );
  }

  /** Add a workspace on a device. Throws with a displayable message on failure. */
  async createWorkspace(input: { nodeId: string; path: string; displayName: string }) {
    const workspace = await api.createWorkspace(input);
    this.workspaces = [...this.workspaces.filter((item) => item.id !== workspace.id), workspace];
    this.nodes = await api.nodes();
    return workspace;
  }

  /** Create a session in a workspace and open it. Returns false when it was not created. */
  async createSession(workspaceId: string): Promise<boolean> {
    const workspace = this.workspaces.find((item) => item.id === workspaceId);
    if (workspace && !this.workspaceOnline(workspace)) {
      this.pageError = `${workspace.displayName} is offline.`;
      return false;
    }
    this.pageError = '';
    try {
      const demo = this.demo;
      const created = demo
        ? {
            id: crypto.randomUUID(),
            workspaceId,
            name: 'New session',
            lastActivityAt: new Date().toISOString(),
            runnerStatus: 'stopped' as const,
            unreadCount: 0,
          }
        : await api.createSession({ workspaceId });
      this.sessions = [created, ...this.sessions];
      if (demo) {
        this.activeSessionId = created.id;
        this.sessionState = fromSnapshot({
          ...demo.demoSnapshot,
          session: created,
          messages: [],
          queue: [],
          run: null,
        });
        this.hiddenMessages = 0;
        this.draft = '';
      } else await this.openSession(created.id);
      return true;
    } catch (error) {
      this.pageError = message(error, 'Could not create the session.');
      return false;
    }
  }

  /** Release resources held for the page (event socket, upload previews). */
  dispose() {
    this.#events?.close();
    this.uploads.forEach((upload) => upload.preview && URL.revokeObjectURL(upload.preview));
  }
}

export const app = new AppState();
