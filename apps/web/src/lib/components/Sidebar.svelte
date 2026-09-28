<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    ChevronDown,
    Command,
    Menu,
    PanelLeftClose,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Search,
    Settings,
    SquarePen,
    X,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { app } from '../app.svelte';
  import { shortAgo } from '../time';
  import type { SessionSummary } from '../types';

  interface Props {
    open?: boolean;
    /** Desktop: slid out of the layout; the main column shows the expand button. */
    collapsed?: boolean;
    oncollapse: () => void;
    onselect: (id: string) => void;
    onnew: (workspaceId?: string) => void;
    onaddworkspace: (nodeId: string) => void;
    onclose: () => void;
    onsettings: () => void;
    /** Settled sessions are hidden entirely unless enabled in settings. */
    showSettled?: boolean;
  }

  let {
    open = $bindable(false),
    collapsed = false,
    oncollapse,
    onselect,
    onnew,
    onaddworkspace,
    onclose,
    onsettings,
    showSettled = false,
  }: Props = $props();

  const nodes = $derived(app.nodes);
  const sessions = $derived(app.sessions);
  const activeSessionId = $derived(app.activeSessionId);
  const onrename = (id: string, name: string) => app.updateSession(id, { name });
  const onpin = (id: string, pinned: boolean) => app.updateSession(id, { pinned });
  const onsettle = (id: string, settled: boolean) => app.updateSession(id, { settled });

  let query = $state('');
  let collapsedGroups = $state(new Set<string>());
  let selectedNodeId = $state('');
  $effect.pre(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = '';
  });
  let shownWorkspaces = $derived(
    app.workspaces.filter((workspace) => !selectedNodeId || workspace.hostId === selectedNodeId),
  );

  let visibleSessions = $derived(
    sessions.filter((session) => session.name.toLowerCase().includes(query.toLowerCase())),
  );

  /** Workspaces whose settled sessions are shown; searching shows them all. */
  let openSettled = $state(new Set<string>());
  let renamingId: string | undefined = $state();
  let renameValue = $state('');
  let renameInput: HTMLInputElement | undefined = $state();

  /**
   * Sessions per workspace, pinned first, then by activity (the order the
   * gateway already returns). One pass over all sessions, not one per workspace.
   */
  let groups = $derived.by(() => {
    const map = new Map<string, { open: SessionSummary[]; settled: SessionSummary[] }>();
    const pinned = new Map<string, SessionSummary[]>();
    for (const session of visibleSessions) {
      let group = map.get(session.workspaceId);
      if (!group) map.set(session.workspaceId, (group = { open: [], settled: [] }));
      if (session.settled) group.settled.push(session);
      else if (session.pinned) {
        const list = pinned.get(session.workspaceId) ?? [];
        list.push(session);
        pinned.set(session.workspaceId, list);
      } else group.open.push(session);
    }
    for (const [workspaceId, list] of pinned) map.get(workspaceId)!.open.unshift(...list);
    return map;
  });
  const EMPTY_GROUP = { open: [], settled: [] };

  function toggleSettled(id: string) {
    const next = new Set(openSettled);
    next.has(id) ? next.delete(id) : next.add(id);
    openSettled = next;
  }

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

  function toggleWorkspace(id: string) {
    const next = new Set(collapsedGroups);
    next.has(id) ? next.delete(id) : next.add(id);
    collapsedGroups = next;
  }
</script>

