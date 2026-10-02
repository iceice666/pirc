<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    ChevronDown,
    Clock,
    Folder,
    Forward,
    Lock,
    MessageSquare,
    PanelLeftOpen,
    Pencil,
    Pin,
    PinOff,
    Search,
    SquarePen,
  } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { rovingFocus } from '../a11y';
  import { app } from '../app.svelte';
  import { isChatWorkspace, isTopLevelChats } from '../chats';
  import { shortAgo } from '../time';
  import type { SessionSummary, Workspace } from '../types';
  import { watch } from '../watch.svelte';
  import { foldRecent, isRunning, needsInput, pinnedFirst } from '../work';
  import ProjectInstructions from './ProjectInstructions.svelte';
  import ProjectSettings from './ProjectSettings.svelte';

  interface Props {
    workspace: Workspace;
    /** Desktop: the sidebar is hidden, so the page offers the button to show it. */
    sidebarCollapsed?: boolean;
    onexpand?: () => void;
    onselect: (sessionId: string) => void;
    onnew: (workspaceId: string) => void;
    /** Settled (done) sessions are listed (Settings → General). */
    showSettled?: boolean;
  }

  let {
    workspace,
    sidebarCollapsed = false,
    onexpand,
    onselect,
    onnew,
    showSettled = false,
  }: Props = $props();

  const chat = $derived(isChatWorkspace(workspace));
  const topLevel = $derived(isTopLevelChats(workspace));
  const online = $derived(app.workspaceOnline(workspace));
  const noun = $derived(chat ? 'chat' : 'session');
  const subtitle = $derived(
    [
      chat ? (topLevel ? 'Chats' : 'Project') : 'Workspace',
      chat ? '' : workspace.hostId,
      online ? '' : 'offline',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  type Tab = 'sessions' | 'settings';
  let tab = $state<Tab>('sessions');
  let query = $state('');
  let showDone = $state(false);
  // Each page starts on its list, with the done ones as Settings says.
  watch(
    () => workspace.id,
    () => {
      tab = 'sessions';
      query = '';
      showDone = showSettled;
    },
    { immediate: true },
  );

  const all = $derived(app.sessions.filter((session) => session.workspaceId === workspace.id));
  const matching = $derived(
    query ? all.filter((session) => session.name.toLowerCase().includes(query.toLowerCase())) : all,
  );
  const settledCount = $derived(matching.filter((session) => session.settled).length);
  /** Pinned first, then by activity, with the runs of one schedule folded into one row. */
  const rows = $derived(
    foldRecent(pinnedFirst(matching.filter((session) => showDone || query || !session.settled))),
  );
  let openFolds = $state(new Set<string>());
  function toggleIn(set: Set<string>, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  const running = $derived(all.filter(isRunning).length);
  const unread = $derived(all.filter((session) => session.unread).length);
  const leaseHolder = $derived(all.find((session) => session.writeLease));

  let renamingId: string | undefined = $state();
  let renameValue = $state('');
  let renameInput: HTMLInputElement | undefined = $state();
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
    const current = all.find((session) => session.id === id);
    if (commit && name && current && name !== current.name) void app.updateSession(id, { name });
  }

  function status(session: SessionSummary) {
    if (needsInput(session)) return 'Needs input';
    if (isRunning(session)) return 'Working';
    return session.unread ? 'Unread' : '';
  }
</script>

<section class="workspace-page" aria-labelledby="workspace-title">
  <header class="page-bar">
    {#if sidebarCollapsed}
      <button
        class="icon-button"
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar"
        onclick={onexpand}><PanelLeftOpen size={19} /></button
      >
    {/if}
    <span class="page-icon">
      {#if chat}<MessageSquare size={18} />{:else}<Folder size={18} />{/if}
    </span>
    <div class="page-title">
      <h1 id="workspace-title">{workspace.displayName}</h1>
      <small>{subtitle}</small>
    </div>
    <button
      class="button dark new-in"
      type="button"
      disabled={!online}
      onclick={() => onnew(workspace.id)}><SquarePen size={15} /> New {noun}</button
    >
  </header>

  <div
    class="page-tabs"
    role="tablist"
    aria-label="{workspace.displayName} sections"
    use:rovingFocus={{ selector: '[role="tab"]', orientation: 'horizontal', activate: true }}
  >
    {#each [{ id: 'sessions' as Tab, label: chat ? 'Chats' : 'Sessions' }, { id: 'settings' as Tab, label: 'Settings' }] as item (item.id)}
      <button
        type="button"
        role="tab"
        id="workspace-tab-{item.id}"
        aria-controls="workspace-panel-{item.id}"
        aria-selected={tab === item.id}
        tabindex={tab === item.id ? 0 : -1}
        class:chosen={tab === item.id}
        onclick={() => (tab = item.id)}
        >{item.label}{#if item.id === 'sessions' && unread}<span class="sr-only">,</span><span
            class="tab-count"
            aria-label="{unread} unread">{unread}</span
          >{/if}</button
      >
    {/each}
  </div>

  <div class="page-scroll">
    <div class="page-body">
      {#if tab === 'sessions'}
        <div id="workspace-panel-sessions" role="tabpanel" aria-labelledby="workspace-tab-sessions">
          <div class="list-tools">
            <label class="search">
              <Search size={15} />
              <span class="sr-only">Search {noun}s in {workspace.displayName}</span>
              <input bind:value={query} placeholder="Search {noun}s" />
            </label>
            {#if settledCount || showDone}
              <button
                class="done-toggle"
                type="button"
                aria-pressed={showDone}
                onclick={() => (showDone = !showDone)}
                >{showDone ? 'Hide done' : `Show done · ${settledCount}`}</button
              >
            {/if}
          </div>
          <ul class="session-rows">
            {#each rows as item (item.kind === 'session' ? item.session.id : `fold:${item.scheduleId}`)}
              {#if item.kind === 'session'}{@render row(item.session, false)}{:else}
                {@const expanded = openFolds.has(item.scheduleId)}
                <li class="session-row fold">
                  <button
                    class="row-main"
                    type="button"
                    aria-expanded={expanded}
                    onclick={() => (openFolds = toggleIn(openFolds, item.scheduleId))}
                  >
                    <span
                      class="status-dot"
                      class:unread={item.sessions.some((session) => session.unread)}
                    ></span>
                    <span class="origin-icon" title="Scheduled"><Clock size={13} /></span>
                    <span class="row-name">{item.title}</span>
                    <small class="fold-count">{item.sessions.length} runs</small>
                    <span class="chevron" class:collapsed={!expanded}
                      ><ChevronDown size={13} /></span
                    >
                  </button>
                </li>
                {#if expanded}
                  {#each item.sessions as session (session.id)}{@render row(session, true)}{/each}
                {/if}
              {/if}
            {:else}
              <li class="empty-note">
                {#if query}Nothing matches.{:else if settledCount}Every {noun} here is done.{:else}No
                  {noun}s yet. Start one with “New {noun}”.{/if}
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <div id="workspace-panel-settings" role="tabpanel" aria-labelledby="workspace-tab-settings">
          {#if chat}
            {#if app.usingDemo}
              <p class="note">Project instructions are unavailable in demo mode.</p>
            {:else if !online}
              <p class="note">
                The project's node is offline: its instructions can be changed once it is back.
              </p>
            {:else}
              <ProjectInstructions workspaceId={workspace.id} />
            {/if}
            <ProjectSettings workspaceId={workspace.id} disabled={app.usingDemo} />
          {:else}
            <section class="settings-section">
              <h3>Workspace</h3>
              <dl class="facts">
                <div>
                  <dt>Device</dt>
                  <dd>{workspace.hostId} · {online ? 'online' : 'offline'}</dd>
                </div>
                <div>
                  <dt>Sessions</dt>
                  <dd>
                    {all.length}{#if running}
                      · {running} running{/if}{#if unread}
                      · {unread} unread{/if}
                  </dd>
                </div>
                <div>
                  <dt>Write lease</dt>
                  <dd>{leaseHolder ? `Held by “${leaseHolder.name}”` : 'Free'}</dd>
                </div>
                {#if workspace.defaults.modelId}
                  <div>
                    <dt>Default model</dt>
                    <dd>{workspace.defaults.modelId}</dd>
                  </div>
                {/if}
                {#if workspace.defaults.thinkingLevel}
                  <div>
                    <dt>Default thinking</dt>
                    <dd>{workspace.defaults.thinkingLevel}</dd>
                  </div>
                {/if}
              </dl>
              <p>Per-workspace settings will appear here.</p>
            </section>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>

{#snippet row(session: SessionSummary, nested: boolean)}
  <li
    class="session-row"
    class:nested
    class:settled={session.settled}
    class:unread={session.unread}
    class:renaming={renamingId === session.id}
  >
    {#if renamingId === session.id}
      <form
        class="row-rename"
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
        class="row-main"
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
      >
        <span
          class="status-dot"
          class:waiting={needsInput(session)}
          class:running={isRunning(session)}
          class:unread={session.unread}
          title={status(session) || undefined}
          aria-hidden="true"
        ></span>
        {#if session.origin?.kind === 'schedule'}<span
            class="origin-icon"
            title="Scheduled: {session.origin.title}"><Clock size={13} /></span
          >{:else if session.origin?.kind === 'delegation'}<span
            class="origin-icon"
            title="Delegated: {session.origin.title}"><Forward size={13} /></span
          >{/if}
        <span class="row-name">{session.name}</span>
        {#if status(session)}<span class="sr-only">· {status(session)}</span>{/if}
        {#if session.writeLease}<span
            class="lease-lock"
            role="img"
            aria-label="Holds the write lease"
            title="Holds the write lease"><Lock size={12} /></span
          >{/if}
        {#if session.pinned}<span class="pin-mark" title="Pinned"><Pin size={12} /></span>{/if}
        <small>{shortAgo(session.lastActivityAt)}</small>
      </button>
      <div class="row-actions">
        <button
          type="button"
          aria-label={session.pinned ? `Unpin ${session.name}` : `Pin ${session.name}`}
          title={session.pinned ? 'Unpin' : 'Pin'}
          onclick={() => app.updateSession(session.id, { pinned: !session.pinned })}
          >{#if session.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}</button
        >
        <button
          type="button"
          aria-label={session.settled ? `Reopen ${session.name}` : `Settle ${session.name}`}
          title={session.settled ? 'Reopen' : 'Settle'}
          onclick={() => app.updateSession(session.id, { settled: !session.settled })}
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
  </li>
{/snippet}

<style>
  .workspace-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .page-bar {
    flex: 0 0 calc(56px + env(safe-area-inset-top));
    display: flex;
    align-items: center;
    gap: 10px;
    padding: env(safe-area-inset-top) 20px 0;
  }
  .page-icon {
    flex: none;
    display: grid;
    color: var(--muted);
  }
  .page-title {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .page-title h1 {
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 15px;
    font-weight: 600;
  }
  .page-title small {
    flex: none;
    color: var(--muted);
    font-size: 12px;
  }
  .new-in {
    flex: none;
    gap: 6px;
  }
  /* The tabs line up with the centered list below them. */
  .page-tabs {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 0 max(22px, calc((100% - 780px) / 2 + 22px));
    border-bottom: 1px solid var(--line);
  }
  .page-tabs button {
    position: relative;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    background: transparent;
    font-size: 13px;
    font-weight: 500;
  }
  .page-tabs button:hover {
    color: var(--ink);
  }
  .page-tabs button.chosen {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .tab-count {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    color: var(--on-accent);
    background: var(--accent);
    font-size: 11px;
    font-weight: 600;
  }
  .page-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .page-body {
    width: min(780px, 100%);
    margin: 0 auto;
    padding: 16px 32px 48px;
  }
  .list-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .search {
    flex: 1;
    height: 36px;
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
  .done-toggle {
    flex: none;
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
  }
  .done-toggle:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .session-rows {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .session-row {
    position: relative;
    min-width: 0;
    border-radius: var(--radius-sm);
  }
  .session-row:hover,
  .session-row:focus-within {
    background: var(--bg-hover);
  }
  .row-main {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border: 0;
    color: var(--ink);
    background: transparent;
    text-align: left;
  }
  .session-row:hover .row-main,
  .session-row:focus-within .row-main {
    padding-right: 100px;
  }
  .session-row:hover .row-main small,
  .session-row:focus-within .row-main small {
    display: none;
  }
  .row-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 14px;
  }
  .session-row.unread .row-name {
    font-weight: 600;
  }
  .session-row.settled .row-name {
    color: var(--muted);
  }
  .row-main small {
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .session-row.nested {
    margin-left: 20px;
  }
  .session-row.fold:hover .row-main,
  .session-row.fold:focus-within .row-main {
    padding-right: 12px;
  }
  .session-row.fold .row-main small {
    display: inline;
  }
  .chevron {
    display: grid;
    color: var(--muted);
    transition: transform 0.18s var(--ease);
  }
  .chevron.collapsed {
    transform: rotate(-90deg);
  }
  .status-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
  }
  .status-dot.unread {
    background: var(--accent);
  }
  .status-dot.running {
    background: var(--accent);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .status-dot.waiting {
    background: var(--warning);
  }
  .origin-icon,
  .pin-mark {
    flex: none;
    display: grid;
    color: var(--muted);
  }
  .lease-lock {
    flex: none;
    display: grid;
    color: var(--warning);
  }
  .row-actions {
    position: absolute;
    top: 50%;
    right: 8px;
    display: flex;
    gap: 2px;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
  }
  .session-row:hover .row-actions,
  .session-row:focus-within .row-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .row-actions button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
  }
  .row-actions button:hover {
    color: var(--ink);
    background: var(--bg-hover-strong);
  }
  .row-rename {
    min-height: 44px;
    display: flex;
    align-items: center;
    padding: 0 8px;
  }
  .row-rename input {
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    color: var(--ink);
    background: var(--input);
    font-size: 14px;
    outline: none;
  }
  .row-rename input:focus {
    border-color: var(--accent);
  }
  .empty-note,
  .note {
    margin: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  /* The settings sections were written for the Settings dialog: same look here. */
  .page-body :global(.settings-section + .settings-section) {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }
  .page-body :global(.settings-section h3) {
    margin: 0 0 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .page-body :global(.settings-section p) {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }
  .page-body :global(.settings-section label) {
    color: var(--text-2);
    font-size: 13px;
  }
  .page-body :global(.settings-section textarea) {
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
    line-height: 1.5;
  }
  .page-body :global(.settings-section textarea:focus) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .facts {
    display: grid;
    gap: 2px;
    margin: 12px 0 0;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
    align-items: center;
    font-size: 13px;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    color: var(--ink);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @media (hover: none) {
    .row-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .row-main {
      padding-right: 100px;
    }
    .row-main small {
      display: none;
    }
  }
  @media (max-width: 650px) {
    /* The phone's back button (Sidebar's .mobile-menu) sits at the top left. */
    .page-bar {
      padding-left: 52px;
      padding-right: 12px;
    }
    .page-title small {
      display: none;
    }
    .page-tabs {
      padding: 0 12px;
    }
    .page-body {
      /* Above the bottom tabs. */
      padding: 8px 10px calc(72px + env(safe-area-inset-bottom));
    }
  }
</style>
