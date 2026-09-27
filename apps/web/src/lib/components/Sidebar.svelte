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
  import type { NodeSummary, SessionSummary, Workspace } from '../types';

  interface Props {
    workspaces: Workspace[];
    nodes?: NodeSummary[];
    sessions: SessionSummary[];
    activeSessionId: string | undefined;
    open?: boolean;
    /** Desktop: slid out of the layout; the main column shows the expand button. */
    collapsed?: boolean;
    oncollapse: () => void;
    onselect: (id: string) => void;
    onnew: (workspaceId?: string) => void;
    onaddworkspace: (nodeId: string) => void;
    onclose: () => void;
    onrename: (id: string, name: string) => void;
    onpin: (id: string, pinned: boolean) => void;
    onsettle: (id: string, settled: boolean) => void;
    onsettings: () => void;
    /** Settled sessions are hidden entirely unless enabled in settings. */
    showSettled?: boolean;
  }

  let {
    workspaces,
    nodes = [],
    sessions,
    activeSessionId,
    open = $bindable(false),
    collapsed = false,
    oncollapse,
    onselect,
    onnew,
    onaddworkspace,
    onclose,
    onrename,
    onpin,
    onsettle,
    onsettings,
    showSettled = false,
  }: Props = $props();

  let query = $state('');
  let collapsedGroups = $state(new Set<string>());
  let selectedNodeId = $state('');
  $effect.pre(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = '';
  });
  let shownWorkspaces = $derived(
    workspaces.filter((workspace) => !selectedNodeId || workspace.hostId === selectedNodeId),
  );

  let visibleSessions = $derived(
    sessions.filter((session) => session.name.toLowerCase().includes(query.toLowerCase())),
  );

  /** Workspaces whose settled sessions are shown; searching shows them all. */
  let openSettled = $state(new Set<string>());
  let renamingId: string | undefined = $state();
  let renameValue = $state('');
  let renameInput: HTMLInputElement | undefined = $state();

  /** Pinned first, then by activity (the order the gateway already returns). */
  function groupSessions(all: SessionSummary[], workspaceId: string) {
    const own = all.filter((session) => session.workspaceId === workspaceId);
    const open = own.filter((session) => !session.settled);
    return {
      open: [
        ...open.filter((session) => session.pinned),
        ...open.filter((session) => !session.pinned),
      ],
      settled: own.filter((session) => session.settled),
    };
  }

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

  function relativeTime(date: string): string {
    const delta = Date.now() - new Date(date).getTime();
    if (delta < 60_000) return 'now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
    return `${Math.floor(delta / 86_400_000)}d`;
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

  <div class="device-switcher" aria-label="Select device">
    <strong>Devices</strong>
    <div class="device-options">
      <button type="button" class:chosen={!selectedNodeId} onclick={() => (selectedNodeId = '')}
        >All</button
      >
      {#each nodes as node}
        <button
          type="button"
          class:chosen={selectedNodeId === node.id}
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
    {#each shownWorkspaces as workspace}
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
          {@const groups = groupSessions(visibleSessions, workspace.id)}
          <div class="session-list">
            {#each groups.open as session (session.id)}
              {@render sessionRow(session)}
            {/each}
            {#if showSettled && groups.settled.length}
              <button
                class="settled-toggle"
                type="button"
                aria-expanded={!!query || openSettled.has(workspace.id)}
                onclick={() => toggleSettled(workspace.id)}
              >
                <span class:collapsed={!query && !openSettled.has(workspace.id)} class="chevron">
                  <ChevronDown size={13} />
                </span>
                Settled · {groups.settled.length}
              </button>
              {#if query || openSettled.has(workspace.id)}
                {#each groups.settled as session (session.id)}
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
              >{relativeTime(session.lastActivityAt)}</small
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
          title="Rename"
          onclick={() => startRename(session)}><Pencil size={14} /></button
        >
      </div>
    {/if}
  </div>
{/snippet}
