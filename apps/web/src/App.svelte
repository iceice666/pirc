<script lang="ts">
  import {
    Activity,
    Check,
    ChevronDown,
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
  import Message from './lib/components/Message.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
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
    SessionSummary,
    ThinkingLevel,
    Workspace,
  } from './lib/types';

  let workspaces: Workspace[] = [];
  let sessions: SessionSummary[] = [];
  let models: ModelOption[] = [];
  let activeSessionId: string | undefined;
  let sessionState: ClientSessionState | undefined;
  let connection: ConnectionState = navigator.onLine ? 'reconnecting' : 'offline';
  let draft = '';
  let uploads: Array<Attachment & { preview?: string; uploading?: boolean }> = [];
  let sidebarOpen = false;
  let detailsOpen = true;
  let loading = true;
  let commandBusy = false;
  let pageError = '';
  let usingDemo = false;
  let events: EventConnection | undefined;
  let clientId = '';
  let newSessionOpen = false;
  let newSessionWorkspace = '';
  let newSessionName = '';
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
    return () => {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      events?.close();
      removePwa();
      uploads.forEach((upload) => upload.preview && URL.revokeObjectURL(upload.preview));
    };
  });

  async function bootstrap() {
    loading = true;
    try {
      [workspaces, sessions, models] = await Promise.all([
        api.workspaces(),
        api.sessions(),
        api.models(),
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
      if (!usingDemo) {
        events = connectEvents({
          sessionId: id,
          cursor: snapshot.cursor,
          onState: (state) => (connection = state),
          onEvent: (event) => {
            if (!sessionState) return;
            sessionState = reduceEvent(sessionState, event);
            if (sessionState.needsSnapshot) void refreshSnapshot();
            void scrollToLatest();
          },
        });
      }
      await scrollToLatest(false);
    } catch (error) {
      pageError = error instanceof Error ? error.message : 'Unable to load this session.';
    }
  }

  async function refreshSnapshot() {
    if (!activeSessionId || usingDemo) return;
    try {
      sessionState = fromSnapshot(await api.snapshot(activeSessionId));
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

  function showNewSession(workspaceId?: string) {
    newSessionWorkspace = workspaceId ?? workspaces[0]?.id ?? '';
    newSessionName = '';
    newSessionOpen = true;
  }

  async function createSession() {
    if (!newSessionWorkspace) return;
    try {
      const created = usingDemo
        ? {
            id: crypto.randomUUID(),
            workspaceId: newSessionWorkspace,
            name: newSessionName || 'Untitled session',
            lastActivityAt: new Date().toISOString(),
            runnerStatus: 'stopped' as const,
            unreadCount: 0,
          }
        : await api.createSession({
            workspaceId: newSessionWorkspace,
            name: newSessionName || undefined,
          });
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
    {sessions}
    {activeSessionId}
    open={sidebarOpen}
    onselect={openSession}
    onnew={showNewSession}
    onclose={() => (sidebarOpen = false)}
  />

  <main class:details-collapsed={!detailsOpen} class="workspace">
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
              <div class="session-intro">
                <span class="intro-icon"><Sparkles size={17} /></span>
                <div>
                  <strong>Session started</strong><span
                    >{activeWorkspace?.canonicalPath ?? activeWorkspace?.displayName} · {models.find(
                      (model) => model.id === selectedModel,
                    )?.displayName}</span
                  >
                </div>
              </div>
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

        <aside class:open={detailsOpen} class="details" aria-label="Session details">
          <div class="details-section run-overview">
            <div class="section-heading">
              <span>Current run</span><span
                class:working={runStatus === 'running'}
                class="run-badge">{runStatus ?? 'idle'}</span
              >
            </div>
            <div class="run-card">
              <div class="run-orbit"><span></span><Activity size={20} /></div>
              <div>
                <strong
                  >{runStatus === 'running'
                    ? 'Pi is working'
                    : runStatus === 'waiting_input'
                      ? 'Waiting for you'
                      : 'No active run'}</strong
                ><span
                  >{runStatus === 'running'
                    ? `Elapsed ${formatDuration(sessionState.run?.startedAt)}`
                    : 'Ready for a prompt'}</span
                >
              </div>
            </div>
            <dl class="detail-list">
              <div>
                <dt>Runner</dt>
                <dd><span class="tiny-dot"></span>{sessionState.runnerStatus}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  {models.find((model) => model.id === selectedModel)?.displayName ?? selectedModel}
                </dd>
              </div>
              <div>
                <dt>Thinking</dt>
                <dd class="capitalize">{thinking}</dd>
              </div>
              <div>
                <dt>Control</dt>
                <dd>
                  {hasControl ? 'This browser' : (sessionState.control.holderName ?? 'Viewer')}
                </dd>
              </div>
            </dl>
          </div>

          <div class="details-section">
            <div class="section-heading">
              <span>Queue</span><span>{sessionState.queue.length}</span>
            </div>
            {#if sessionState.queue.length}
              <div class="queue-list">
                {#each sessionState.queue as item, index}
                  <div class="queue-item">
                    <span>{index + 1}</span>
                    <div>
                      <strong>{item.kind === 'follow_up' ? 'Follow up' : 'Steer'}</strong>
                      <p>{item.content}</p>
                    </div>
                  </div>
                {/each}
              </div>
            {:else}<p class="muted-note">
                Nothing queued. Follow-ups appear here while a run is active.
              </p>{/if}
          </div>

          <div class="details-section">
            <div class="section-heading">
              <span>Session</span><button type="button" aria-label="Collapse section"
                ><ChevronDown size={15} /></button
              >
            </div>
            <dl class="detail-list compact">
              <div>
                <dt>Workspace</dt>
                <dd>{activeWorkspace?.displayName}</dd>
              </div>
              <div>
                <dt>Host</dt>
                <dd>{activeWorkspace?.hostId}</dd>
              </div>
              <div>
                <dt>Epoch</dt>
                <dd class="mono">{sessionState.runnerEpoch.slice(0, 12)}</dd>
              </div>
              <div>
                <dt>Cursor</dt>
                <dd class="mono">{sessionState.cursor}</dd>
              </div>
            </dl>
          </div>
          {#if usingDemo}<div class="demo-note">
              Preview data is shown because the gateway is not connected.
            </div>{/if}
        </aside>
      </div>
    {:else}
      <div class="loading-state">
        <CircleAlert size={24} />
        <p>No session could be loaded.</p>
      </div>
    {/if}
  </main>
</div>

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
          >{#each workspaces as workspace}<option value={workspace.id}
              >{workspace.displayName} · {workspace.hostId}</option
            >{/each}</select
        ></label
      >
      <label
        ><span>Session name</span><input
          bind:value={newSessionName}
          placeholder="What are you working on?"
          on:keydown={(event) => event.key === 'Enter' && createSession()}
        /></label
      >
      <p>The session stays active on the host when this browser disconnects.</p>
      <footer>
        <button class="button ghost" type="button" on:click={() => (newSessionOpen = false)}
          >Cancel</button
        ><button
          class="button dark"
          type="button"
          on:click={createSession}
          disabled={!newSessionWorkspace}>Create session</button
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
