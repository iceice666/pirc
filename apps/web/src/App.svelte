<script lang="ts">
  import {
    CircleAlert,
    CloudOff,
    Download,
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
  import { app } from './lib/app.svelte';
  import Composer from './lib/components/Composer.svelte';
  import InteractionCard from './lib/components/InteractionCard.svelte';
  import JobsMenu from './lib/components/JobsMenu.svelte';
  import Message from './lib/components/Message.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import NewSessionDialog from './lib/components/dialogs/NewSessionDialog.svelte';
  import NewWorkspaceDialog from './lib/components/dialogs/NewWorkspaceDialog.svelte';
  import SettingsDialog from './lib/components/dialogs/SettingsDialog.svelte';
  import SidePanel from './lib/components/panel/SidePanel.svelte';
  import type { PanelTab } from './lib/panel-api';
  import { onFilePreviewRequest } from './lib/file-links';
  import { loadHighlighter } from './lib/markdown';
  import { activateUpdate, registerPwa } from './lib/pwa';
  import { loadLayout, saveLayout } from './lib/storage';
  import { MESSAGE_PAGE } from './lib/app.svelte';

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
  let settingsOpen = $state(false);
  let newSessionOpen = $state(false);
  let newWorkspaceOpen = $state(false);
  let newWorkspaceNodeId = $state('');
  let creatingSession = false;
  let updateRegistration: ServiceWorkerRegistration | undefined = $state();
  let timeline: HTMLElement | undefined = $state();

  const sessionState = $derived(app.sessionState);
  const hasControl = $derived(app.hasControl);
  const connection = $derived(app.connection);

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

  let revealingEarlier = false;
  let visibleMessages = $derived(
    sessionState
      ? sessionState.messages.slice(Math.min(app.hiddenMessages, sessionState.messages.length))
      : [],
  );

  async function showEarlier() {
    if (!app.hiddenMessages || revealingEarlier) return;
    revealingEarlier = true;
    const previousHeight = timeline?.scrollHeight ?? 0;
    const previousTop = timeline?.scrollTop ?? 0;
    app.hiddenMessages = Math.max(0, app.hiddenMessages - MESSAGE_PAGE);
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

  app.scroller = {
    following: () =>
      !!timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80,
    toLatest: async (smooth = true) => {
      await tick();
      timeline?.scrollTo({ top: timeline.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    },
  };

  onMount(() => {
    const removePwa = registerPwa((registration) => (updateRegistration = registration));
    void app.bootstrap();
    // A file link in the conversation previews the file in the side panel.
    const removeFileLinks = onFilePreviewRequest(() => (detailsOpen = true));
    // Code blocks are common; fetch the highlighter once the first paint is done.
    // KaTeX is rarer and loads on first use instead.
    const warm = () => void loadHighlighter();
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1000);
    const leaseHeartbeat = setInterval(() => void app.refreshControl(), 10_000);
    // Background tabs and suspended mobile pages skip heartbeats; catch up at once.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void app.refreshControl();
    };
    const onOnline = () => void app.refreshControl();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const nodeRefresh = setInterval(() => void app.refreshNodes(), 15_000);
    return () => {
      clearInterval(nodeRefresh);
      clearInterval(leaseHeartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      app.dispose();
      removePwa();
      removeFileLinks();
    };
  });

  function openSession(id: string) {
    sidebarOpen = false;
    void app.openSession(id);
  }

  function resetLayout() {
    sidebarCollapsed = false;
    detailsOpen = false;
    resizePanel(PANEL_DEFAULT);
  }

  function showNewWorkspace(nodeId: string) {
    newWorkspaceNodeId = nodeId;
    newWorkspaceOpen = true;
    sidebarOpen = false;
  }

  /** With a workspace (its `+` button, or one just added) the session is created right away. */
  async function showNewSession(workspaceId?: string) {
    if (!workspaceId) {
      newSessionOpen = true;
      return;
    }
    if (creatingSession) return;
    creatingSession = true;
    try {
      await app.createSession(workspaceId);
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
    bind:open={sidebarOpen}
    collapsed={sidebarCollapsed}
    oncollapse={() => (sidebarCollapsed = true)}
    onselect={openSession}
    onnew={showNewSession}
    onaddworkspace={showNewWorkspace}
    onclose={() => (sidebarOpen = false)}
    {showSettled}
    onsettings={() => {
      settingsOpen = true;
      sidebarOpen = false;
    }}
  />

  <main class:details-collapsed={!detailsOpen} class="workspace">
    {#if app.loading}
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
            <span>{app.activeWorkspace?.displayName ?? 'Workspace'}</span><span>/</span><span
              >{sessionState.session.name}</span
            >
          </div>
          <h1>{sessionState.session.name}</h1>
        </div>
        <div class="topbar-actions">
          <JobsMenu />
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
            <button class="button takeover" type="button" onclick={() => app.takeControl()}
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
        </div>
      </header>

      {#if app.pageError}
        <div class="error-banner" role="alert">
          <CircleAlert size={16} /><span>{app.pageError}</span><button
            type="button"
            aria-label="Dismiss error"
            onclick={() => (app.pageError = '')}><X size={15} /></button
          >
        </div>
      {/if}
      {#if !hasControl}
        <div class="viewer-banner">
          <span
            >You’re viewing this session. {sessionState.control.holderName ?? 'Another device'} currently
            has control.</span
          ><button type="button" onclick={() => app.takeControl()}>Take control</button>
        </div>
      {/if}

      <div class="content-grid">
        <section class="conversation" aria-label="Conversation">
          <div class="timeline" bind:this={timeline} aria-live="polite">
            <div class="timeline-inner">
              {#if app.hiddenMessages > 0}
                <button
                  type="button"
                  class="earlier-messages"
                  use:revealEarlier
                  onclick={showEarlier}
                >
                  Show earlier messages ({app.hiddenMessages} more)
                </button>
              {/if}
              {#each visibleMessages as message (message.id)}<Message {message} />{/each}
              {#each app.pendingInteractions as interaction (interaction.id)}
                <InteractionCard
                  {interaction}
                  disabled={!app.canCommand}
                  onanswer={(answer) => app.answerInteraction(interaction.id, answer)}
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
          <Composer />
        </section>

        <SidePanel
          open={detailsOpen}
          bind:tab={panelTab}
          bind:resizing={panelResizing}
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

<SettingsDialog bind:open={settingsOpen} bind:showSettled onresetlayout={resetLayout} />
<NewWorkspaceDialog
  bind:open={newWorkspaceOpen}
  nodeId={newWorkspaceNodeId}
  oncreated={(workspaceId) => showNewSession(workspaceId)}
/>
<NewSessionDialog bind:open={newSessionOpen} />

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
