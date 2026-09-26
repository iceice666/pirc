<script lang="ts">
  import {
    ChevronDown,
    Command,
    Menu,
    MoreHorizontal,
    PanelLeftClose,
    Plus,
    Search,
    SquarePen,
    X,
  } from '@lucide/svelte';
  import type { NodeSummary, SessionSummary, Workspace } from '../types';

  export let workspaces: Workspace[];
  export let nodes: NodeSummary[] = [];
  export let sessions: SessionSummary[];
  export let activeSessionId: string | undefined;
  export let open = false;
  /** Desktop: slid out of the layout; the main column shows the expand button. */
  export let collapsed = false;
  export let oncollapse: () => void;
  export let onselect: (id: string) => void;
  export let onnew: (workspaceId?: string) => void;
  export let onaddworkspace: (nodeId: string) => void;
  export let onclose: () => void;

  let query = '';
  let collapsedGroups = new Set<string>();
  let selectedNodeId = '';
  $: if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = '';
  $: shownWorkspaces = workspaces.filter(
    (workspace) => !selectedNodeId || workspace.hostId === selectedNodeId,
  );

  $: visibleSessions = sessions.filter((session) =>
    session.name.toLowerCase().includes(query.toLowerCase()),
  );

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
    on:click={onclose}
  ></button>{/if}
<aside class:open class:collapsed class="sidebar" aria-label="Sessions" inert={collapsed && !open}>
  <div class="brand-row">
    <a class="brand" href="/" aria-label="Relay home">
      <span class="brand-mark"><Command size={16} /></span><span>Relay</span>
    </a>
    <button
      class="sidebar-collapse icon-button"
      type="button"
      aria-label="Hide sidebar"
      title="Hide sidebar"
      on:click={oncollapse}><PanelLeftClose size={18} /></button
    >
    <button
      class="mobile-close icon-button"
      type="button"
      aria-label="Close navigation"
      on:click={onclose}><X size={19} /></button
    >
  </div>
  <button class="new-session" type="button" on:click={() => onnew()}
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
      <button type="button" class:chosen={!selectedNodeId} on:click={() => (selectedNodeId = '')}
        >All</button
      >
      {#each nodes as node}
        <button
          type="button"
          class:chosen={selectedNodeId === node.id}
          on:click={() => (selectedNodeId = node.id)}>{node.id}</button
        >
      {/each}
    </div>
  </div>
  <div class="workspace-tools">
    <strong>Workspaces</strong>
    <button
      type="button"
      on:click={() => onaddworkspace(selectedNodeId || nodes[0]?.id)}
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
            on:click={() => toggleWorkspace(workspace.id)}
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
            on:click={() => onnew(workspace.id)}><Plus size={15} /></button
          >
        </div>
        {#if !collapsedGroups.has(workspace.id)}
          <div class="session-list">
            {#each visibleSessions.filter((session) => session.workspaceId === workspace.id) as session}
              <button
                class:active={session.id === activeSessionId}
                class="session-card"
                type="button"
                on:click={() => onselect(session.id)}
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
                {#if session.unreadCount}<span class="unread">{session.unreadCount}</span
                  >{:else}<small>{relativeTime(session.lastActivityAt)}</small>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </nav>

  <div class="sidebar-footer">
    <div class="host-status">
      <span></span>
      <div><strong>Devices</strong><small>{nodes.length} online · Private VPN</small></div>
    </div>
    <button class="icon-button" type="button" aria-label="More options"
      ><MoreHorizontal size={19} /></button
    >
  </div>
</aside>

<button
  class="mobile-menu icon-button"
  type="button"
  aria-label="Open navigation"
  on:click={() => (open = true)}><Menu size={21} /></button
>
