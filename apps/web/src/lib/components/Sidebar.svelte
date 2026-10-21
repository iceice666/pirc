<script lang="ts">
  import {
    ChevronLeft,
    Command,
    Ellipsis,
    Folder,
    Forward,
    Gauge,
    Lock,
    PanelLeftClose,
    Pencil,
    Plus,
    Search,
    Settings,
    X,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { engine, type InboxItem } from '../engine.svelte';
  import { isReadOnly, workNodes } from '../modes';
  import { shortAgo } from '../time';
  import type { DelegationStatus, SessionSummary, Workspace } from '../types';
  import { watch } from '../watch.svelte';
  import { isRunning, sidebarSessions } from '../work';

  interface Props {
    open?: boolean;
    /** Desktop: slid out of the layout; the main column shows the expand button. */
    collapsed?: boolean;
    oncollapse: () => void;
    onselect: (id: string) => void;
    /** Open a workspace's page: all its sessions and its settings. */
    onopenworkspace: (workspaceId: string) => void;
    onaddworkspace: (nodeId: string) => void;
    onclose: () => void;
    onsettings: () => void;
    /** The engine's front page: nodes, brain, loops, wakes, memory, sources. */
    onoverview: () => void;
  }

  let {
    open = $bindable(false),
    collapsed = false,
    oncollapse,
    onselect,
    onopenworkspace,
    onaddworkspace,
    onclose,
    onsettings,
    onoverview,
  }: Props = $props();

  const DELEGATION_STATUS: Record<DelegationStatus, string> = {
    running: 'is running',
    waiting_input: 'waits for you',
    completed: 'finished',
    failed: 'failed',
  };
  const nodes = $derived(engine.nodes);
  const catalog = $derived(engine.modeCatalog);
  /** Nodes that can host workspaces (those accepting a mode the catalog knows). */
  const deviceNodes = $derived(workNodes(nodes, catalog));
  const sessions = $derived(engine.sessions);
  /** The open session, unless a page covers it. */
  const activeSessionId = $derived(engine.view === 'session' ? engine.activeSessionId : undefined);
  /** The workspace whose page is showing. */
  const pageId = $derived(engine.view === 'workspace' ? engine.workspaceViewId : undefined);
  const onrename = (id: string, name: string) => engine.renameSession(id, name);

  const workspaceById = $derived(new Map(engine.workspaces.map((item) => [item.id, item])));

  let query = $state('');
  let renamingId: string | undefined = $state();
  let renameValue = $state('');
  let renameInput: HTMLInputElement | undefined = $state();

  /** Devices with their workspaces (connected devices without any too), online first. */
  const hosts = $derived.by(() => {
    const ids = [
      ...new Set([...engine.workspaces.map((w) => w.hostId), ...deviceNodes.map((n) => n.id)]),
    ];
    const online = (id: string) => nodes.some((node) => node.id === id);
    return ids
      .sort((a, b) => Number(online(b)) - Number(online(a)) || a.localeCompare(b))
      .map((id) => ({
        id,
        online: online(id),
        workspaces: engine.workspaces.filter((w) => w.hostId === id),
      }));
  });
  const inbox = $derived(engine.inbox);

  /** Searching lists every matching session, whatever its workspace. */
  const results = $derived.by(() => {
    if (!query) return [];
    const needle = query.toLowerCase();
    return sessions.filter(
      (session) =>
        workspaceById.has(session.workspaceId) && session.name.toLowerCase().includes(needle),
    );
  });

  const unreadIn = (workspaceId: string) =>
    sessions.filter((session) => session.workspaceId === workspaceId && session.unread).length;
  const runningIn = (workspaceId: string) =>
    sessions.filter((session) => session.workspaceId === workspaceId && isRunning(session)).length;

  async function startRename(session: SessionSummary) {
    renamingId = session.id;
    renameValue = session.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function finishRename(commit: boolean) {
    const id = renamingId;
    if (!id) return;
    renamingId = undefined;
    const name = renameValue.trim();
    const current = sessions.find((session) => session.id === id);
    if (commit && name && current && name !== current.name) onrename(id, name);
  }

  /**
   * Touch screens have no hover: a row's rename button shows on the
   * open session, or on the row whose "more" button was tapped.
   */
  let revealedId: string | undefined = $state();

  let aside: HTMLElement | undefined = $state();
  let closeButton: HTMLButtonElement | undefined = $state();
  let menuButton: HTMLButtonElement | undefined = $state();
  // The phone list takes focus while open and hands it back when it closes.
  watch(
    () => open,
    async (isOpen) => {
      if (isOpen) {
        await tick();
        closeButton?.focus();
      } else {
        revealedId = undefined;
        if (aside?.contains(document.activeElement)) menuButton?.focus();
      }
    },
  );
</script>

{#if open}<button
    class="sidebar-scrim"
    type="button"
    aria-label="Close navigation"
    onclick={onclose}
  ></button>{/if}
<aside
  bind:this={aside}
  class:open
  class:collapsed
  class="sidebar"
  aria-label="Sessions"
  inert={collapsed && !open}
>
  <div class="brand-row">
    <a class="brand" href="/" aria-label="pirc home">
      <span class="brand-mark"><Command size={16} /></span><span>pirc</span>
    </a>
    <button
      class="sidebar-collapse icon-button"
      type="button"
      aria-label="Hide sidebar"
      title="Hide sidebar"
      onclick={oncollapse}><PanelLeftClose size={18} /></button
    >
    <button
      bind:this={closeButton}
      class="mobile-close icon-button"
      type="button"
      aria-label="Close navigation"
      onclick={onclose}><X size={19} /></button
    >
  </div>
  <button
    class="overview-entry"
    class:current={engine.view === 'overview'}
    type="button"
    aria-current={engine.view === 'overview' ? 'page' : undefined}
    onclick={onoverview}><Gauge size={16} /> Overview</button
  >
  <label class="search">
    <Search size={16} />
    <span class="sr-only">Search sessions</span>
    <input bind:value={query} placeholder="Search sessions" />
  </label>

  <div class="sidebar-scroll">
    {#if query}
      <section class="list-section" aria-label="Search results">
        <div class="section-heading"><strong>Results</strong><small>{results.length}</small></div>
        <div class="session-list">
          {#each results as session (session.id)}{@render sessionRow(session, true)}{:else}
            <p class="empty-note">Nothing matches.</p>
          {/each}
        </div>
      </section>
    {:else}
      {#if inbox.length}
        <section class="list-section" aria-label="Needs you">
          <div class="section-heading attention">
            <strong>Needs you</strong><span class="count-badge">{inbox.length}</span>
          </div>
          <div class="inbox-list">
            {#each inbox as item (item.id)}{@render inboxRow(item)}{/each}
          </div>
        </section>
      {/if}
      {#each hosts as host (host.id)}
        <section class="list-section" aria-label={host.id}>
          <div class="section-heading">
            <span class="host-dot" class:online={host.online}></span>
            <strong>{host.id}</strong>
            {#if !host.online}<small>offline</small>{/if}
            <button
              class="heading-action"
              type="button"
              onclick={() => onaddworkspace(host.id)}
              disabled={!host.online}
              aria-label="Add workspace on {host.id}"><Plus size={15} /></button
            >
          </div>
          <div class="workspace-list">
            {#each host.workspaces as workspace (workspace.id)}
              {@render workspaceRow(workspace)}
            {:else}
              <p class="empty-note">No workspaces yet.</p>
            {/each}
          </div>
        </section>
      {:else}
        <p class="empty-note">Connect a device to add a workspace.</p>
      {/each}
    {/if}
  </div>

  <div class="sidebar-footer">
    <button class="settings-entry" type="button" onclick={onsettings}>
      <Settings size={17} />
      <span>Settings</span>
    </button>
  </div>
</aside>

<button
  bind:this={menuButton}
  class="mobile-menu icon-button"
  type="button"
  aria-label="Back to the list"
  title="Back"
  onclick={() => (open = true)}><ChevronLeft size={22} /></button
>

<!-- A workspace: one row that opens its page, with its unread sessions under it. -->
{#snippet workspaceRow(workspace: Workspace)}
  {@const list = sidebarSessions(sessions, workspace.id, activeSessionId, true)}
  {@const unread = unreadIn(workspace.id)}
  {@const running = runningIn(workspace.id)}
  {@const online = engine.workspaceOnline(workspace)}
  {@const noun = engine.modeOf(workspace).ui.noun}
  <section class="workspace-group">
    <div class="workspace-heading" class:current={pageId === workspace.id}>
      <button
        type="button"
        onclick={() => onopenworkspace(workspace.id)}
        aria-current={pageId === workspace.id ? 'page' : undefined}
      >
        <Folder size={15} />
        <strong>{workspace.displayName}</strong>
        {#if isReadOnly(workspace)}<small>· read-only</small>{/if}
        <span class="workspace-meta">
          {#if sessions.some((s) => s.writeLease && s.workspaceId === workspace.id)}<span
              class="lease-lock"
              role="img"
              aria-label="A session holds the write lease"
              title="A session holds the write lease"><Lock size={12} /></span
            >{/if}
          {#if running}<small class="running-count" title="{running} running"
              ><span class="status-dot running"></span>{running}</small
            >{/if}
          {#if unread}<span class="unread-count" aria-label="{unread} unread">{unread}</span>{/if}
        </span>
      </button>
    </div>
    {#if list.length}
      <div class="session-list nested">
        {#each list as session (session.id)}{@render sessionRow(session, false)}{/each}
      </div>
    {/if}
  </section>
{/snippet}

{#snippet inboxRow(item: InboxItem)}
  {@const session = item.session}
  {@const approval = session.origin?.kind === 'delegation' ? session.origin.approval : undefined}
  {@const answering = !!approval && engine.answeringInteractionIds.includes(approval.interactionId)}
  <div class="inbox-item" data-kind={item.kind}>
    <button class="inbox-main" type="button" onclick={() => onselect(session.id)}>
      <span class="status-dot waiting"></span>
      <span class="inbox-text">
        <strong>{session.name}</strong>
        {#if approval}<small class="inbox-approval" title={approval.message ?? approval.title}
            >{approval.title}</small
          >{/if}
        <small
          >{session.origin
            ? `Delegated · ${session.origin.title}`
            : (workspaceById.get(session.workspaceId)?.displayName ?? '')} · waiting for you</small
        >
      </span>
    </button>
    <div class="inbox-actions">
      {#if approval}
        <!-- Answered in the chat that delegated it, without its control lease. -->
        <button
          type="button"
          class="pill-button primary"
          disabled={answering}
          onclick={() => engine.answerApproval(approval, true)}>Allow</button
        >
        <button
          type="button"
          class="pill-button"
          disabled={answering}
          onclick={() => engine.answerApproval(approval, false)}>Deny</button
        >
      {/if}
      <button type="button" class="pill-button" onclick={() => onselect(session.id)}>Reply</button>
    </div>
  </div>
{/snippet}

{#snippet sessionRow(session: SessionSummary, showWorkspace: boolean)}
  {@const workspace = workspaceById.get(session.workspaceId)}
  <div
    class="session-item"
    class:active={session.id === activeSessionId}
    class:unread={session.unread}
    class:renaming={renamingId === session.id}
    class:revealed={revealedId === session.id}
  >
    {#if renamingId === session.id}
      <form
        class="session-rename"
        onsubmit={(event) => {
          event.preventDefault();
          finishRename(true);
        }}
      >
        <input
          bind:this={renameInput}
          bind:value={renameValue}
          maxlength="200"
          aria-label="Session name"
          onkeydown={(event) => event.key === 'Escape' && finishRename(false)}
          onblur={() => finishRename(true)}
        />
      </form>
    {:else}
      <button
        class:active={session.id === activeSessionId}
        class="session-card"
        type="button"
        onclick={() => onselect(session.id)}
        ondblclick={() => startRename(session)}
        onkeydown={(event) => {
          if (event.key === 'F2') {
            event.preventDefault();
            void startRename(session);
          }
        }}
        aria-keyshortcuts="F2"
        aria-current={session.id === activeSessionId ? 'page' : undefined}
      >
        <span
          class:waiting={session.runStatus === 'waiting_input'}
          class:running={session.runStatus === 'running' || session.runStatus === 'queued'}
          class="status-dot"
          title={session.runStatus === 'waiting_input'
            ? 'Needs input'
            : session.runStatus === 'running'
              ? 'Working'
              : (session.runStatus ?? session.runnerStatus)}
        ></span>
        {#if session.origin?.kind === 'delegation'}<span
            class="origin-icon"
            title="Delegated: {session.origin.title}{session.origin.status
              ? ` (${DELEGATION_STATUS[session.origin.status]})`
              : ''}"><Forward size={13} /></span
          >{/if}
        <span class="session-name">{session.name}</span>
        <span class="session-meta">
          {#if session.writeLease}<span
              class="lease-lock"
              role="img"
              aria-label="Holds the write lease"
              title="Holds the {workspace?.displayName ?? 'workspace'} write lease"
              ><Lock size={12} /></span
            >{/if}
          {#if session.origin?.kind === 'delegation' && (session.origin.status === 'completed' || session.origin.status === 'failed')}<span
              class="delegation-status"
              class:failed={session.origin.status === 'failed'}
              title="The delegated task {DELEGATION_STATUS[session.origin.status]}"
              >{session.origin.status === 'completed' ? 'Done' : 'Failed'}</span
            >{/if}
          {#if showWorkspace && workspace}<span class="workspace-chip">{workspace.displayName}</span
            >{/if}
          {#if session.unread}<span class="unread-dot" role="img" aria-label="Unread"></span>{/if}
          <small>{shortAgo(session.lastActivityAt)}</small>
        </span>
      </button>
      {#if session.id !== activeSessionId && revealedId !== session.id}
        <button
          class="session-more"
          type="button"
          aria-label="Actions for {session.name}"
          onclick={() => (revealedId = session.id)}><Ellipsis size={16} /></button
        >
      {/if}
      <div class="session-actions">
        <button
          type="button"
          aria-label="Rename {session.name}"
          title="Rename (F2)"
          onclick={() => startRename(session)}><Pencil size={14} /></button
        >
      </div>
    {/if}
  </div>
{/snippet}

<style>
  /* ───────────── Left sidebar ───────────── */
  .sidebar {
    position: relative;
    z-index: 30;
    /* Fixed width: collapsing shrinks the grid track and slides this in sync,
    so the contents never reflow mid-animation. */
    width: var(--sidebar-width);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding-top: env(safe-area-inset-top);
    background: var(--bg-sidebar);
    border-right: 1px solid var(--line);
    transition:
      transform var(--layout-duration) var(--ease),
      visibility var(--layout-duration);
  }
  @media (min-width: 651px) {
    .sidebar.collapsed {
      visibility: hidden;
      transform: translateX(-100%);
    }
  }
  .brand-row .sidebar-collapse {
    margin-left: auto;
  }
  .brand-row {
    height: 56px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ink);
    text-decoration: none;
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .brand-mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    color: var(--on-accent);
    background: var(--accent);
  }
  .mobile-close,
  .mobile-menu {
    display: none;
  }
  .overview-entry {
    flex: none;
    margin: 0 12px 8px;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    color: var(--accent);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--accent-soft);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    transition: filter var(--ease) 0.15s;
  }
  .overview-entry:hover,
  .overview-entry.current {
    filter: brightness(0.94);
  }
  .search {
    flex: none;
    height: 36px;
    margin: 0 12px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    color: var(--muted);
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
  }
  .search:focus-within {
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line-dark);
  }
  .search input {
    min-width: 0;
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 13px;
  }
  .search input::placeholder {
    color: var(--muted);
  }
  /* Chats, projects and the work lists scroll together. */
  .sidebar-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-bottom: 12px;
  }
  .list-section {
    padding: 0 8px;
  }
  .list-section + .list-section {
    margin-top: 14px;
  }
  .section-heading {
    height: 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .section-heading strong {
    font-weight: 600;
  }
  .section-heading small {
    margin-left: auto;
    font-size: 11px;
    font-weight: 500;
  }
  .section-heading.attention {
    color: var(--warning);
  }
  .count-badge {
    margin-left: auto;
    min-width: 18px;
    padding: 0 6px;
    border-radius: 999px;
    color: var(--bg);
    background: var(--warning);
    font-size: 11px;
    line-height: 18px;
    text-align: center;
    letter-spacing: 0;
  }
  .heading-action {
    margin-left: auto;
    display: grid;
    place-items: center;
    height: 22px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }
  .heading-action:hover:not(:disabled) {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .section-heading small + .heading-action {
    margin-left: 0;
  }
  .empty-note {
    margin: 2px 10px 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .workspace-list {
    display: grid;
    gap: 2px;
  }
  .workspace-heading {
    height: 34px;
    display: flex;
    align-items: center;
    padding: 0 4px 0 10px;
    border-radius: var(--radius-sm);
  }
  .workspace-heading:hover {
    background: var(--bg-hover);
  }
  .workspace-heading > button:first-child {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--text-2);
    background: transparent;
    text-align: left;
  }
  .workspace-heading strong {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--ink);
    font-size: 14px;
    font-weight: 500;
  }
  .workspace-heading small {
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .workspace-heading.current {
    background: var(--bg-active);
  }
  .workspace-meta {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding-right: 4px;
  }
  .running-count {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .running-count .status-dot {
    margin-left: 0;
  }
  .session-list {
    display: grid;
    gap: 1px;
    margin-top: 1px;
  }
  .session-list.nested {
    padding-left: 12px;
  }
  .session-card {
    width: 100%;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 22px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    text-align: left;
  }
  .delegation-status {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--bg-layer);
    color: var(--success);
    font-size: 11px;
    line-height: 16px;
  }
  .delegation-status.failed {
    color: var(--danger);
  }
  .origin-icon {
    flex: none;
    display: grid;
    color: var(--muted);
  }
  .session-item {
    position: relative;
    min-width: 0;
  }
  .session-item:hover .session-card,
  .session-item:focus-within .session-card {
    background: var(--bg-hover);
  }
  .session-card.active,
  .session-item:hover .session-card.active,
  .session-item:focus-within .session-card.active {
    background: var(--bg-active);
    font-weight: 500;
  }
  .session-item.unread .session-name {
    font-weight: 600;
  }
  .session-meta {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .lease-lock {
    display: grid;
    color: var(--warning);
  }
  .workspace-chip {
    max-width: 72px;
    overflow: hidden;
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--muted);
    background: var(--bg-hover);
    font-size: 10.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* Row actions: pin, settle, delete (chats), rename. Shown on hover or keyboard focus; the
  name makes room so it is never covered. */
  .session-actions {
    position: absolute;
    top: 50%;
    right: 6px;
    display: flex;
    gap: 2px;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
  }
  .session-actions button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
  }
  .session-actions button:hover {
    color: var(--ink);
    background: var(--bg-hover-strong);
  }
  .session-item:hover .session-actions,
  .session-item:focus-within .session-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .session-item:hover .session-card,
  .session-item:focus-within .session-card {
    padding-right: calc(var(--action-count, 1) * 26px + 10px);
  }
  .session-item:hover .session-meta,
  .session-item:focus-within .session-meta {
    display: none;
  }
  .session-more {
    display: none;
  }
  @media (hover: none) {
    .session-item.active .session-actions,
    .session-item.revealed .session-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .session-item.active .session-card,
    .session-item.revealed .session-card {
      padding-right: calc(var(--action-count, 1) * 26px + 10px);
    }
    .session-item.active .session-meta,
    .session-item.revealed .session-meta {
      display: none;
    }
    /* Other rows: a "more" button after the time reveals the row's actions. */
    .session-more {
      position: absolute;
      top: 50%;
      right: 2px;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      color: var(--muted);
      background: transparent;
      transform: translateY(-50%);
    }
    .session-item:not(.active, .revealed) .session-card {
      padding-right: 40px;
    }
  }
  @media (hover: none) and (max-width: 650px) {
    .session-item.active .session-card,
    .session-item.revealed .session-card {
      padding-right: calc(var(--action-count, 1) * 34px + 10px);
    }
  }
  .session-rename {
    height: 36px;
    display: flex;
    align-items: center;
    padding: 0 6px 0 22px;
  }
  .session-rename input {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    color: var(--ink);
    background: var(--input);
    font: inherit;
    font-size: 14px;
    outline: none;
  }
  .session-rename input:focus {
    border-color: var(--accent);
  }
  .session-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 14px;
  }
  .session-card small {
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .status-dot {
    flex: none;
    width: 6px;
    height: 6px;
    margin-left: -14px;
    border-radius: 50%;
    background: transparent;
  }
  .status-dot.running {
    background: var(--accent);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .status-dot.waiting {
    background: var(--warning);
  }
  .unread-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .unread-count {
    flex: none;
    min-width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    padding: 0 5px;
    border-radius: 999px;
    color: var(--on-accent);
    background: var(--accent);
    font-size: 11px;
    font-weight: 600;
  }
  /* ── Needs you ── */
  .inbox-list {
    display: grid;
    gap: 4px;
  }
  .inbox-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg-layer);
  }
  .inbox-item[data-kind='missed'],
  .inbox-item[data-kind='memory'],
  .inbox-item:has(.inbox-approval) {
    flex-wrap: wrap;
  }
  .inbox-main {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--ink);
    background: transparent;
    text-align: left;
  }
  .inbox-main .status-dot {
    margin-left: 0;
  }
  .inbox-text {
    min-width: 0;
    display: grid;
  }
  .inbox-text strong,
  .inbox-text small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .inbox-text strong {
    font-size: 13px;
    font-weight: 500;
  }
  .inbox-text small {
    color: var(--muted);
    font-size: 11.5px;
  }
  .inbox-text small.inbox-approval {
    color: var(--text-2);
  }
  .inbox-actions {
    flex: none;
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  .pill-button {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }
  .pill-button:hover {
    color: var(--ink);
    background: var(--bg-hover-strong);
  }
  .pill-button.primary {
    color: var(--on-accent);
    background: var(--accent);
  }
  .pill-button.primary:hover {
    background: var(--accent-hover);
  }
  /* ── Devices ── */
  .host-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--faint);
  }
  .host-dot.online {
    background: var(--success);
  }
  .section-heading .host-dot + strong {
    text-transform: none;
    letter-spacing: 0;
  }
  /* ── Footer ── */
  .sidebar-footer {
    flex: none;
    display: grid;
    gap: 2px;
    padding: 6px 8px calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    margin-top: 6px;
  }
  .settings-entry {
    min-width: 0;
    min-height: 36px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 14px;
    text-align: left;
  }
  .settings-entry:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .sidebar-scrim {
    display: none;
  }
  @media (max-width: 650px) {
    /* The phone shows the list as a full page above the bottom tabs; closed, it
    is hidden (out of the focus order), not just moved off screen. */
    .sidebar {
      position: fixed;
      inset: 0 0 calc(56px + env(safe-area-inset-bottom)) 0;
      width: 100%;
      height: auto;
      visibility: hidden;
      border-right: 0;
      background: var(--bg);
      transform: translateX(-102%);
      transition:
        transform 0.22s var(--ease),
        visibility 0.22s;
    }
    .sidebar-collapse,
    .mobile-close,
    .sidebar-footer {
      display: none;
    }
    .sidebar.open {
      visibility: visible;
      transform: translateX(0);
    }
    .brand-row {
      padding: 0 12px 0 16px;
    }
    /* Touch-sized rows: fewer, larger targets instead of a dense desktop list. */
    .session-card {
      height: 44px;
    }
    .session-rename {
      height: 44px;
    }
    .workspace-heading {
      height: 42px;
    }
    .session-actions button {
      width: 32px;
      height: 32px;
    }
    .session-item:hover .session-card,
    .session-item:focus-within .session-card {
      padding-right: calc(var(--action-count, 1) * 34px + 10px);
    }
    .pill-button {
      height: 32px;
      padding: 0 12px;
    }
    .mobile-menu {
      position: fixed;
      z-index: 20;
      top: calc(8px + env(safe-area-inset-top));
      left: 6px;
      display: grid;
      width: 40px;
      height: 40px;
    }
  }
</style>
