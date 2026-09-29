<script lang="ts">
  import {
    ArrowDown,
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
  import NewProjectDialog from './lib/components/dialogs/NewProjectDialog.svelte';
  import NewSessionDialog from './lib/components/dialogs/NewSessionDialog.svelte';
  import NewWorkspaceDialog from './lib/components/dialogs/NewWorkspaceDialog.svelte';
  import SettingsDialog, { type SettingsTab } from './lib/components/dialogs/SettingsDialog.svelte';
  import SidePanel from './lib/components/panel/SidePanel.svelte';
  import type { PanelTab } from './lib/panel-api';
  import { onFilePreviewRequest } from './lib/file-links';
  import { loadHighlighter } from './lib/markdown';
  import { activateUpdate, registerPwa } from './lib/pwa';
  import { loadLayout, saveLayout } from './lib/storage';
  import { MESSAGE_PAGE } from './lib/app.svelte';
  import { motion } from './lib/motion';
  import { trackViewportHeight } from './lib/viewport';
  import { watch } from './lib/watch.svelte';

  /** Mobile overlay state of the left sidebar. */
  let sidebarOpen = $state(false);
  /** Desktop: left sidebar collapsed out of the grid. */
  let sidebarCollapsed = $state(loadLayout('sidebarCollapsed', false));
  /**
   * Up to this width the side panel is an overlay above the conversation
   * instead of a column beside it.
   */
  const PANEL_OVERLAY_MAX = 860;
  /**
   * Right side panel starts hidden until the user opens it (then the choice is
   * remembered). The remembered choice only applies where the panel is a
   * column: a phone must not start with the conversation covered.
   */
  let detailsOpen = $state(
    window.innerWidth > PANEL_OVERLAY_MAX && loadLayout('detailsOpen', false),
  );
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
  let settingsTab: SettingsTab = $state('general');
  // A notification or a `?open=` link asked for the schedules or the memory.
  $effect(() => {
    const target = app.requestedTarget;
    if (!target) return;
    settingsTab = 'schedules' in target ? 'schedules' : 'memory';
    settingsOpen = true;
    app.requestedTarget = undefined;
  });
  let newSessionOpen = $state(false);
  let newProjectOpen = $state(false);
  let newProjectNodeId = $state('');
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
  $effect(() => {
    if (viewportWidth > PANEL_OVERLAY_MAX) saveLayout('detailsOpen', detailsOpen);
  });
  /** The panel covers the conversation: scrim, Escape closes it, the rest is inert. */
  const panelOverlay = $derived(detailsOpen && viewportWidth <= PANEL_OVERLAY_MAX);
  let detailsToggle: HTMLButtonElement | undefined = $state();

  function closePanel() {
    const panel = document.querySelector('.side-panel');
    const hadFocus = !!panel?.contains(document.activeElement);
    detailsOpen = false;
    // Focus would be lost in the hidden panel; return it to the toggle.
    if (hadFocus) detailsToggle?.focus();
  }

  watch(
    () => panelOverlay,
    async (overlay) => {
      if (!overlay) return;
      await tick();
      document.querySelector<HTMLElement>('.side-panel [role="tab"][tabindex="0"]')?.focus();
    },
  );

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (sidebarOpen) {
      sidebarOpen = false;
      return;
    }
    const target = event.target instanceof Element ? event.target : undefined;
    // A dialog closes itself, and Escape belongs to programs in the terminal.
    if (panelOverlay && !target?.closest('dialog, .terminal-tab')) closePanel();
  }
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

  /**
   * Whether new content keeps the newest entry in view. Updated from scroll
   * events only (scrolling up detaches, reaching the bottom re-attaches), so
   * streamed deltas never measure the layout.
   */
  let following = $state(true);
  /** Content arrived while the reader was scrolled up: offer a way back down. */
  let unseenContent = $state(false);
  let lastScrollTop = 0;
  function onTimelineScroll() {
    if (!timeline) return;
    const top = timeline.scrollTop;
    const nearBottom = timeline.scrollHeight - top - timeline.clientHeight < 80;
    if (top < lastScrollTop - 1) following = nearBottom;
    else if (nearBottom) following = true;
    if (following) unseenContent = false;
    lastScrollTop = top;
  }

  /**
   * Keep the bottom in view while following, whatever made the transcript grow
   * (a throttled Markdown render, a tool card, an image) or the timeline shrink
   * (the soft keyboard, a taller composer). ResizeObserver runs after layout,
   * once per frame, so this never forces an extra layout.
   */
  function followContent(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      if (following && timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    observer.observe(node);
    if (node.parentElement) observer.observe(node.parentElement);
    return { destroy: () => observer.disconnect() };
  }

  // A new or growing last entry, or a new question, while scrolled up.
  const markUnseen = () => {
    if (!following) unseenContent = true;
  };
  watch(() => sessionState?.messages[sessionState.messages.length - 1], markUnseen);
  watch(
    () => app.pendingInteractions.length,
    (count, previous) => count > (previous ?? 0) && markUnseen(),
  );

  /**
   * Screen readers hear finished replies and new questions once, from a
   * separate live region, instead of every streamed delta of the transcript.
   */
  let announcement = $state('');
  const lastReply = $derived.by(() => {
    const messages = sessionState?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === 'assistant' && !message.isPartial) return message;
    }
    return undefined;
  });
  watch(
    () => lastReply?.id,
    (id, previous) => {
      // Not on the first load of a session, only for replies that arrive later.
      if (!id || !previous || sessionState?.session.id !== announcedSession) return;
      const text = lastReply?.content.trim();
      announcement = text
        ? `Agent replied: ${text.length > 280 ? `${text.slice(0, 280)}…` : text}`
        : 'Agent finished a step.';
    },
  );
  watch(
    () => app.pendingInteractions.length,
    (count, previous) => {
      if (count > (previous ?? 0) && sessionState?.session.id === announcedSession)
        announcement = 'The agent needs your input.';
    },
  );
  let announcedSession: string | undefined;
  watch(
    () => sessionState?.session.id,
    (id) => {
      announcedSession = id;
      announcement = '';
    },
    { immediate: true },
  );

  app.scroller = {
    toLatest: async (smooth = true) => {
      following = true;
      unseenContent = false;
      await tick();
      timeline?.scrollTo({ top: timeline.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    },
  };

  onMount(() => {
    const removePwa = registerPwa((registration) => (updateRegistration = registration));
    const removeViewport = trackViewportHeight();
    void app.bootstrap();
    // A notification clicked while this window is open (public/sw.js).
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OPEN_TARGET') {
        sidebarOpen = false;
        void app.openTarget(event.data.target ?? undefined);
      }
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    // A file link in the conversation previews the file in the side panel.
    const removeFileLinks = onFilePreviewRequest(() => (detailsOpen = true));
    // Code blocks are common; fetch the highlighter once the first paint is done.
    // KaTeX is rarer and loads on first use instead.
    const warm = () => void loadHighlighter();
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1000);
    /*
     * Visible: renew the lease every 10 s. Node and workspace changes arrive
     * over the event stream; a slow 60 s refresh is only a fallback. Hidden:
     * the list refresh pauses, and the lease is only renewed as often as it
     * must be to survive (half its 30 s TTL), so a background tab keeps
     * control without polling at full rate. Both catch up on return.
     */
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let nodeRefresh: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      clearInterval(leaseHeartbeat);
      clearInterval(nodeRefresh);
      const visible = document.visibilityState === 'visible';
      leaseHeartbeat = setInterval(() => void app.refreshControl(), visible ? 10_000 : 15_000);
      nodeRefresh = visible ? setInterval(() => void app.refreshNodes(), 60_000) : undefined;
    };
    schedule();
    // Background tabs and suspended mobile pages skip heartbeats; catch up at once.
    let hiddenAt = 0;
    const onVisibility = () => {
      schedule();
      if (document.visibilityState === 'visible') app.resume(Date.now() - hiddenAt);
      else {
        hiddenAt = Date.now();
        app.flushDraft();
      }
    };
    const onOnline = () => app.retryBootstrap() || void app.refreshControl();
    const onPageHide = () => app.flushDraft();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(nodeRefresh);
      clearInterval(leaseHeartbeat);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      app.dispose();
      removePwa();
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      removeViewport();
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

  function showNewProject(nodeId: string) {
    newProjectNodeId = nodeId;
    newProjectOpen = true;
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

<svelte:window bind:innerWidth={viewportWidth} onkeydown={onWindowKeydown} />

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
    onaddproject={showNewProject}
    onclose={() => (sidebarOpen = false)}
    {showSettled}
    onsettings={() => {
      // What waits for you (memory proposals, scheduled runs) is why the badge is showing.
      if (app.memoryPending) settingsTab = 'memory';
      else if (app.scheduleAttention) settingsTab = 'schedules';
      settingsOpen = true;
      sidebarOpen = false;
    }}
  />

  <!-- The open phone drawer is modal: the page behind it is inert. -->
  <main
    class:details-collapsed={!detailsOpen}
    class="workspace"
    inert={sidebarOpen && viewportWidth <= 650}
  >
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
            transition:fade={{ duration: motion(160) }}
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
            bind:this={detailsToggle}
            class="icon-button details-toggle"
            type="button"
            aria-label={detailsOpen ? 'Hide side panel' : 'Show side panel'}
            title={detailsOpen ? 'Hide side panel' : 'Show side panel'}
            aria-expanded={detailsOpen}
            onclick={() => (detailsOpen ? closePanel() : (detailsOpen = true))}
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
        <section class="conversation" aria-label="Conversation" inert={panelOverlay}>
          <div class="timeline" bind:this={timeline} onscroll={onTimelineScroll}>
            <div class="timeline-inner" use:followContent>
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
              {#if unseenContent && !following}
                <div class="jump-latest">
                  <button
                    type="button"
                    transition:fade={{ duration: motion(120) }}
                    onclick={() => app.scroller?.toLatest()}
                    ><ArrowDown size={15} /> New messages</button
                  >
                </div>
              {/if}
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
          <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
        </section>

        {#if panelOverlay}
          <button
            class="panel-scrim"
            type="button"
            tabindex="-1"
            aria-label="Close side panel"
            transition:fade={{ duration: motion(160) }}
            onclick={closePanel}
          ></button>
        {/if}
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

<SettingsDialog
  bind:open={settingsOpen}
  bind:tab={settingsTab}
  bind:showSettled
  onresetlayout={resetLayout}
  onopenchat={openSession}
/>
<NewWorkspaceDialog
  bind:open={newWorkspaceOpen}
  nodeId={newWorkspaceNodeId}
  oncreated={(workspaceId) => showNewSession(workspaceId)}
/>
<NewProjectDialog
  bind:open={newProjectOpen}
  nodeId={newProjectNodeId}
  oncreated={(workspaceId) => showNewSession(workspaceId)}
/>
<NewSessionDialog bind:open={newSessionOpen} />

{#if updateRegistration}
  <div class="update-toast" role="status">
    <Download size={18} />
    <div><strong>Update ready</strong><span>The page reloads; your draft is kept.</span></div>
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

<style>
  /* ───────────── Shell ───────────── */
  .app-shell {
    --sidebar-width: 264px;
    --layout-duration: 0.26s;
    height: 100%;
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    overflow: hidden;
    background: var(--bg);
    transition: grid-template-columns var(--layout-duration) var(--ease);
  }
  .app-shell.resizing {
    cursor: col-resize;
    user-select: none;
  }
  @media (min-width: 651px) {
    .app-shell.sidebar-collapsed {
      grid-template-columns: 0 minmax(0, 1fr);
    }
  }
  .sidebar-expand {
    flex: none;
    margin-left: -8px;
  }
  /* ───────────── Main column ───────────── */
  .workspace {
    height: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .workspace > .content-grid {
    flex: 1 1 0;
    min-height: 0;
  }
  .topbar {
    min-width: 0;
    /* Installed on iOS with viewport-fit=cover, the status bar overlaps the top. */
    flex: 0 0 calc(56px + env(safe-area-inset-top));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: env(safe-area-inset-top) 12px 0 20px;
    background: var(--bg);
  }
  .title-block {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .breadcrumb {
    order: 2;
    display: flex;
    gap: 4px;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .breadcrumb span:nth-child(n + 2) {
    display: none;
  }
  .title-block h1 {
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 15px;
    font-weight: 600;
  }
  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .connection-pill,
  .control-pill {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 12px;
  }
  .connection-pill :global(svg) {
    color: var(--success);
  }
  .connection-pill.offline :global(svg) {
    color: var(--danger);
  }
  .connection-pill.reconnecting :global(svg) {
    color: var(--warning);
  }
  .control-pill {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .button.takeover {
    height: 28px;
    padding: 0 12px;
    color: var(--on-accent);
    background: var(--accent);
    font-size: 12px;
  }
  .button.takeover:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .error-banner,
  .viewer-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 auto 8px;
    width: min(780px, calc(100% - 32px));
    padding: 8px 12px;
    border-radius: var(--radius-md);
    font-size: 13px;
  }
  .error-banner {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .error-banner span,
  .viewer-banner span {
    flex: 1;
  }
  .error-banner button,
  .viewer-banner button {
    display: grid;
    place-items: center;
    padding: 4px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font-weight: 500;
  }
  .error-banner button:hover,
  .viewer-banner button:hover {
    background: var(--bg-hover);
  }
  .viewer-banner {
    color: var(--text-2);
    background: var(--bg-subtle);
  }
  .viewer-banner button {
    color: var(--accent);
  }
  .content-grid {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--panel-width, 360px);
    overflow: hidden;
    transition: grid-template-columns var(--layout-duration) var(--ease);
  }
  .workspace.details-collapsed .content-grid {
    grid-template-columns: minmax(0, 1fr) 0;
  }
  /* Dragging the panel edge must track the pointer, not ease towards it. */
  .app-shell.resizing .content-grid {
    transition: none;
  }
  .conversation {
    min-width: 0;
    min-height: 0;
    display: grid;
    /* An explicit column lets composer controls shrink instead of widening the column. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto auto;
    background: var(--bg);
  }
  .timeline {
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }
  .timeline-inner {
    width: min(780px, 100%);
    min-height: 100%;
    margin: 0 auto;
    padding: 16px 32px 32px;
    display: flex;
    flex-direction: column;
  }
  .earlier-messages {
    align-self: center;
    margin: 0 0 16px;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg-layer);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .earlier-messages:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  /* Sticks to the bottom of the timeline without taking room in the transcript. */
  .jump-latest {
    position: sticky;
    z-index: 3;
    bottom: 12px;
    height: 0;
    display: flex;
    justify-content: center;
    order: 1;
  }
  .jump-latest button {
    height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    color: var(--ink);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
    font-size: 13px;
    font-weight: 500;
    transform: translateY(-100%);
  }
  .jump-latest button:hover {
    background: var(--bg-subtle);
  }
  .empty-conversation {
    flex: 1;
    min-height: 300px;
    display: grid;
    place-items: center;
    align-content: center;
    text-align: center;
  }
  .empty-conversation > span {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .empty-conversation h2 {
    margin: 16px 0 6px;
    font-size: 22px;
    font-weight: 600;
  }
  .empty-conversation p {
    max-width: 400px;
    margin: 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.6;
  }
  .loading-state {
    flex: 1;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 14px;
    color: var(--muted);
  }
  .large-mark {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .loading-state p {
    margin: 0;
    font-size: 14px;
  }
  .update-toast {
    position: fixed;
    z-index: 110;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 14px;
    border-radius: var(--radius-lg);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
  }
  .update-toast > :global(svg) {
    color: var(--accent);
  }
  .update-toast div {
    display: grid;
    gap: 2px;
  }
  .update-toast strong {
    font-size: 13px;
    font-weight: 500;
  }
  .update-toast span {
    color: var(--muted);
    font-size: 12px;
  }
  .update-toast button {
    padding: 6px 12px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    font-size: 13px;
    font-weight: 500;
  }
  .update-toast button:nth-of-type(1) {
    color: var(--on-accent);
    background: var(--accent);
  }
  .update-toast button:nth-of-type(2) {
    display: grid;
    place-items: center;
    padding: 6px;
  }
  @media (max-width: 1100px) {
    .timeline-inner {
      padding-inline: 24px;
    }
  }
  .panel-scrim {
    display: none;
  }
  @media (max-width: 860px) {
    .app-shell {
      --sidebar-width: 232px;
    }
    .panel-scrim {
      position: fixed;
      z-index: 24;
      inset: calc(56px + env(safe-area-inset-top)) 0 0;
      display: block;
      padding: 0;
      border: 0;
      background: rgb(0 0 0 / 25%);
      cursor: default;
    }
    .content-grid,
    .workspace.details-collapsed .content-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 650px) {
    .app-shell {
      display: block;
    }
    .sidebar-expand {
      display: none;
    }
    .topbar {
      padding-right: 6px;
      padding-left: 50px;
      gap: 4px;
    }
    .breadcrumb {
      display: none;
    }
    .title-block h1 {
      font-size: 15px;
    }
    .topbar-actions {
      gap: 2px;
    }
    .topbar-actions .icon-button {
      width: 40px;
      height: 40px;
    }
    /* Only a coloured dot: the state is still announced by the pill's text. */
    .connection-pill {
      width: 28px;
      height: 28px;
      justify-content: center;
      padding: 0;
      font-size: 0;
      background: transparent;
    }
    .control-pill {
      display: none;
    }
    .button.takeover {
      width: 36px;
      height: 36px;
      padding: 0;
      font-size: 0;
    }
    .timeline-inner {
      padding: 8px 14px 20px;
    }
    .update-toast {
      right: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      left: 8px;
    }
  }
</style>
