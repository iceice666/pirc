<script lang="ts">
  import {
    Check,
    CircleAlert,
    CloudOff,
    Download,
    MoreHorizontal,
    PanelLeftOpen,
    PanelRightClose,
    PanelRightOpen,
    Plus,
    Radio,
    RefreshCw,
    ShieldCheck,
    Sparkles,
    X,
  } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { api, connectEvents, type EventConnection } from './lib/api';
  import BackendSettings from './lib/components/BackendSettings.svelte';
  import Composer from './lib/components/Composer.svelte';
  import InteractionCard from './lib/components/InteractionCard.svelte';
  import JobsMenu from './lib/components/JobsMenu.svelte';
  import Message from './lib/components/Message.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import SidePanel from './lib/components/panel/SidePanel.svelte';
  import type { PanelTab } from './lib/panel-api';
  import {
    demoModels,
    demoPanelState,
    demoSessions,
    demoSnapshot,
    demoWorkspaces,
  } from './lib/mock';
  import { onFilePreviewRequest } from './lib/file-links';
  import { loadHighlighter } from './lib/markdown';
  import { activateUpdate, registerPwa } from './lib/pwa';
  import { syncControl } from './lib/control';
  import { fromSnapshot, reduceEvent } from './lib/state';
  import { parseTodoWidget, TODO_WIDGET } from './lib/todo';
  import { GOAL_WIDGET, parseGoalWidget } from './lib/goal';
  import { getClientId, loadDraft, loadLayout, saveDraft, saveLayout } from './lib/storage';
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
  } from './lib/types';
  import { modelKey } from './lib/types';

  let workspaces: Workspace[] = $state.raw([]);
  let nodes: NodeSummary[] = $state.raw([]);
  let sessions: SessionSummary[] = $state.raw([]);
  let models: ModelOption[] = $state.raw([]);
  let activeSessionId: string | undefined = $state();
  let sessionState: ClientSessionState | undefined = $state.raw();
  let connection: ConnectionState = $state(navigator.onLine ? 'reconnecting' : 'offline');
  let draft = $state('');
  let uploads: Array<Attachment & { preview?: string; uploading?: boolean }> = $state([]);
  /** Mobile overlay state of the left sidebar. */
  let sidebarOpen = $state(false);
  /** Desktop: left sidebar collapsed out of the grid. */
  let sidebarCollapsed = $state(loadLayout('sidebarCollapsed', false));
  /** Right side panel starts hidden until the user opens it (then the choice is remembered). */
  let detailsOpen = $state(loadLayout('detailsOpen', false));
  const PANEL_MIN = 280;
  const PANEL_DEFAULT = 360;
  /** Room the conversation column keeps when the side panel is dragged wide. */
  const CONVERSATION_MIN = 380;
  let panelWidth = $state(loadLayout('panelWidth', PANEL_DEFAULT));
  /** Sidebar hides settled sessions unless enabled in settings. */
  let showSettled = $state(loadLayout('showSettled', false));
  let panelResizing = $state(false);
  let viewportWidth = $state(window.innerWidth);
  let panelTab: PanelTab = $state('files');
  /** Bumped per `panel_changed` event so the side panel refetches. */
  let panelTick = $state(0);
  let panelChanged: string[] = $state([]);
  /** Bumped when background tasks or team members changed, for the top-bar jobs menu. */
  let jobsTick = $state(0);
  let loading = $state(true);
  let commandBusy = $state(false);
  let pageError = $state('');
  let usingDemo = $state(false);
  let events: EventConnection | undefined;
  let clientId = $state('');
  let settingsOpen = $state(false);
  const SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    { id: 'models', label: 'Models' },
    { id: 'devices', label: 'Devices' },
    { id: 'about', label: 'About' },
  ] as const;
  let settingsTab: (typeof SETTINGS_TABS)[number]['id'] = $state('general');
  let newSessionOpen = $state(false);
  let newSessionWorkspace = $state('');
  let creatingSession = $state(false);
  let newWorkspaceOpen = $state(false);
  let newWorkspaceNodeId = $state('');
  let newWorkspacePath = $state('');
  let newWorkspaceName = $state('');
  let workspaceBusy = $state(false);
  let workspaceError = $state('');
  let updateRegistration: ServiceWorkerRegistration | undefined = $state();
  let timeline: HTMLElement | undefined = $state();
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;

  let activeWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === sessionState?.session.workspaceId),
  );
  let runStatus = $derived(sessionState?.run?.status);
  let hasControl = $derived(sessionState?.control.heldByCurrentClient ?? false);
  let selectedModelOption = $derived(
    models.find(
      (model) =>
        model.id === sessionState?.selectedModelId &&
        (!sessionState?.selectedModelProvider ||
          model.provider === sessionState.selectedModelProvider),
    ) ?? models[0],
  );
  let selectedModel = $derived(selectedModelOption ? modelKey(selectedModelOption) : '');
  let thinking = $derived(sessionState?.thinkingLevel ?? 'medium');
  let panelMax = $derived(
    Math.max(PANEL_MIN, viewportWidth - (sidebarCollapsed ? 0 : 264) - CONVERSATION_MIN),
  );
  let panelShownWidth = $derived(Math.min(Math.max(panelWidth, PANEL_MIN), panelMax));
  $effect(() => saveLayout('sidebarCollapsed', sidebarCollapsed));
  $effect(() => saveLayout('detailsOpen', detailsOpen));
  $effect(() => saveLayout('showSettled', showSettled));

  function resizePanel(width: number) {
    panelWidth = width;
    saveLayout('panelWidth', width);
  }
  let todo = $derived(parseTodoWidget(sessionState?.widgets?.[TODO_WIDGET]));
  let goal = $derived(parseGoalWidget(sessionState?.widgets?.[GOAL_WIDGET]));
  const DOCKED_WIDGETS = new Set([TODO_WIDGET, GOAL_WIDGET]);
  /**
   * Status-line entries not already shown elsewhere: background tasks and team
   * members live in the jobs menu. Other extension widgets show their header.
   */
  const SHOWN_ELSEWHERE = new Set(['background-task', 'agent-team']);
  let statusLine = $derived([
    ...Object.entries(sessionState?.widgets ?? {})
      .filter(([key, lines]) => !DOCKED_WIDGETS.has(key) && lines.length)
      .map(([, lines]) => lines[0]!),
    ...Object.entries(sessionState?.statuses ?? {})
      .filter(([key, text]) => !SHOWN_ELSEWHERE.has(key) && text)
      .map(([, text]) => text),
  ]);
  let pendingInteractions = $derived(
    sessionState?.interactions.filter((item) => item.status === 'pending') ?? [],
  );

  /**
   * A long transcript is rendered from the end: opening a session mounts only
   * the newest `MESSAGE_PAGE` entries (each one parses Markdown synchronously),
   * and scrolling to the top reveals the next page. `hiddenMessages` counts the
   * earliest entries not yet mounted.
   */
  const MESSAGE_PAGE = 60;
  let hiddenMessages = $state(0);
  let revealingEarlier = false;
  let visibleMessages = $derived(
    sessionState
      ? sessionState.messages.slice(Math.min(hiddenMessages, sessionState.messages.length))
      : [],
  );

  async function showEarlier() {
    if (!hiddenMessages || revealingEarlier) return;
    revealingEarlier = true;
    const previousHeight = timeline?.scrollHeight ?? 0;
    const previousTop = timeline?.scrollTop ?? 0;
    hiddenMessages = Math.max(0, hiddenMessages - MESSAGE_PAGE);
    await tick();
    // Keep the entry the reader was looking at in place.
    if (timeline) timeline.scrollTop = previousTop + (timeline.scrollHeight - previousHeight);
    revealingEarlier = false;
  }

  /** Reveal the previous page when the top of the transcript scrolls into view. */
  function revealEarlier(node: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void showEarlier();
      },
      { root: node.closest('.timeline'), rootMargin: '200px 0px 0px' },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  onMount(() => {
    clientId = getClientId();
    const removePwa = registerPwa((registration) => (updateRegistration = registration));
    void bootstrap();
    // A file link in the conversation previews the file in the side panel.
    const removeFileLinks = onFilePreviewRequest(() => (detailsOpen = true));
    // Code blocks are common; fetch the highlighter once the first paint is done.
    // KaTeX is rarer and loads on first use instead.
    const warm = () => void loadHighlighter();
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1000);
    leaseHeartbeat = setInterval(() => void refreshControl(), 10_000);
    // Background tabs and suspended mobile pages skip heartbeats; catch up at once.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshControl();
    };
    const onOnline = () => void refreshControl();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const nodeRefresh = setInterval(() => {
      if (!usingDemo)
        void Promise.all([api.nodes(), api.workspaces()])
          .then(([online, available]) => {
            nodes = online;
            workspaces = available;
          })
          .catch(() => undefined);
    }, 15_000);
    return () => {
      clearInterval(nodeRefresh);
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      events?.close();
      removePwa();
      removeFileLinks();
      uploads.forEach((upload) => upload.preview && URL.revokeObjectURL(upload.preview));
    };
  });

  async function bootstrap() {
    loading = true;
    try {
      [workspaces, sessions, models, nodes] = await Promise.all([
        api.workspaces(),
        api.sessions(),
        api.models(),
        api.nodes(),
      ]);
      activeSessionId = sessions[0]?.id;
    } catch (error) {
      if (import.meta.env.DEV) {
        usingDemo = true;
        connection = navigator.onLine ? 'connected' : 'offline';
        workspaces = demoWorkspaces;
        sessions = demoSessions;
        models = demoModels;
        activeSessionId = demoSnapshot.session.id;
      } else {
        pageError = error instanceof Error ? error.message : 'Unable to connect to the gateway.';
      }
    }
    if (activeSessionId) await openSession(activeSessionId);
    loading = false;
  }

  async function openSession(id: string) {
    activeSessionId = id;
    sidebarOpen = false;
    events?.close();
    sessionState = undefined;
    pageError = '';
    draft = loadDraft(id);
    uploads = [];
    try {
      const snapshot = usingDemo
        ? {
            ...demoSnapshot,
            session: sessions.find((item) => item.id === id) ?? demoSnapshot.session,
          }
        : await api.snapshot(id);
      sessionState = fromSnapshot(snapshot);
      hiddenMessages = Math.max(0, sessionState.messages.length - MESSAGE_PAGE);
      if (!usingDemo) void loadModels(id);
      if (!usingDemo) void refreshControl();
      if (!usingDemo) {
        events = connectEvents({
          sessionId: id,
          cursor: snapshot.cursor,
          onState: (state) => {
            connection = state;
            if (state === 'connected') void refreshControl();
          },
          onEvent: (event) => {
            if (!sessionState) return;
            const followLatest =
              !!timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
            sessionState = reduceEvent(sessionState, event);
            if (event.event.type === 'panel_changed') {
              panelChanged = event.event.sections;
              panelTick++;
              if (panelChanged.some((section) => section === 'background' || section === 'team'))
                jobsTick++;
            }
            if (event.event.type === 'session_renamed') {
              const name = event.event.name;
              sessions = sessions.map((item) => (item.id === id ? { ...item, name } : item));
            }
            if (sessionState.needsSnapshot) void refreshSnapshot();
            if (followLatest) void scrollToLatest();
          },
        });
      }
      await scrollToLatest(false);
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Unable to load this session.';
    }
  }

  async function loadModels(id = activeSessionId) {
    try {
      const list = await api.models(id);
      if (activeSessionId === id) models = list;
    } catch {
      /* keep the previous list; the runner may still be starting */
    }
  }

  async function refreshSnapshot() {
    if (!activeSessionId || usingDemo) return;
    try {
      sessionState = fromSnapshot(await api.snapshot(activeSessionId));
      const { id, name } = sessionState.session;
      sessions = sessions.map((item) => (item.id === id ? { ...item, name } : item));
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Could not refresh the session.';
    }
  }

  /** Rename, pin or settle from the sidebar. Applied at once and rolled back on failure. */
  async function updateSession(id: string, input: SessionUpdateInput) {
    const previous = sessions.find((item) => item.id === id);
    if (!previous) return;
    const apply = (patch: Partial<SessionSummary>) => {
      sessions = sessions.map((item) => (item.id === id ? { ...item, ...patch } : item));
      if (sessionState?.session.id === id && patch.name !== undefined)
        sessionState = { ...sessionState, session: { ...sessionState.session, name: patch.name } };
    };
    apply(input);
    if (usingDemo) return;
    try {
      const updated = await api.updateSession(id, input);
      apply({ name: updated.name, pinned: updated.pinned, settled: updated.settled });
    } catch (error) {
      apply({ name: previous.name, pinned: previous.pinned, settled: previous.settled });
      pageError = error instanceof Error ? error.message : 'Could not update the session.';
    }
  }

  async function scrollToLatest(smooth = true) {
    await tick();
    timeline?.scrollTo({ top: timeline.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function setDraft(value: string) {
    draft = value;
    if (activeSessionId) saveDraft(activeSessionId, value);
  }

  async function sendCommand(kind: CommandKind, content = draft) {
    if (
      !sessionState ||
      !activeSessionId ||
      !sessionState.control.generation ||
      connection !== 'connected'
    )
      return;
    commandBusy = true;
    pageError = '';
    const attachmentIds = uploads.filter((item) => !item.uploading).map((item) => item.id);
    try {
      if (!usingDemo) {
        await api.command(activeSessionId, {
          commandId: crypto.randomUUID(),
          kind,
          controlGeneration: sessionState.control.generation,
          content: content || undefined,
          modelId: selectedModelOption?.id,
          provider: selectedModelOption?.provider,
          thinkingLevel: thinking,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        });
      } else if (kind === 'prompt' || kind === 'steer' || kind === 'follow_up') {
        if (kind === 'follow_up') {
          sessionState = {
            ...sessionState,
            queue: [
              ...sessionState.queue,
              { id: crypto.randomUUID(), kind, content, createdAt: new Date().toISOString() },
            ],
          };
        } else {
          sessionState = {
            ...sessionState,
            messages: [
              ...sessionState.messages,
              {
                id: crypto.randomUUID(),
                role: 'user',
                content,
                createdAt: new Date().toISOString(),
                attachments: uploads,
              },
            ],
          };
        }
      }
      if (kind === 'prompt' || kind === 'steer' || kind === 'follow_up') {
        setDraft('');
        uploads = [];
        await scrollToLatest();
      }
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'The command was not accepted.';
    } finally {
      commandBusy = false;
    }
  }

  /**
   * Goal dock buttons send `/goal pause|resume`. As a steer it works both idle
   * and mid-run, and it does not open a run record the way a prompt does.
   */
  async function goalAction(action: 'pause' | 'resume') {
    if (
      usingDemo ||
      !sessionState ||
      !activeSessionId ||
      !sessionState.control.generation ||
      connection !== 'connected'
    )
      return;
    commandBusy = true;
    pageError = '';
    try {
      await api.command(activeSessionId, {
        commandId: crypto.randomUUID(),
        kind: 'steer',
        controlGeneration: sessionState.control.generation,
        content: `/goal ${action}`,
      });
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'The command was not accepted.';
    } finally {
      commandBusy = false;
    }
  }

  let controlSyncing: string | undefined;
  /** Renew this client's lease, or pick control back up if nobody holds a live one. */
  async function refreshControl() {
    const id = activeSessionId;
    if (usingDemo || !id || !sessionState || controlSyncing === id) return;
    controlSyncing = id;
    try {
      const control = await syncControl(api, id, sessionState.control, {
        // A hidden tab only keeps what it has; it never grabs control.
        mayAcquire: document.visibilityState === 'visible',
      });
      if (control && sessionState && activeSessionId === id)
        sessionState = { ...sessionState, control };
    } finally {
      if (controlSyncing === id) controlSyncing = undefined;
    }
  }

  async function stopRun() {
    await sendCommand('stop', '');
  }

  async function clearQueue() {
    await sendCommand('clear_queue', '');
    if (usingDemo && sessionState) sessionState = { ...sessionState, queue: [] };
  }

  async function takeControl() {
    if (!activeSessionId || !sessionState) return;
    try {
      const control = usingDemo
        ? {
            heldByCurrentClient: true,
            holderName: 'This browser',
            generation: (sessionState.control.generation ?? 0) + 1,
          }
        : await api.takeControl(activeSessionId, clientId);
      sessionState = { ...sessionState, control };
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Control could not be transferred.';
    }
  }

  async function answerInteraction(interactionId: string, answer: InteractionAnswer) {
    if (!activeSessionId || !sessionState?.control.generation) return;
    try {
      if (!usingDemo)
        await api.answerInteraction(
          activeSessionId,
          interactionId,
          answer,
          sessionState.control.generation,
        );
      sessionState = {
        ...sessionState,
        interactions: sessionState.interactions.filter((item) => item.id !== interactionId),
      };
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Your answer was not accepted.';
    }
  }

  async function uploadImages(files: FileList) {
    // Images are stored on the node that runs the session's agent.
    const sessionId = activeSessionId;
    if (!sessionId) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const localId = `local-${crypto.randomUUID()}`;
      const preview = URL.createObjectURL(file);
      uploads = [
        ...uploads,
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
        const attachment = usingDemo
          ? { id: localId, name: file.name, mimeType: file.type, size: file.size }
          : await api.upload(sessionId, file);
        uploads = uploads.map((item) => (item.id === localId ? { ...attachment, preview } : item));
      } catch (error) {
        uploads = uploads.filter((item) => item.id !== localId);
        URL.revokeObjectURL(preview);
        pageError = error instanceof Error ? error.message : `Could not upload ${file.name}.`;
      }
    }
  }

  function removeUpload(id: string) {
    const upload = uploads.find((item) => item.id === id);
    if (upload?.preview) URL.revokeObjectURL(upload.preview);
    uploads = uploads.filter((item) => item.id !== id);
  }

  async function changeModel(key: string) {
    const model = models.find((item) => modelKey(item) === key);
    if (!sessionState || !model) return;
    sessionState = {
      ...sessionState,
      selectedModelId: model.id,
      selectedModelProvider: model.provider,
    };
    if (!usingDemo && activeSessionId && model && sessionState.control.generation) {
      try {
        await api.command(activeSessionId, {
          commandId: crypto.randomUUID(),
          kind: 'set_model',
          controlGeneration: sessionState.control.generation,
          provider: model.provider,
          modelId: model.id,
        });
      } catch (error) {
        pageError = error instanceof Error ? error.message : 'Model could not be changed.';
      }
    }
  }

  async function changeThinking(level: ThinkingLevel) {
    if (!sessionState) return;
    sessionState = { ...sessionState, thinkingLevel: level };
    if (!usingDemo && activeSessionId && sessionState.control.generation) {
      try {
        await api.command(activeSessionId, {
          commandId: crypto.randomUUID(),
          kind: 'set_thinking',
          controlGeneration: sessionState.control.generation,
          thinkingLevel: level,
        });
      } catch (error) {
        pageError = error instanceof Error ? error.message : 'Thinking level could not be changed.';
      }
    }
  }

  function resetLayout() {
    sidebarCollapsed = false;
    detailsOpen = false;
    resizePanel(PANEL_DEFAULT);
  }

  function showNewWorkspace(nodeId: string) {
    newWorkspaceNodeId = nodeId;
    newWorkspacePath = '';
    newWorkspaceName = '';
    workspaceError = '';
    newWorkspaceOpen = true;
    sidebarOpen = false;
  }

  async function createWorkspace() {
    if (
      !newWorkspaceNodeId ||
      !newWorkspacePath.trim() ||
      !newWorkspaceName.trim() ||
      workspaceBusy
    )
      return;
    workspaceBusy = true;
    workspaceError = '';
    try {
      const workspace = await api.createWorkspace({
        nodeId: newWorkspaceNodeId,
        path: newWorkspacePath.trim(),
        displayName: newWorkspaceName.trim(),
      });
      workspaces = [...workspaces.filter((item) => item.id !== workspace.id), workspace];
      nodes = await api.nodes();
      newWorkspaceOpen = false;
      showNewSession(workspace.id);
    } catch (error) {
      workspaceError = error instanceof Error ? error.message : 'Could not add workspace.';
    } finally {
      workspaceBusy = false;
    }
  }

  /** With a workspace (its `+` button, or one just added) the session is created right away. */
  function showNewSession(workspaceId?: string) {
    if (workspaceId) {
      newSessionWorkspace = workspaceId;
      void createSession();
      return;
    }
    newSessionWorkspace =
      workspaces.find(
        (workspace) =>
          !workspace.id.includes(':') || nodes.some((node) => node.id === workspace.hostId),
      )?.id ?? '';
    newSessionOpen = true;
  }

  async function createSession() {
    if (!newSessionWorkspace || creatingSession) return;
    const workspace = workspaces.find((item) => item.id === newSessionWorkspace);
    if (workspace?.id.includes(':') && !nodes.some((node) => node.id === workspace.hostId)) {
      pageError = `${workspace.displayName} is offline.`;
      return;
    }
    creatingSession = true;
    pageError = '';
    try {
      const created = usingDemo
        ? {
            id: crypto.randomUUID(),
            workspaceId: newSessionWorkspace,
            name: 'New session',
            lastActivityAt: new Date().toISOString(),
            runnerStatus: 'stopped' as const,
            unreadCount: 0,
          }
        : await api.createSession({ workspaceId: newSessionWorkspace });
      sessions = [created, ...sessions];
      newSessionOpen = false;
      if (usingDemo) {
        activeSessionId = created.id;
        sessionState = fromSnapshot({
          ...demoSnapshot,
          session: created,
          messages: [],
          queue: [],
          run: null,
        });
        draft = '';
      } else await openSession(created.id);
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Could not create the session.';
    } finally {
      creatingSession = false;
    }
  }
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  onkeydown={(event) => event.key === 'Escape' && sidebarOpen && (sidebarOpen = false)}
/>

<svelte:head
  ><title>{sessionState ? `${sessionState.session.name} · pirc` : 'pirc'}</title></svelte:head
>

<div
  class="app-shell"
  class:sidebar-collapsed={sidebarCollapsed}
  class:resizing={panelResizing}
  style:--panel-width="{panelShownWidth}px"
>
  <Sidebar
    {workspaces}
    {nodes}
    {sessions}
    {activeSessionId}
    bind:open={sidebarOpen}
    collapsed={sidebarCollapsed}
    oncollapse={() => (sidebarCollapsed = true)}
    onselect={openSession}
    onnew={showNewSession}
    onaddworkspace={showNewWorkspace}
    onclose={() => (sidebarOpen = false)}
    onrename={(id, name) => updateSession(id, { name })}
    onpin={(id, pinned) => updateSession(id, { pinned })}
    onsettle={(id, settled) => updateSession(id, { settled })}
    {showSettled}
    onsettings={() => {
      settingsOpen = true;
      sidebarOpen = false;
    }}
  />

  <main class:details-collapsed={!detailsOpen} class="workspace">
    {#if loading}
      <div class="loading-state">
        <span class="large-mark"><Sparkles size={24} /></span>
        <p>Connecting to your sessions…</p>
      </div>
    {:else if sessionState}
      <header class="topbar">
        {#if sidebarCollapsed}
          <button
            class="sidebar-expand icon-button"
            type="button"
            aria-label="Show sidebar"
            title="Show sidebar"
            transition:fade={{ duration: 160 }}
            onclick={() => (sidebarCollapsed = false)}><PanelLeftOpen size={19} /></button
          >
        {/if}
        <div class="title-block">
          <div class="breadcrumb">
            <span>{activeWorkspace?.displayName ?? 'Workspace'}</span><span>/</span><span
              >{sessionState.session.name}</span
            >
          </div>
          <h1>{sessionState.session.name}</h1>
        </div>
        <div class="topbar-actions">
          <JobsMenu
            sessionId={sessionState.session.id}
            {hasControl}
            generation={sessionState.control.generation}
            refreshKey={jobsTick}
            demo={usingDemo ? demoPanelState : undefined}
          />
          <span
            class:offline={connection === 'offline'}
            class:reconnecting={connection === 'reconnecting'}
            class="connection-pill"
          >
            {#if connection === 'connected'}<Radio size={13} /> Live{:else if connection === 'offline'}<CloudOff
                size={13}
              /> Offline{:else}<RefreshCw class="spin" size={13} /> Reconnecting{/if}
          </span>
          {#if !hasControl}
            <button class="button takeover" type="button" onclick={takeControl}
              ><ShieldCheck size={15} /> Take control</button
            >
          {:else}
            <span class="control-pill"><ShieldCheck size={14} /> In control</span>
          {/if}
          <button
            class="icon-button details-toggle"
            type="button"
            aria-label={detailsOpen ? 'Hide side panel' : 'Show side panel'}
            title={detailsOpen ? 'Hide side panel' : 'Show side panel'}
            onclick={() => (detailsOpen = !detailsOpen)}
          >
            {#if detailsOpen}<PanelRightClose size={19} />{:else}<PanelRightOpen size={19} />{/if}
          </button>
          <button class="icon-button session-menu" type="button" aria-label="Session menu"
            ><MoreHorizontal size={20} /></button
          >
        </div>
      </header>

      {#if pageError}
        <div class="error-banner" role="alert">
          <CircleAlert size={16} /><span>{pageError}</span><button
            type="button"
            aria-label="Dismiss error"
            onclick={() => (pageError = '')}><X size={15} /></button
          >
        </div>
      {/if}
      {#if !hasControl}
        <div class="viewer-banner">
          <span
            >You’re viewing this session. {sessionState.control.holderName ?? 'Another device'} currently
            has control.</span
          ><button type="button" onclick={takeControl}>Take control</button>
        </div>
      {/if}

      <div class="content-grid">
        <section class="conversation" aria-label="Conversation">
          <div class="timeline" bind:this={timeline} aria-live="polite">
            <div class="timeline-inner">
              {#if hiddenMessages > 0}
                <button
                  type="button"
                  class="earlier-messages"
                  use:revealEarlier
                  onclick={showEarlier}
                >
                  Show earlier messages ({hiddenMessages} more)
                </button>
              {/if}
              {#each visibleMessages as message (message.id)}<Message {message} />{/each}
              {#each pendingInteractions as interaction (interaction.id)}
                <InteractionCard
                  {interaction}
                  disabled={!hasControl || connection !== 'connected'}
                  onanswer={(answer) => answerInteraction(interaction.id, answer)}
                />
              {/each}
              {#if sessionState.messages.length === 0}
                <div class="empty-conversation">
                  <span><Plus size={24} /></span>
                  <h2>Start something useful</h2>
                  <p>
                    Describe a task, attach a reference image, or ask the agent to continue work in
                    this workspace.
                  </p>
                </div>
              {/if}
            </div>
          </div>
          <Composer
            {goal}
            ongoal={goalAction}
            {todo}
            statuses={statusLine}
            value={draft}
            {connection}
            {runStatus}
            {hasControl}
            {models}
            modelId={selectedModel}
            {thinking}
            attachments={uploads}
            queue={sessionState.queue}
            busy={commandBusy}
            onvalue={setDraft}
            onsubmit={sendCommand}
            onupload={uploadImages}
            onremove={removeUpload}
            onmodel={changeModel}
            onthinking={changeThinking}
            onstop={stopRun}
            onclear={clearQueue}
          />
        </section>

        <SidePanel
          open={detailsOpen}
          bind:tab={panelTab}
          bind:resizing={panelResizing}
          {sessionState}
          {runStatus}
          {hasControl}
          {usingDemo}
          changeTick={panelTick}
          changed={panelChanged}
          width={panelShownWidth}
          minWidth={PANEL_MIN}
          maxWidth={panelMax}
          defaultWidth={PANEL_DEFAULT}
          onresize={resizePanel}
        />
      </div>
    {:else}
      <div class="loading-state">
        <CircleAlert size={24} />
        <p>No session could be loaded.</p>
      </div>
    {/if}
  </main>
</div>

{#if settingsOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => event.target === event.currentTarget && (settingsOpen = false)}
    onkeydown={(event) => event.key === 'Escape' && (settingsOpen = false)}
  >
    <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header>
        <div>
          <span class="eyebrow">pirc</span>
          <h2 id="settings-title">Settings</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          onclick={() => (settingsOpen = false)}><X size={19} /></button
        >
      </header>

      <div class="settings-layout">
        <div
          class="settings-nav"
          role="tablist"
          aria-label="Settings categories"
          aria-orientation="vertical"
        >
          {#each SETTINGS_TABS as tab (tab.id)}
            <button
              type="button"
              role="tab"
              id="settings-tab-{tab.id}"
              aria-controls="settings-panel-{tab.id}"
              aria-selected={settingsTab === tab.id}
              class:chosen={settingsTab === tab.id}
              onclick={() => (settingsTab = tab.id)}>{tab.label}</button
            >
          {/each}
        </div>

        <div class="settings-panels">
          <!-- Panels stay mounted so switching tabs never cancels an in-flight provider login. -->
          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            hidden={settingsTab !== 'general'}
          >
            <section class="settings-section">
              <h3>Sidebar</h3>
              <label class="settings-toggle">
                <span>Show settled sessions</span>
                <input type="checkbox" bind:checked={showSettled} />
              </label>
              <p>Settled sessions are hidden from the sidebar unless this is on.</p>
            </section>

            <section class="settings-section">
              <h3>Layout</h3>
              <div class="settings-row">
                <span>Restore the sidebar and side panel to their default size and visibility.</span
                >
                <button class="button ghost" type="button" onclick={resetLayout}>Reset</button>
              </div>
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-models"
            aria-labelledby="settings-tab-models"
            hidden={settingsTab !== 'models'}
          >
            <BackendSettings disabled={usingDemo} onchanged={() => loadModels()} />
          </div>

          <div
            role="tabpanel"
            id="settings-panel-devices"
            aria-labelledby="settings-tab-devices"
            hidden={settingsTab !== 'devices'}
          >
            <section class="settings-section">
              <h3>Devices</h3>
              {#if nodes.length}
                <ul class="settings-devices">
                  {#each nodes as node (node.id)}
                    <li>
                      <span class="online-dot"></span>
                      <strong>{node.id}</strong>
                      <small
                        >{node.workspaces.length} workspace{node.workspaces.length === 1
                          ? ''
                          : 's'}</small
                      >
                    </li>
                  {/each}
                </ul>
              {:else}
                <p>No devices online.</p>
              {/if}
              <p>{nodes.length} online</p>
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-about"
            aria-labelledby="settings-tab-about"
            hidden={settingsTab !== 'about'}
          >
            <section class="settings-section">
              <h3>This browser</h3>
              <div class="settings-row">
                <span>Client ID</span>
                <code>{clientId}</code>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if newWorkspaceOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => event.target === event.currentTarget && (newWorkspaceOpen = false)}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-workspace-title">
      <header>
        <div>
          <span class="eyebrow">On a device</span>
          <h2 id="new-workspace-title">Add workspace</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          onclick={() => (newWorkspaceOpen = false)}><X size={19} /></button
        >
      </header>
      <label
        ><span>Device</span><select bind:value={newWorkspaceNodeId}
          >{#each nodes as node}<option value={node.id}>{node.id}</option>{/each}</select
        ></label
      >
      <label
        ><span>Workspace name</span><input
          bind:value={newWorkspaceName}
          placeholder="My project"
        /></label
      >
      <label
        ><span>Existing directory on that device</span><input
          bind:value={newWorkspacePath}
          placeholder="~/projects/my-project"
          onkeydown={(event) => event.key === 'Enter' && createWorkspace()}
        /></label
      >
      <p>
        Choose an existing folder inside that device's home directory. No files or folders will be
        created.
      </p>
      {#if workspaceError}<p role="alert">{workspaceError}</p>{/if}
      <footer>
        <button class="button ghost" type="button" onclick={() => (newWorkspaceOpen = false)}
          >Cancel</button
        >
        <button
          class="button dark"
          type="button"
          disabled={workspaceBusy ||
            !newWorkspaceNodeId ||
            !newWorkspaceName.trim() ||
            !newWorkspacePath.trim()}
          onclick={createWorkspace}>{workspaceBusy ? 'Adding…' : 'Add workspace'}</button
        >
      </footer>
    </div>
  </div>
{/if}

{#if newSessionOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => event.target === event.currentTarget && (newSessionOpen = false)}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
      <header>
        <div>
          <span class="eyebrow">New work</span>
          <h2 id="new-session-title">Create a session</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          onclick={() => (newSessionOpen = false)}><X size={19} /></button
        >
      </header>
      <label
        ><span>Workspace</span><select bind:value={newSessionWorkspace}
          >{#each workspaces as workspace}<option
              value={workspace.id}
              disabled={workspace.id.includes(':') &&
                !nodes.some((node) => node.id === workspace.hostId)}
              >{workspace.displayName} · {workspace.hostId}{workspace.id.includes(':') &&
              !nodes.some((node) => node.id === workspace.hostId)
                ? ' (offline)'
                : ''}</option
            >{/each}</select
        ></label
      >
      <p>
        The session is named from your first message and stays active on the host when this browser
        disconnects.
      </p>
      <footer>
        <button class="button ghost" type="button" onclick={() => (newSessionOpen = false)}
          >Cancel</button
        ><button
          class="button dark"
          type="button"
          onclick={createSession}
          disabled={creatingSession ||
            !newSessionWorkspace ||
            (newSessionWorkspace.includes(':') &&
              !nodes.some(
                (node) =>
                  node.id ===
                  workspaces.find((workspace) => workspace.id === newSessionWorkspace)?.hostId,
              ))}>Create session</button
        >
      </footer>
    </div>
  </div>
{/if}

{#if updateRegistration}
  <div class="update-toast" role="status">
    <Download size={18} />
    <div><strong>Update ready</strong><span>Apply it when your draft is safe.</span></div>
    <button
      type="button"
      onclick={() => {
        activateUpdate(updateRegistration!);
        updateRegistration = undefined;
      }}>Update</button
    ><button
      type="button"
      aria-label="Dismiss update"
      onclick={() => (updateRegistration = undefined)}><X size={15} /></button
    >
  </div>
{/if}
