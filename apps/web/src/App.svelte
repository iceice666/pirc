<script lang="ts">
  import {
    Check,
    CircleAlert,
    CloudOff,
    Download,
    MoreHorizontal,
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
  import { api, connectEvents, type EventConnection } from './lib/api';
  import Composer from './lib/components/Composer.svelte';
  import InteractionCard from './lib/components/InteractionCard.svelte';
  import WidgetPanel from './lib/components/WidgetPanel.svelte';
  import Message from './lib/components/Message.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import SidePanel from './lib/components/panel/SidePanel.svelte';
  import type { PanelTab } from './lib/panel-api';
  import { demoModels, demoSessions, demoSnapshot, demoWorkspaces } from './lib/mock';
  import { activateUpdate, registerPwa } from './lib/pwa';
  import { fromSnapshot, reduceEvent } from './lib/state';
  import { getClientId, loadDraft, saveDraft } from './lib/storage';
  import type {
    Attachment,
    ClientSessionState,
    CommandKind,
    ConnectionState,
    InteractionAnswer,
    ModelOption,
    NodeSummary,
    SessionSummary,
    ThinkingLevel,
    Workspace,
  } from './lib/types';

  let workspaces: Workspace[] = [];
  let nodes: NodeSummary[] = [];
  let sessions: SessionSummary[] = [];
  let models: ModelOption[] = [];
  let activeSessionId: string | undefined;
  let sessionState: ClientSessionState | undefined;
  let connection: ConnectionState = navigator.onLine ? 'reconnecting' : 'offline';
  let draft = '';
  let uploads: Array<Attachment & { preview?: string; uploading?: boolean }> = [];
  let sidebarOpen = false;
  let detailsOpen = true;
  let panelWide = false;
  let panelTab: PanelTab = 'overview';
  /** Bumped per `panel_changed` event so the side panel refetches. */
  let panelTick = 0;
  let panelChanged: string[] = [];
  let loading = true;
  let commandBusy = false;
  let pageError = '';
  let usingDemo = false;
  let events: EventConnection | undefined;
  let clientId = '';
  let newSessionOpen = false;
  let newSessionWorkspace = '';
  let creatingSession = false;
  let newWorkspaceOpen = false;
  let newWorkspaceNodeId = '';
  let newWorkspacePath = '';
  let newWorkspaceName = '';
  let workspaceBusy = false;
  let workspaceError = '';
  let updateRegistration: ServiceWorkerRegistration | undefined;
  let timeline: HTMLElement;
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;

  $: activeWorkspace = workspaces.find(
    (workspace) => workspace.id === sessionState?.session.workspaceId,
  );
  $: runStatus = sessionState?.run?.status;
  $: hasControl = sessionState?.control.heldByCurrentClient ?? false;
  $: selectedModel = sessionState?.selectedModelId ?? models[0]?.id ?? '';
  $: thinking = sessionState?.thinkingLevel ?? 'medium';
  $: pendingInteractions =
    sessionState?.interactions.filter((item) => item.status === 'pending') ?? [];

  onMount(() => {
    clientId = getClientId();
    const removePwa = registerPwa((registration) => (updateRegistration = registration));
    void bootstrap();
    leaseHeartbeat = setInterval(() => {
      if (
        !usingDemo &&
        activeSessionId &&
        sessionState?.control.heldByCurrentClient &&
        sessionState.control.generation &&
        connection === 'connected'
      ) {
        void api
          .heartbeatControl(activeSessionId, sessionState.control.generation)
          .then((control) => {
            if (sessionState) sessionState = { ...sessionState, control };
          })
          .catch(() => {
            if (sessionState)
              sessionState = {
                ...sessionState,
                control: { ...sessionState.control, heldByCurrentClient: false },
              };
          });
      }
    }, 10_000);
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
      events?.close();
      removePwa();
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
      if (!usingDemo) void loadModels(id);
      if (!usingDemo) {
        events = connectEvents({
          sessionId: id,
          cursor: snapshot.cursor,
          onState: (state) => (connection = state),
          onEvent: (event) => {
            if (!sessionState) return;
            const followLatest =
              !!timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
            sessionState = reduceEvent(sessionState, event);
            if (event.event.type === 'panel_changed') {
              panelChanged = event.event.sections;
              panelTick++;
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

  async function loadModels(id: string) {
    try {
      const list = await api.models(id);
      if (activeSessionId === id && list.length) models = list;
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
          modelId: selectedModel || undefined,
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
          : await api.upload(file);
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

  async function changeModel(id: string) {
    if (!sessionState) return;
    sessionState = { ...sessionState, selectedModelId: id };
    const model = models.find((item) => item.id === id);
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

  function formatDuration(start?: string) {
    if (!start) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
</script>

<svelte:head
  ><title>{sessionState ? `${sessionState.session.name} · Relay` : 'Relay · Pi Remote'}</title
  ></svelte:head
>

<div class="app-shell">
  <Sidebar
    {workspaces}
    {nodes}
    {sessions}
    {activeSessionId}
    open={sidebarOpen}
    onselect={openSession}
    onnew={showNewSession}
    onaddworkspace={showNewWorkspace}
    onclose={() => (sidebarOpen = false)}
  />

  <main
    class:details-collapsed={!detailsOpen}
    class:details-wide={detailsOpen && panelWide}
    class="workspace"
  >
    {#if loading}
      <div class="loading-state">
        <span class="large-mark"><Sparkles size={24} /></span>
        <p>Connecting to your sessions…</p>
      </div>
    {:else if sessionState}
      <header class="topbar">
        <div class="title-block">
          <div class="breadcrumb">
            <span>{activeWorkspace?.displayName ?? 'Workspace'}</span><span>/</span><span
              >{sessionState.session.name}</span
            >
          </div>
          <h1>{sessionState.session.name}</h1>
        </div>
        <div class="topbar-actions">
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
            <button class="button takeover" type="button" on:click={takeControl}
              ><ShieldCheck size={15} /> Take control</button
            >
          {:else}
            <span class="control-pill"><ShieldCheck size={14} /> In control</span>
          {/if}
          <button
            class="icon-button details-toggle"
            type="button"
            aria-label={detailsOpen ? 'Hide session details' : 'Show session details'}
            on:click={() => (detailsOpen = !detailsOpen)}
          >
            {#if detailsOpen}<PanelRightClose size={19} />{:else}<PanelRightOpen size={19} />{/if}
          </button>
          <button class="icon-button" type="button" aria-label="Session menu"
            ><MoreHorizontal size={20} /></button
          >
        </div>
      </header>

      {#if pageError}
        <div class="error-banner" role="alert">
          <CircleAlert size={16} /><span>{pageError}</span><button
            type="button"
            aria-label="Dismiss error"
            on:click={() => (pageError = '')}><X size={15} /></button
          >
        </div>
      {/if}
      {#if !hasControl}
        <div class="viewer-banner">
          <span
            >You’re viewing this session. {sessionState.control.holderName ?? 'Another device'} currently
            has control.</span
          ><button type="button" on:click={takeControl}>Take control</button>
        </div>
      {/if}

      <div class="content-grid">
        <section class="conversation" aria-label="Conversation">
          <div class="timeline" bind:this={timeline} aria-live="polite">
            <div class="timeline-inner">
              {#each sessionState.messages as message (message.id)}<Message {message} />{/each}
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
                    Describe a task, attach a reference image, or ask Pi to continue work in this
                    workspace.
                  </p>
                </div>
              {/if}
            </div>
          </div>
          <WidgetPanel
            widgets={sessionState.widgets ?? {}}
            statuses={sessionState.statuses ?? {}}
          />
          <Composer
            value={draft}
            {connection}
            {runStatus}
            {hasControl}
            {models}
            modelId={selectedModel}
            {thinking}
            attachments={uploads}
            queueCount={sessionState.queue.length}
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
          bind:wide={panelWide}
          bind:tab={panelTab}
          {sessionState}
          {runStatus}
          {hasControl}
          {models}
          {selectedModel}
          {thinking}
          {activeWorkspace}
          {usingDemo}
          changeTick={panelTick}
          changed={panelChanged}
          {formatDuration}
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

{#if newWorkspaceOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    on:click={(event) => event.target === event.currentTarget && (newWorkspaceOpen = false)}
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
          on:click={() => (newWorkspaceOpen = false)}><X size={19} /></button
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
          on:keydown={(event) => event.key === 'Enter' && createWorkspace()}
        /></label
      >
      <p>
        Choose an existing folder inside that device's home directory. No files or folders will be
        created.
      </p>
      {#if workspaceError}<p role="alert">{workspaceError}</p>{/if}
      <footer>
        <button class="button ghost" type="button" on:click={() => (newWorkspaceOpen = false)}
          >Cancel</button
        >
        <button
          class="button dark"
          type="button"
          disabled={workspaceBusy ||
            !newWorkspaceNodeId ||
            !newWorkspaceName.trim() ||
            !newWorkspacePath.trim()}
          on:click={createWorkspace}>{workspaceBusy ? 'Adding…' : 'Add workspace'}</button
        >
      </footer>
    </div>
  </div>
{/if}

{#if newSessionOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    on:click={(event) => event.target === event.currentTarget && (newSessionOpen = false)}
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
          on:click={() => (newSessionOpen = false)}><X size={19} /></button
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
        <button class="button ghost" type="button" on:click={() => (newSessionOpen = false)}
          >Cancel</button
        ><button
          class="button dark"
          type="button"
          on:click={createSession}
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
      on:click={() => {
        activateUpdate(updateRegistration!);
        updateRegistration = undefined;
      }}>Update</button
    ><button
      type="button"
      aria-label="Dismiss update"
      on:click={() => (updateRegistration = undefined)}><X size={15} /></button
    >
  </div>
{/if}