{#if open}<button
    class="sidebar-scrim"
    type="button"
    aria-label="Close navigation"
    onclick={onclose}
  ></button>{/if}
<aside class:open class:collapsed class="sidebar" aria-label="Sessions" inert={collapsed && !open}>
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
      class="mobile-close icon-button"
      type="button"
      aria-label="Close navigation"
      onclick={onclose}><X size={19} /></button
    >
  </div>
  <button class="new-session" type="button" onclick={() => onnew()}
    ><SquarePen size={16} /> New session</button
  >
  <label class="search">
    <Search size={16} />
    <span class="sr-only">Search sessions</span>
    <input bind:value={query} placeholder="Search sessions" />
  </label>

  <div class="device-switcher" role="group" aria-label="Select device">
    <strong>Devices</strong>
    <div class="device-options">
      <button
        type="button"
        class:chosen={!selectedNodeId}
        aria-pressed={!selectedNodeId}
        onclick={() => (selectedNodeId = '')}>All</button
      >
      {#each nodes as node (node.id)}
        <button
          type="button"
          class:chosen={selectedNodeId === node.id}
          aria-pressed={selectedNodeId === node.id}
          onclick={() => (selectedNodeId = node.id)}>{node.id}</button
        >
      {/each}
    </div>
  </div>
  <div class="workspace-tools">
    <strong>Workspaces</strong>
    <button
      type="button"
      onclick={() => onaddworkspace(selectedNodeId || nodes[0]?.id)}
      disabled={!nodes.length}
      aria-label="Add workspace"><Plus size={16} /> Add</button
    >
  </div>
  <nav class="workspace-list">
    {#each shownWorkspaces as workspace (workspace.id)}
      <section class="workspace-group">
        <div class="workspace-heading">
          <button
            type="button"
            onclick={() => toggleWorkspace(workspace.id)}
            aria-expanded={!collapsedGroups.has(workspace.id)}
          >
            <span class:collapsed={collapsedGroups.has(workspace.id)} class="chevron">
              <ChevronDown size={15} />
            </span>
            <strong>{workspace.displayName}</strong>
            <small
              >· {workspace.hostId}{nodes.some((node) => node.id === workspace.hostId)
                ? ' · online'
                : workspace.id.includes(':')
                  ? ' · offline'
                  : ''}</small
            >
          </button>
          <button
            class="mini-action"
            type="button"
            aria-label="New session in {workspace.displayName}"
            onclick={() => onnew(workspace.id)}><Plus size={15} /></button
          >
        </div>
        {#if !collapsedGroups.has(workspace.id)}
          {@const group = groups.get(workspace.id) ?? EMPTY_GROUP}
          <div class="session-list">
            {#each group.open as session (session.id)}
              {@render sessionRow(session)}
            {/each}
            {#if showSettled && group.settled.length}
              <button
                class="settled-toggle"
                type="button"
                aria-expanded={!!query || openSettled.has(workspace.id)}
                onclick={() => toggleSettled(workspace.id)}
              >
                <span class:collapsed={!query && !openSettled.has(workspace.id)} class="chevron">
                  <ChevronDown size={13} />
                </span>
                Settled · {group.settled.length}
              </button>
              {#if query || openSettled.has(workspace.id)}
                {#each group.settled as session (session.id)}
                  {@render sessionRow(session)}
                {/each}
              {/if}
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </nav>

  <div class="sidebar-footer">
    <button class="settings-entry" type="button" onclick={onsettings}>
      <Settings size={17} />
      <span>Settings</span>
    </button>
  </div>
</aside>

<button
  class="mobile-menu icon-button"
  type="button"
  aria-label="Open navigation"
  onclick={() => (open = true)}><Menu size={21} /></button
>

{#snippet sessionRow(session: SessionSummary)}
  <div
    class="session-item"
    class:active={session.id === activeSessionId}
    class:settled={session.settled}
    class:renaming={renamingId === session.id}
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
          class:running={session.runStatus === 'running'}
          class="status-dot"
          title={session.runStatus === 'waiting_input'
            ? 'Needs input'
            : session.runStatus === 'running'
              ? 'Working'
              : (session.runStatus ?? session.runnerStatus)}
        ></span>
        <span class="session-name">{session.name}</span>
        <span class="session-meta">
          {#if session.pinned}<span class="pin-mark" title="Pinned"><Pin size={12} /></span>{/if}
          {#if session.unreadCount}<span class="unread">{session.unreadCount}</span>{:else}<small
              >{shortAgo(session.lastActivityAt)}</small
            >{/if}
        </span>
      </button>
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
  .new-session {
    margin: 4px 12px 8px;
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
  .device-switcher,
  .workspace-tools {
    margin: 0 16px 10px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
  }
  .device-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .device-options button,
  .workspace-tools button {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 12px;
  }
  .device-options button:hover,
  .workspace-tools button:hover:not(:disabled) {
    background: var(--bg-hover-strong);
  }
  .device-options button.chosen {
    color: var(--bg);
    background: var(--ink);
  }
  .workspace-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .workspace-tools button {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 0 8px;
    background: transparent;
  }
  .workspace-list {
    flex: 1;
    overflow: auto;
    padding: 0 8px 16px;
  }
  .workspace-group + .workspace-group {
    margin-top: 8px;
  }
  .workspace-heading {
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 4px 0 8px;
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
    gap: 6px;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .workspace-heading strong {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
  }
  .workspace-heading small {
    overflow: hidden;
    flex: none;
    max-width: 45%;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .chevron {
    display: grid;
    color: var(--muted);
    transition: transform 0.18s var(--ease);
  }
  .chevron.collapsed {
    transform: rotate(-90deg);
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
  .session-card {
    width: 100%;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 28px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    text-align: left;
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
  @media (hover: none) {
    .session-item.active .session-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .session-item.active .session-card {
      padding-right: 88px;
    }
    .session-item.active .session-meta {
      display: none;
    }
    .mini-action {
      opacity: 1;
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
  .settled-toggle {
    height: 28px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px 0 24px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    text-align: left;
  }
  .settled-toggle:hover {
    color: var(--text-2);
    background: var(--bg-hover);
  }
  .settled-toggle .chevron {
    color: inherit;
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
  .sidebar-footer {
    min-height: calc(56px + env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px env(safe-area-inset-bottom);
    border-top: 1px solid var(--line);
  }
  .settings-entry {
    flex: 1;
    min-width: 0;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
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
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(86vw, 300px);
      transform: translateX(-102%);
      box-shadow: var(--shadow-pop);
      transition: transform 0.22s var(--ease);
    }
    .sidebar-collapse {
      display: none;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .sidebar-scrim {
      position: fixed;
      z-index: 29;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      padding: 0;
      border: 0;
      background: rgb(0 0 0 / 35%);
    }
    .mobile-close {
      display: grid;
      width: 40px;
      height: 40px;
      margin-right: -8px;
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
      height: 40px;
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
