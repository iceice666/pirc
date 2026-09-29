<script lang="ts">
  /**
   * Right-hand side panel, Codex/ChatGPT style: a tab strip over Files, Git,
   * Memory, Tasks, Terminal and Browser. A tab mounts on first visit and then stays
   * mounted (hidden) so its folder, open file, diff and scroll position survive
   * tab switches; each tab loads and refreshes its own data while it is shown.
   * The left edge is a drag handle that resizes the panel.
   */
  import { Brain, FolderTree, GitBranch, Globe, ListChecks, SquareTerminal } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { rovingFocus } from '../../a11y';
  import { app } from '../../app.svelte';
  import { isChatWorkspace } from '../../chats';
  import { onFilePreviewRequest, type FileTarget } from '../../file-links';
  import type { PanelTab } from '../../panel-api';
  import FilesTab from './FilesTab.svelte';
  import GitTab from './GitTab.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import TasksTab from './TasksTab.svelte';
  import TerminalTab from './TerminalTab.svelte';
  import BrowserTab from './BrowserTab.svelte';
  import './panel.css';

  interface Props {
    open?: boolean;
    tab?: PanelTab;
    /** Current width in px; the drag handle reports new widths through `onresize`. */
    width?: number;
    minWidth?: number;
    maxWidth?: number;
    defaultWidth?: number;
    onresize?: (width: number) => void;
    /** True while the edge is being dragged (the parent disables width transitions). */
    resizing?: boolean;
  }

  let {
    open = true,
    tab = $bindable('files'),
    width = 360,
    minWidth = 280,
    maxWidth = 900,
    defaultWidth = 360,
    onresize = () => {},
    resizing = $bindable(false),
  }: Props = $props();

  let openRequest: (FileTarget & { seq: number }) | undefined = $state();
  let openSeq = 0;
  /** Tabs visited so far; they stay mounted. */
  const mounted = new SvelteSet<PanelTab>();

  const tabs: Array<{ id: PanelTab; label: string; icon: typeof FolderTree }> = [
    { id: 'files', label: 'Files', icon: FolderTree },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'tasks', label: 'Tasks', icon: ListChecks },
    { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
    { id: 'browser', label: 'Browser', icon: Globe },
  ];

  const sessionId = $derived(app.sessionState?.session.id ?? '');
  /** Chats keep Files (their own directory, where uploads and outputs land) but have no Git or terminal. */
  const chat = $derived(
    isChatWorkspace(
      app.workspaces.find((workspace) => workspace.id === app.sessionState?.session.workspaceId),
    ),
  );
  const shownTabs = $derived(
    chat ? tabs.filter((item) => item.id !== 'git' && item.id !== 'terminal') : tabs,
  );
  $effect.pre(() => {
    if (!shownTabs.some((item) => item.id === tab)) tab = 'files';
  });
  $effect.pre(() => {
    if (open) mounted.add(tab);
  });

  function openFile(target: string | FileTarget) {
    // A fresh sequence number so the same path can be reopened.
    openRequest = { ...(typeof target === 'string' ? { path: target } : target), seq: ++openSeq };
    tab = 'files';
  }
  // File links in the conversation (and in previewed documents) open here.
  onDestroy(onFilePreviewRequest(openFile));

  let dragStartX = 0;
  let dragStartWidth = 0;
  const clampWidth = (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value)));

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragStartX = event.clientX;
    dragStartWidth = width;
    resizing = true;
  }
  function moveResize(event: PointerEvent) {
    // The handle sits on the panel's left edge, so dragging left widens it.
    if (resizing) onresize(clampWidth(dragStartWidth + dragStartX - event.clientX));
  }
  function endResize(event: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  function keyResize(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16;
    const next =
      event.key === 'ArrowLeft'
        ? width + step
        : event.key === 'ArrowRight'
          ? width - step
          : event.key === 'Home'
            ? maxWidth
            : event.key === 'End'
              ? minWidth
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onresize(clampWidth(next));
  }

  const badge = $derived({
    tasks: (app.panel.value?.backgroundTasks ?? []).filter((task) => task.status === 'running')
      .length,
    memory: app.panel.value?.memoryRuntime?.phase ? 1 : 0,
  } as Record<string, number>);
</script>

<aside class:open class="details side-panel" aria-label="Session side panel">
  <!-- A focusable separator is an interactive ARIA widget (WAI-ARIA window splitter). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="panel-resizer"
    class:active={resizing}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize side panel"
    aria-valuenow={width}
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    tabindex={open ? 0 : -1}
    title="Drag to resize · double-click to reset"
    onpointerdown={startResize}
    onpointermove={moveResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    onlostpointercapture={() => (resizing = false)}
    ondblclick={() => onresize(clampWidth(defaultWidth))}
    onkeydown={keyResize}
  ></div>
  <div
    class="panel-tabs"
    role="tablist"
    aria-label="Side panel"
    use:rovingFocus={{ selector: '[role="tab"]', activate: true }}
  >
    {#each shownTabs as item (item.id)}
      <button
        type="button"
        role="tab"
        id="panel-tab-{item.id}"
        aria-controls={mounted.has(item.id) ? `panel-${item.id}` : undefined}
        class:active={tab === item.id}
        aria-selected={tab === item.id}
        tabindex={tab === item.id ? 0 : -1}
        title={item.label}
        onclick={() => (tab = item.id)}
      >
        <item.icon size={16} />
        <span class="tab-label">{item.label}</span>
        {#if badge[item.id]}<span class="tab-dot" aria-hidden="true"></span><span class="sr-only"
            >(activity)</span
          >{/if}
      </button>
    {/each}
  </div>

  <div class="panel-body">
    {#if app.usingDemo}
      <p class="panel-empty">Connect to a gateway to use this panel.</p>
    {:else if sessionId}
      {#each shownTabs as item (item.id)}
        {#if mounted.has(item.id)}
          <div
            class="tab-slot"
            class:hidden={tab !== item.id}
            role="tabpanel"
            id="panel-{item.id}"
            aria-labelledby="panel-tab-{item.id}"
          >
            {#if item.id === 'files'}
              <FilesTab {sessionId} {openRequest} active={open && tab === 'files'} />
            {:else if item.id === 'git'}
              <GitTab {sessionId} active={open && tab === 'git'} onopenfile={openFile} />
            {:else if item.id === 'memory'}
              <MemoryTab active={open && tab === 'memory'} />
            {:else if item.id === 'tasks'}
              <TasksTab {sessionId} active={open && tab === 'tasks'} />
            {:else if item.id === 'browser'}
              <BrowserTab
                {sessionId}
                generation={app.generation}
                hasControl={app.hasControl}
                active={open && tab === 'browser'}
              />
            {:else}
              <TerminalTab
                {sessionId}
                generation={app.generation}
                hasControl={app.hasControl}
                active={open && tab === 'terminal'}
              />
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</aside>

<style>
  /* ───────────── Right details panel ───────────── */
  .details {
    position: relative;
    /* Keeps its width while the track animates closed; the grid clips the rest. */
    width: var(--panel-width, 360px);
    min-width: 0;
    overflow-y: auto;
    padding: 8px 12px 16px;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
    transition:
      opacity var(--layout-duration) var(--ease),
      visibility var(--layout-duration);
  }
  .details:not(.open) {
    visibility: hidden;
    opacity: 0;
  }
  /* ───────────── Side panel (tabs) ───────────── */
  .side-panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
    container: side-panel / inline-size;
  }
  .panel-resizer {
    position: absolute;
    z-index: 5;
    top: 0;
    bottom: 0;
    left: 0;
    width: 7px;
    cursor: col-resize;
    touch-action: none;
  }
  .panel-resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    background: transparent;
    transition: background 0.15s var(--ease);
  }
  .panel-resizer:hover::after,
  .panel-resizer:focus-visible::after,
  .panel-resizer.active::after {
    background: var(--accent);
  }
  .panel-resizer:focus-visible {
    outline: 0;
  }
  .panel-tabs {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 8px 6px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .panel-tabs > button[role='tab'] {
    position: relative;
    flex: none;
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 9px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    font-size: 12.5px;
    font-weight: 500;
  }
  @media (hover: none) {
    .panel-tabs > button[role='tab'] {
      height: 40px;
      padding: 0 12px;
    }
  }
  .panel-tabs > button[role='tab']:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .panel-tabs > button[role='tab'].active {
    color: var(--ink);
    background: var(--bg-active);
  }
  @container side-panel (max-width: 459px) {
    .panel-tabs > button[role='tab']:not(.active) .tab-label {
      display: none;
    }
  }
  .tab-dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .panel-body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
  .panel-body > .panel-empty {
    padding: 4px 12px;
  }
  /* Each tab scrolls on its own, so a hidden tab keeps its scroll position. */
  .tab-slot {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    padding: 4px 12px 16px;
  }
  /* Not display:none, which would lose the scroll offset; skips rendering instead. */
  .tab-slot.hidden {
    visibility: hidden;
    content-visibility: hidden;
  }
  @media (max-width: 860px) {
    .panel-resizer {
      display: none;
    }
    .details {
      position: fixed;
      z-index: 25;
      top: calc(56px + env(safe-area-inset-top));
      right: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      width: min(420px, calc(100% - 16px));
      border: 0;
      border-radius: var(--radius-xl);
      background: var(--bg-layer);
      box-shadow: var(--shadow-pop);
      visibility: hidden;
      transform: translateX(calc(100% + 16px));
      opacity: 0;
      transition:
        transform 0.2s var(--ease),
        opacity 0.2s var(--ease),
        visibility 0.2s;
    }
    .details.open {
      visibility: visible;
      transform: translateX(0);
      opacity: 1;
    }
  }
  @media (max-width: 650px) {
    .details {
      right: 0;
      bottom: 0;
      width: 100%;
      padding-bottom: env(safe-area-inset-bottom);
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    }
    .panel-tabs .tab-label {
      display: none;
    }
  }
  .tab-slot:has(> :global(.terminal-tab)) {
    overflow: hidden;
    padding: 0;
  }
</style>
