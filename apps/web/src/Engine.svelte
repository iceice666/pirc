<script lang="ts">
  /**
   * The engine at `/engine`: workspaces, nodes and sessions. A session shows
   * its panes (files, Git, terminal…), not a conversation: people talk to pirc
   * in the rooms, and pirc to its workers (plan 12 decision 4).
   */
  import {
    CircleAlert,
    CloudOff,
    Forward,
    Download,
    PanelLeftOpen,
    Pencil,
    Radio,
    RefreshCw,
    ShieldCheck,
    ShieldOff,
    Sparkles,
    X,
  } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { engine } from './lib/engine.svelte';
  import JobsMenu from './lib/components/JobsMenu.svelte';
  import MobileTabs, { type MobileTab, type MobileTabId } from './lib/components/MobileTabs.svelte';
  import WorkspaceDetail from './lib/components/engine/WorkspaceDetail.svelte';
  import EngineOverview from './lib/components/engine/EngineOverview.svelte';
  import WaitingBand from './lib/components/engine/WaitingBand.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import NewWorkspaceDialog from './lib/components/dialogs/NewWorkspaceDialog.svelte';
  import SettingsDialog, { type SettingsTab } from './lib/components/dialogs/SettingsDialog.svelte';
  import NativeManagementConsent from './lib/components/dialogs/NativeManagementConsent.svelte';
  import SessionPanes from './lib/components/panel/SessionPanes.svelte';
  import type { PanelTab } from './lib/panel-api';
  import { activateUpdate, registerPwa } from './lib/pwa';
  import { loadLayout, saveLayout } from './lib/storage';
  import { motion } from './lib/motion';
  import { t } from './lib/i18n';
  import { trackViewportHeight } from './lib/viewport';

  /**
   * Phone: the session list (a full page above the bottom tabs) is showing.
   * The phone starts on the list, unless a link names a session to open.
   */
  let sidebarOpen = $state(
    window.innerWidth <= 650 && !new URLSearchParams(location.search).has('session'),
  );
  /** Desktop: left sidebar collapsed out of the grid. */
  let sidebarCollapsed = $state(loadLayout('sidebarCollapsed', false));
  let viewportWidth = $state(window.innerWidth);
  let panelTab: PanelTab = $state('files');
  let settingsOpen = $state(false);
  let settingsTab: SettingsTab = $state('models');
  /** The workspace whose page is showing, if it still exists. */
  const pageWorkspace = $derived(
    engine.view === 'workspace'
      ? engine.workspaces.find((workspace) => workspace.id === engine.workspaceViewId)
      : undefined,
  );
  const onOverview = $derived(engine.view === 'overview');
  /** A page in the main column (not a session): the phone keeps its bottom tabs. */
  const onPage = $derived(!!pageWorkspace || onOverview);
  // A page replaces the phone's list.
  $effect(() => {
    if (onPage) sidebarOpen = false;
  });
  const origin = $derived(
    engine.sessions.find((item) => item.id === sessionState?.session.id)?.origin,
  );
  const mobileTab = $derived<MobileTabId>(settingsOpen ? 'settings' : 'engine');
  const mobileTabs = $derived<MobileTab[]>([
    { id: 'rooms', href: '/' },
    { id: 'engine', badge: engine.inbox.length },
    { id: 'settings' },
  ]);
  function pickTab(tab: MobileTabId) {
    if (tab === 'settings') {
      settingsTab = 'models';
      settingsOpen = true;
    } else if (onOverview) sidebarOpen = true;
    else showOverview();
  }
  let newWorkspaceOpen = $state(false);
  let newWorkspaceNodeId = $state('');
  let updateRegistration: ServiceWorkerRegistration | undefined = $state();

  const sessionState = $derived(engine.sessionState);
  // This consent URL is an additive overlay. The normal app bootstrap still runs on mount.
  const nativeManagementRequestId =
    new URLSearchParams(location.search).get('nativeManagement')?.trim() || undefined;
  const hasControl = $derived(engine.hasControl);
  const connection = $derived(engine.connection);

  $effect(() => saveLayout('sidebarCollapsed', sidebarCollapsed));

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented && sidebarOpen) sidebarOpen = false;
  }

  onMount(() => {
    const removePwa = registerPwa((registration) => (updateRegistration = registration));
    const removeViewport = trackViewportHeight();
    void engine.bootstrap();
    // A notification clicked while this window is open (public/sw.js).
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'OPEN_TARGET') return;
      sidebarOpen = false;
      void engine.openTarget(event.data.target ?? undefined);
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
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
      leaseHeartbeat = setInterval(() => void engine.refreshControl(), visible ? 10_000 : 15_000);
      // Sessions changes are pushed only while a session is open: poll as a fallback.
      nodeRefresh = visible
        ? setInterval(() => {
            void engine.refreshNodes();
            void engine.refreshSessions();
          }, 60_000)
        : undefined;
    };
    schedule();
    // Background tabs and suspended mobile pages skip heartbeats; catch up at once.
    let hiddenAt = 0;
    const onVisibility = () => {
      schedule();
      if (document.visibilityState === 'visible') engine.resume(Date.now() - hiddenAt);
      else hiddenAt = Date.now();
    };
    const onOnline = () => engine.retryBootstrap() || void engine.refreshControl();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(nodeRefresh);
      clearInterval(leaseHeartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      engine.dispose();
      removePwa();
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      removeViewport();
    };
  });

  function openSession(id: string) {
    sidebarOpen = false;
    void engine.openSession(id);
  }

  function showOverview() {
    sidebarOpen = false;
    engine.showOverview('overview');
  }

  /* ── Renaming the open session from its title ── */
  let renaming = $state(false);
  let renameDraft = $state('');
  let renameInput: HTMLInputElement | undefined = $state();

  async function startRename() {
    if (!engine.sessionState) return;
    renaming = true;
    renameDraft = engine.sessionState.session.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function finishRename(commit: boolean) {
    if (!renaming) return;
    renaming = false;
    const id = engine.sessionState?.session.id;
    const name = renameDraft.trim();
    if (commit && id && name && name !== engine.sessionState?.session.name)
      void engine.renameSession(id, name);
  }

  function openWorkspace(id: string) {
    sidebarOpen = false;
    engine.showWorkspace(id);
  }

  function resetLayout() {
    sidebarCollapsed = false;
  }

  function showNewWorkspace(nodeId: string) {
    newWorkspaceNodeId = nodeId;
    newWorkspaceOpen = true;
    sidebarOpen = false;
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} onkeydown={onWindowKeydown} />

<svelte:head
  ><title
    >{onOverview
      ? 'Engine · pirc'
      : pageWorkspace
        ? `${pageWorkspace.displayName} · pirc`
        : sessionState
          ? `${sessionState.session.name} · pirc`
          : 'pirc'}</title
  ></svelte:head
>

<div class="app-shell" class:sidebar-collapsed={sidebarCollapsed}>
  <Sidebar
    bind:open={sidebarOpen}
    collapsed={sidebarCollapsed}
    oncollapse={() => (sidebarCollapsed = true)}
    onselect={openSession}
    onaddworkspace={showNewWorkspace}
    onclose={() => (sidebarOpen = false)}
    onopenworkspace={openWorkspace}
    onsettings={() => {
      settingsTab = 'models';
      settingsOpen = true;
    }}
    onoverview={showOverview}
  />

  <!-- The open phone drawer is modal: the page behind it is inert. -->
  <main class="workspace" inert={sidebarOpen && viewportWidth <= 650}>
    {#if onOverview}
      <EngineOverview
        section={engine.overviewSection}
        onsection={(section) => engine.showOverview(section)}
        nodes={engine.nodes}
        memoryRevision={engine.memoryRevision}
        disabled={engine.usingDemo}
        onsettings={() => {
          settingsTab = 'models';
          settingsOpen = true;
        }}
      />
    {:else if pageWorkspace}
      <WorkspaceDetail
        workspace={pageWorkspace}
        {sidebarCollapsed}
        onexpand={() => (sidebarCollapsed = false)}
        onselect={openSession}
      />
    {:else if engine.loading}
      <div class="loading-state">
        <span class="large-mark"><Sparkles size={24} /></span>
        <p>{t('engine.loading')}</p>
      </div>
    {:else if sessionState}
      <header class="topbar">
        {#if sidebarCollapsed}
          <button
            class="sidebar-expand icon-button"
            type="button"
            aria-label={t('engine.header.showSidebar')}
            title={t('engine.header.showSidebar')}
            transition:fade={{ duration: motion(160) }}
            onclick={() => (sidebarCollapsed = false)}><PanelLeftOpen size={19} /></button
          >
        {/if}
        <div class="title-block">
          <div class="breadcrumb">
            {#if engine.activeWorkspace}<button
                class="crumb"
                type="button"
                title={t('engine.header.openWorkspace', {
                  name: engine.activeWorkspace.displayName,
                })}
                onclick={() => openWorkspace(engine.activeWorkspace!.id)}
                >{engine.activeWorkspace.displayName}</button
              >{:else}<span class="crumb">{t('engine.workspace.title')}</span>{/if}<span
              class="sep"
              aria-hidden="true">/</span
            ><span>{sessionState.session.name}</span>
          </div>
          <div class="title-row">
            {#if renaming}
              <form
                class="rename-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  finishRename(true);
                }}
              >
                <input
                  bind:this={renameInput}
                  bind:value={renameDraft}
                  maxlength="200"
                  aria-label={t('engine.session.nameLabel')}
                  onkeydown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      finishRename(false);
                    }
                  }}
                  onblur={() => finishRename(true)}
                />
              </form>
            {:else}
              <h1>{sessionState.session.name}</h1>
              <button
                class="icon-button small rename"
                type="button"
                aria-label={t('engine.session.renameName', { name: sessionState.session.name })}
                title={t('engine.session.renameTitle')}
                onclick={() => void startRename()}><Pencil size={14} /></button
              >
            {/if}
            {#if origin?.kind === 'delegation'}
              <a
                class="worker-chip"
                href="/?room={encodeURIComponent(origin.roomId)}"
                title={t('engine.header.openOriginRoom')}
                ><Forward size={13} /><span
                  >{t('engine.header.workerChip', { title: origin.title })}</span
                ></a
              >
            {/if}
            {#if sessionState.sandbox && !sessionState.sandbox.active}
              <!-- Stays while this agent runs. -->
              <span
                class="origin-chip unsandboxed"
                role="status"
                title={sessionState.sandbox.reason
                  ? t('engine.header.notSandboxedReason', { reason: sessionState.sandbox.reason })
                  : t('engine.header.notSandboxed')}
                ><ShieldOff size={13} /><span>{t('engine.header.notSandboxed')}</span></span
              >
            {/if}
          </div>
        </div>
        <div class="topbar-actions">
          <JobsMenu />
          <span
            class:offline={connection === 'offline'}
            class:reconnecting={connection === 'reconnecting'}
            class="connection-pill"
          >
            {#if connection === 'connected'}<Radio size={13} />
              {t('engine.header.live')}{:else if connection === 'offline'}<CloudOff size={13} />
              {t('common.status.offline')}{:else}<RefreshCw class="spin" size={13} />
              {t('common.status.reconnecting')}{/if}
          </span>
          {#if !hasControl}
            <button class="button takeover" type="button" onclick={() => engine.takeControl()}
              ><ShieldCheck size={15} /> {t('engine.header.takeControl')}</button
            >
          {:else}
            <span class="control-pill"
              ><ShieldCheck size={14} /> {t('engine.header.inControl')}</span
            >
          {/if}
        </div>
      </header>

      {#if engine.pageError}
        <div class="error-banner" role="alert">
          <CircleAlert size={16} /><span>{engine.pageError}</span><button
            type="button"
            aria-label={t('engine.header.dismissError')}
            onclick={() => (engine.pageError = '')}><X size={15} /></button
          >
        </div>
      {/if}
      {#if engine.runStatus === 'waiting_input' && origin?.kind === 'delegation'}
        <WaitingBand roomId={origin.roomId} />
      {/if}
      {#if !hasControl}
        <div class="viewer-banner">
          <span
            >{t('engine.viewer.banner', {
              name: sessionState.control.holderName ?? t('engine.viewer.anotherDevice'),
            })}</span
          ><button type="button" onclick={() => engine.takeControl()}
            >{t('engine.header.takeControl')}</button
          >
        </div>
      {/if}

      <SessionPanes bind:tab={panelTab} />
    {:else}
      <div class="loading-state">
        <CircleAlert size={24} />
        <p>{t('engine.noSession')}</p>
      </div>
    {/if}
  </main>
</div>

<SettingsDialog
  bind:open={settingsOpen}
  bind:tab={settingsTab}
  disabled={engine.usingDemo}
  onresetlayout={resetLayout}
/>
{#if nativeManagementRequestId}
  <NativeManagementConsent requestId={nativeManagementRequestId} />
{/if}
<NewWorkspaceDialog
  bind:open={newWorkspaceOpen}
  nodeId={newWorkspaceNodeId}
  oncreated={openWorkspace}
/>
{#if sidebarOpen || onPage}
  <MobileTabs tabs={mobileTabs} current={mobileTab} onpick={pickTab} />
{/if}

{#if updateRegistration}
  <div class="update-toast" role="status">
    <Download size={18} />
    <div>
      <strong>{t('engine.update.ready')}</strong><span>{t('engine.update.note')}</span>
    </div>
    <button
      type="button"
      onclick={() => {
        activateUpdate(updateRegistration!);
        updateRegistration = undefined;
      }}>{t('engine.update.action')}</button
    ><button
      type="button"
      aria-label={t('engine.update.dismiss')}
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
    font-size: 14px;
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    /* One definite row: a page's column scrolls inside it instead of growing the
       shell (which clips), so a long dashboard or session list can scroll. */
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
    background: var(--bg);
    transition: grid-template-columns var(--layout-duration) var(--ease);
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
    background: var(--bg-room);
  }
  /* The design's session header: breadcrumb, title and chips in 10/16px. */
  .topbar {
    min-width: 0;
    /* Installed on iOS with viewport-fit=cover, the status bar overlaps the top. */
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px 20px;
    border-bottom: 1px solid var(--line);
    background: var(--bg-room);
  }
  .title-block {
    min-width: 0;
    flex: 1 1 320px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .breadcrumb {
    display: flex;
    gap: 4px;
    overflow: hidden;
    color: var(--faint);
    font-size: 12px;
    white-space: nowrap;
  }
  .crumb {
    padding: 0;
    border: 0;
    color: var(--muted);
    background: transparent;
    font-family: var(--font-mono);
    font-size: inherit;
  }
  .crumb:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .title-row {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .title-row h1 {
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 17px;
    font-weight: 600;
  }
  .rename {
    flex: none;
    color: var(--faint);
  }
  .rename-form {
    min-width: 0;
    flex: 1 1 240px;
  }
  .rename-form input {
    width: 100%;
    height: 28px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
    font-size: 15px;
    font-weight: 600;
  }
  .worker-chip {
    min-width: 0;
    max-width: 280px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 12px;
    color: var(--worker-ink);
    background: color-mix(in srgb, var(--worker) 12%, transparent);
    font-size: 12px;
    text-decoration: none;
  }
  .worker-chip span,
  .origin-chip span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .worker-chip:hover {
    background: color-mix(in srgb, var(--worker) 20%, transparent);
  }
  .origin-chip {
    min-width: 0;
    max-width: 280px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 12px;
    text-decoration: none;
  }
  .origin-chip.unsandboxed,
  .origin-chip.unsandboxed:hover {
    border-color: var(--warning);
    color: var(--warning);
    background: var(--warning-soft);
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
  @media (max-width: 860px) {
    .app-shell {
      --sidebar-width: 232px;
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
      padding: calc(8px + env(safe-area-inset-top)) 6px 8px 50px;
      gap: 4px;
    }
    .breadcrumb {
      display: none;
    }
    .title-block {
      flex: 1 1 auto;
    }
    .title-row h1 {
      font-size: 16px;
    }
    .worker-chip {
      max-width: 60%;
      padding: 1px 7px;
    }
    .origin-chip {
      max-width: 40%;
      padding: 0 7px;
    }
    .topbar-actions {
      gap: 2px;
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
    .update-toast {
      right: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      left: 8px;
    }
  }
</style>
