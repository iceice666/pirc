<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Brain,
    CalendarClock,
    ChevronLeft,
    Clock,
    Command,
    Ellipsis,
    Folder,
    Forward,
    Lock,
    PanelLeftClose,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Search,
    Settings,
    Settings2,
    SquarePen,
    X,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { app, type InboxItem } from '../app.svelte';
  import { chatNodeIds, isChatWorkspace, topLevelChats } from '../chats';
  import { formatWall, until } from '../schedules';
  import { shortAgo } from '../time';
  import type { SessionSummary, Workspace } from '../types';
  import { watch } from '../watch.svelte';
  import { isRunning, pinnedFirst, sidebarSessions } from '../work';

  interface Props {
    open?: boolean;
    /** Desktop: slid out of the layout; the main column shows the expand button. */
    collapsed?: boolean;
    oncollapse: () => void;
    onselect: (id: string) => void;
    onnew: (workspaceId?: string) => void;
    /** Open a project's or workspace's page: all its sessions and its settings. */
    onopenworkspace: (workspaceId: string) => void;
    onaddworkspace: (nodeId: string) => void;
    /** New chat project on the chat node. */
    onaddproject: (nodeId: string) => void;
    onclose: () => void;
    onsettings: () => void;
    /** Show the schedules page. */
    onschedules?: () => void;
    /** Review memory changes in Settings. */
    onmemory?: () => void;
  }

  let {
    open = $bindable(false),
    collapsed = false,
    oncollapse,
    onselect,
    onnew,
    onopenworkspace,
    onaddworkspace,
    onaddproject,
    onclose,
    onsettings,
    onschedules,
    onmemory,
  }: Props = $props();

  const nodes = $derived(app.nodes);
  /** Nodes that can host directory workspaces (not the chat node). */
  const deviceNodes = $derived.by(() => {
    const chatNodes = chatNodeIds(app.workspaces);
    return nodes.filter((node) => !chatNodes.has(node.id));
  });
  const sessions = $derived(app.sessions);
  /** The open session, unless a page covers it. */
  const activeSessionId = $derived(app.view === 'session' ? app.activeSessionId : undefined);
  /** The project or workspace whose page is showing. */
  const pageId = $derived(app.view === 'workspace' ? app.workspaceViewId : undefined);
  const onrename = (id: string, name: string) => app.updateSession(id, { name });
  const onpin = (id: string, pinned: boolean) => app.updateSession(id, { pinned });
  const onsettle = (id: string, settled: boolean) => app.updateSession(id, { settled });

  /** Chats: the assistant's chats and projects, like the ChatGPT and Claude web apps. */
  const chats = $derived(topLevelChats(app.workspaces));
  const projects = $derived(
    app.workspaces.filter((workspace) => isChatWorkspace(workspace) && workspace !== chats),
  );
  const workspaceById = $derived(new Map(app.workspaces.map((item) => [item.id, item])));
  /** Without a chat node there are no chats: only Work. */
  const mode = $derived(chats ? app.mode : 'work');

  let query = $state('');
  let renamingId: string | undefined = $state();
  let renameValue = $state('');
  let renameInput: HTMLInputElement | undefined = $state();

  // ── Chat mode ──
  /** Top-level chats, pinned first, then by activity; settled ones are on the Chats page. */
  const topChats = $derived(
    chats
      ? pinnedFirst(
          sessions.filter((session) => session.workspaceId === chats.id && !session.settled),
        )
      : [],
  );

  // ── Work mode ──
  const directoryWorkspaces = $derived(app.workspaces.filter((w) => !isChatWorkspace(w)));
  /** Devices with their workspaces (connected devices without any too), online first. */
  const hosts = $derived.by(() => {
    const ids = [
      ...new Set([...directoryWorkspaces.map((w) => w.hostId), ...deviceNodes.map((n) => n.id)]),
    ];
    const online = (id: string) => nodes.some((node) => node.id === id);
    return ids
      .sort((a, b) => Number(online(b)) - Number(online(a)) || a.localeCompare(b))
      .map((id) => ({
        id,
        online: online(id),
        workspaces: directoryWorkspaces.filter((w) => w.hostId === id),
      }));
  });
  const inbox = $derived(app.inbox);

  /** Searching lists every matching session of the mode, whatever its workspace. */
  const results = $derived.by(() => {
    if (!query) return [];
    const needle = query.toLowerCase();
    return sessions.filter((session) => {
      const workspace = workspaceById.get(session.workspaceId);
      return (
        !!workspace &&
        isChatWorkspace(workspace) === (mode === 'chat') &&
        session.name.toLowerCase().includes(needle)
      );
    });
  });
  /** New session: straight into the workspace whose page is open, else a dialog to pick one. */
  const pageWorkspace = $derived(pageId ? workspaceById.get(pageId) : undefined);
  const newSessionTarget = $derived(
    pageWorkspace && !isChatWorkspace(pageWorkspace) ? pageWorkspace : undefined,
  );

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
   * Touch screens have no hover: a row's pin/settle/rename buttons show on the
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

  function nextRunText() {
    const next = app.nextSchedule;
    if (!next?.nextRunAt) return '';
    return `${next.title} · ${until(next.nextRunAt)}`;
  }
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
  data-mode={mode}
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
  {#if chats}
    <div class="mode-switch" role="group" aria-label="Sidebar mode">
      <button
        type="button"
        class:chosen={mode === 'chat'}
        aria-pressed={mode === 'chat'}
        onclick={() => app.setMode('chat')}>Chat</button
      >
      <button
        type="button"
        class:chosen={mode === 'work'}
        aria-pressed={mode === 'work'}
        onclick={() => app.setMode('work')}
        >Work{#if app.inbox.length && mode !== 'work'}<span
            class="attention-dot"
            title="{app.inbox.length} waiting for you"
          ></span>{/if}</button
      >
    </div>
  {/if}
  {#if mode === 'chat' && chats}
    <button
      class="new-session"
      type="button"
      onclick={() => onnew(chats.id)}
      disabled={!app.workspaceOnline(chats)}><SquarePen size={16} /> New chat</button
    >
  {:else}
    <button
      class="new-session"
      type="button"
      onclick={() => (newSessionTarget ? onnew(newSessionTarget.id) : onnew())}
      ><SquarePen size={16} /> New session</button
    >
  {/if}
  <label class="search">
    <Search size={16} />
    <span class="sr-only">Search sessions</span>
    <input bind:value={query} placeholder={mode === 'chat' ? 'Search chats' : 'Search sessions'} />
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
    {:else if mode === 'chat' && chats}
      <section class="list-section" aria-label="Projects">
        <div class="section-heading">
          <strong>Projects</strong>
          <button
            class="heading-action"
            type="button"
            onclick={() => onaddproject(chats.hostId)}
            disabled={!app.workspaceOnline(chats)}
            aria-label="New project"><Plus size={15} /></button
          >
        </div>
        <div class="workspace-list">
          {#each projects as project (project.id)}
            {@render workspaceRow(project, false)}
          {:else}
            <p class="empty-note">Group related chats into a project.</p>
          {/each}
        </div>
      </section>
      <section class="list-section" aria-label="Chats">
        <div class="section-heading">
          <strong>Chats</strong>
          {#if !app.workspaceOnline(chats)}<small>offline</small>{/if}
          <button
            class="heading-action"
            class:current={pageId === chats.id}
            type="button"
            title="All chats and their settings"
            aria-label="All chats and their settings"
            onclick={() => onopenworkspace(chats.id)}><Settings2 size={14} /></button
          >
        </div>
        <div class="session-list">
          {#each topChats as session (session.id)}
            {@render sessionRow(session, false)}
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
              {@render workspaceRow(workspace, true)}
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
    {#if mode === 'work'}
      <button
        class="settings-entry schedules-entry"
        class:current={app.view === 'schedules'}
        type="button"
        onclick={onschedules}
      >
        <CalendarClock size={17} />
        <span class="entry-text"
          ><span>Schedules</span>{#if nextRunText()}<small>Next: {nextRunText()}</small>{/if}</span
        >
      </button>
    {/if}
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

<!-- A project or workspace: one row that opens its page, with its unread sessions under it. -->
{#snippet workspaceRow(workspace: Workspace, work: boolean)}
  {@const list = sidebarSessions(sessions, workspace.id, activeSessionId, work)}
  {@const unread = unreadIn(workspace.id)}
  {@const running = work ? runningIn(workspace.id) : 0}
  {@const online = app.workspaceOnline(workspace)}
  <section class="workspace-group">
    <div class="workspace-heading" class:current={pageId === workspace.id}>
      <button
        type="button"
        onclick={() => onopenworkspace(workspace.id)}
        aria-current={pageId === workspace.id ? 'page' : undefined}
      >
        <Folder size={15} />
        <strong>{workspace.displayName}</strong>
        {#if !online && !work}<small>· offline</small>{/if}
        <span class="workspace-meta">
          {#if work && sessions.some((s) => s.writeLease && s.workspaceId === workspace.id)}<span
              class="lease-lock"
              role="img"
              aria-label="A session holds the write lease"
              title="A session holds the write lease"><Lock size={12} /></span
            >{/if}
          {#if running}<small class="running-count" title="{running} running"
              ><span class="status-dot running"></span>{running}</small
            >{/if}
          {#if unread}<span class="unread" aria-label="{unread} unread">{unread}</span>{/if}
        </span>
      </button>
      <button
        class="mini-action"
        type="button"
        aria-label="New {work ? 'session' : 'chat'} in {workspace.displayName}"
        disabled={!online}
        onclick={() => onnew(workspace.id)}><Plus size={15} /></button
      >
    </div>
    {#if list.length}
      <div class="session-list nested">
        {#each list as session (session.id)}{@render sessionRow(session, false)}{/each}
      </div>
    {/if}
  </section>
{/snippet}

{#snippet inboxRow(item: InboxItem)}
  <div class="inbox-item" data-kind={item.kind}>
    {#if item.kind === 'session'}
      {@const session = item.session}
      <button class="inbox-main" type="button" onclick={() => onselect(session.id)}>
        <span class="status-dot waiting"></span>
        <span class="inbox-text">
          <strong>{session.name}</strong>
          <small
            >{session.origin
              ? `${session.origin.kind === 'schedule' ? 'Scheduled' : 'Delegated'} · ${session.origin.title}`
              : (workspaceById.get(session.workspaceId)?.displayName ?? '')} · waiting for you</small
          >
        </span>
      </button>
      <div class="inbox-actions">
        <button type="button" class="pill-button" onclick={() => onselect(session.id)}>Reply</button
        >
      </div>
    {:else if item.kind === 'missed'}
      <div class="inbox-main">
        <span class="inbox-icon"><Clock size={14} /></span>
        <span class="inbox-text">
          <strong>{item.schedule.title}</strong>
          <small>Missed · {formatWall(item.run.dueAt, item.schedule.timezone)}</small>
        </span>
      </div>
      <div class="inbox-actions">
        <button
          type="button"
          class="pill-button primary"
          onclick={() => app.decideMissed(item.schedule.id, item.run.id, true)}
          >Allow &amp; run</button
        >
        <button
          type="button"
          class="pill-button"
          onclick={() => app.decideMissed(item.schedule.id, item.run.id, false)}>Dismiss</button
        >
      </div>
    {:else}
      {@const proposal = item.proposal}
      <button class="inbox-main" type="button" onclick={onmemory}>
        <span class="inbox-icon"><Brain size={14} /></span>
        <span class="inbox-text">
          <strong
            >{proposal.action === 'add'
              ? 'Remember'
              : proposal.action === 'remove'
                ? 'Forget'
                : 'Update memory'}</strong
          >
          <small title={proposal.content ?? proposal.target?.content ?? ''}
            >{proposal.content ?? proposal.target?.content ?? ''}</small
          >
        </span>
      </button>
      <div class="inbox-actions">
        <button
          type="button"
          class="pill-button primary"
          onclick={() => app.decideProposal(proposal, true)}>Approve</button
        >
        <button
          type="button"
          class="pill-button"
          onclick={() => app.decideProposal(proposal, false)}>Reject</button
        >
      </div>
    {/if}
  </div>
{/snippet}

{#snippet sessionRow(session: SessionSummary, showWorkspace: boolean)}
  {@const workspace = workspaceById.get(session.workspaceId)}
  <div
    class="session-item"
    class:active={session.id === activeSessionId}
    class:settled={session.settled}
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
        {#if session.origin?.kind === 'schedule'}<span
            class="origin-icon"
            title="Scheduled: {session.origin.title}"><Clock size={13} /></span
          >{:else if session.origin?.kind === 'delegation'}<span
            class="origin-icon"
            title="Delegated: {session.origin.title}"><Forward size={13} /></span
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
          {#if session.pinned}<span class="pin-mark" title="Pinned"><Pin size={12} /></span>{/if}
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
          aria-label={session.pinned ? `Unpin ${session.name}` : `Pin ${session.name}`}
          title={session.pinned ? 'Unpin' : 'Pin'}
          onclick={() => onpin(session.id, !session.pinned)}
          >{#if session.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}</button
        >
        <button
          type="button"
          aria-label={session.settled ? `Reopen ${session.name}` : `Settle ${session.name}`}
          title={session.settled ? 'Reopen' : 'Settle'}
          onclick={() => onsettle(session.id, !session.settled)}
          >{#if session.settled}<ArchiveRestore size={14} />{:else}<Archive
              size={14}
            />{/if}</button
        >
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
  /* Chat / Work */
  .mode-switch {
    flex: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    margin: 0 12px 10px;
    padding: 3px;
    border-radius: var(--radius-md);
    background: var(--bg-hover);
  }
  .mode-switch button {
    position: relative;
    height: 30px;
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
    color: var(--muted);
    background: transparent;
    font-size: 13px;
    font-weight: 500;
  }
  .mode-switch button:hover:not(.chosen) {
    color: var(--ink);
  }
  .mode-switch button.chosen {
    color: var(--ink);
    background: var(--bg-layer);
    box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  }
  .attention-dot {
    position: absolute;
    top: 8px;
    margin-left: 4px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning);
  }
  .new-session {
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
  .new-session:hover {
    filter: brightness(0.97);
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
  .heading-action:hover:not(:disabled),
  .heading-action.current {
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
  .mini-action {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
    opacity: 0;
  }
  .workspace-heading:hover .mini-action,
  .mini-action:focus-visible {
    opacity: 1;
  }
  .mini-action:hover {
    color: var(--ink);
    background: var(--bg-hover-strong);
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
  .session-item.settled .session-name {
    color: var(--muted);
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
  .pin-mark {
    display: grid;
    color: var(--faint);
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
  /* Row actions: pin, settle, rename. Shown on hover or keyboard focus; the
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
    padding-right: 88px;
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
      padding-right: 88px;
    }
    .session-item.active .session-meta,
    .session-item.revealed .session-meta {
      display: none;
    }
    .mini-action {
      opacity: 1;
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
      padding-right: 112px;
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
  .unread {
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
  .inbox-item[data-kind='memory'] {
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
  .inbox-icon {
    flex: none;
    display: grid;
    color: var(--warning);
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
  .settings-entry:hover,
  .settings-entry.current {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .entry-text {
    min-width: 0;
    display: grid;
  }
  .entry-text small {
    overflow: hidden;
    color: var(--muted);
    font-size: 11.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
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
    .mode-switch,
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
    .mini-action,
    .session-actions button {
      width: 32px;
      height: 32px;
    }
    .session-item:hover .session-card,
    .session-item:focus-within .session-card {
      padding-right: 112px;
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
