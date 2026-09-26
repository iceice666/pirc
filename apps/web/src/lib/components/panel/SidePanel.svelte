<script lang="ts">
  /**
   * Right-hand side panel, Codex/ChatGPT style: a tab strip over Files, Git,
   * Memory, Tasks and Terminal. Data tabs load lazily and refresh on
   * `panel_changed` events and run transitions. Its left edge is a drag handle
   * that resizes the panel.
   */
  import { Brain, FolderTree, GitBranch, ListChecks, SquareTerminal } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { panelApi, type PanelState, type PanelTab } from '../../panel-api';
  import type { ClientSessionState, RunStatus } from '../../types';
  import FilesTab from './FilesTab.svelte';
  import GitTab from './GitTab.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import TasksTab from './TasksTab.svelte';
  import TerminalTab from './TerminalTab.svelte';

  export let open = true;
  export let tab: PanelTab = 'files';
  export let sessionState: ClientSessionState;
  export let runStatus: RunStatus | undefined;
  export let hasControl: boolean;
  export let usingDemo = false;
  /** Incremented by the parent for every `panel_changed` event; sections listed in `changed`. */
  export let changeTick = 0;
  export let changed: string[] = [];
  /** Current width in px; the drag handle reports new widths through `onresize`. */
  export let width = 360;
  export let minWidth = 280;
  export let maxWidth = 900;
  export let defaultWidth = 360;
  export let onresize: (width: number) => void = () => {};
  /** True while the edge is being dragged (the parent disables width transitions). */
  export let resizing = false;

  let state: PanelState | undefined;
  let stateError = '';
  let gitRefresh = 0;
  let filesRefresh = 0;
  let openPath: string | undefined;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let loadedFor = '';
  // Terminals stay mounted once visited so their sockets survive tab switches.
  let terminalMounted = false;

  const tabs: Array<{ id: PanelTab; label: string; icon: typeof FolderTree }> = [
    { id: 'files', label: 'Files', icon: FolderTree },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'tasks', label: 'Tasks', icon: ListChecks },
    { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  ];

  $: sessionId = sessionState.session.id;
  $: demo = usingDemo;

  async function loadState() {
    if (demo) return;
    const id = sessionId;
    try {
      const next = await panelApi.state(id);
      if (id !== sessionId) return;
      state = next;
      stateError = '';
    } catch (cause) {
      stateError = cause instanceof Error ? cause.message : 'Unable to load panel state.';
    }
  }
  /** Coalesce bursts of change events (memory reports progress every turn). */
  function scheduleState(delay = 400) {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = undefined;
      if (open && (tab === 'memory' || tab === 'tasks')) void loadState();
    }, delay);
  }
  onDestroy(() => stateTimer && clearTimeout(stateTimer));

  $: if (sessionId !== loadedFor) {
    loadedFor = sessionId;
    state = undefined;
    openPath = undefined;
    terminalMounted = false;
    if (open) void loadState();
  }
  $: if (tab === 'terminal') terminalMounted = true;
  // Tab activation refreshes its data.
  let lastTab: PanelTab | undefined;
  $: if (open && tab !== lastTab) {
    lastTab = tab;
    if (tab === 'memory' || tab === 'tasks') void loadState();
  }
  let lastTick = changeTick;
  $: if (changeTick !== lastTick) {
    lastTick = changeTick;
    if (changed.some((section) => section !== 'git')) scheduleState();
    if (changed.includes('git')) gitRefresh++;
  }
  // A finished run may have changed the working tree and memory.
  let lastRun: RunStatus | undefined = runStatus;
  $: if (runStatus !== lastRun) {
    const finished = lastRun === 'running' && runStatus !== 'running';
    lastRun = runStatus;
    if (finished) {
      gitRefresh++;
      filesRefresh++;
      scheduleState(100);
    }
  }

  function openFile(path: string) {
    openPath = undefined;
    // Next tick so the same path can be reopened.
    queueMicrotask(() => {
      openPath = path;
      tab = 'files';
    });
  }

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

  $: badge = {
    tasks: (state?.backgroundTasks ?? []).filter((task) => task.status === 'running').length,
    memory: state?.memoryRuntime?.phase ? 1 : 0,
  } as Record<string, number>;
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
    on:pointerdown={startResize}
    on:pointermove={moveResize}
    on:pointerup={endResize}
    on:pointercancel={endResize}
    on:lostpointercapture={() => (resizing = false)}
    on:dblclick={() => onresize(clampWidth(defaultWidth))}
    on:keydown={keyResize}
  ></div>
  <div class="panel-tabs" role="tablist" aria-label="Side panel">
    {#each tabs as item (item.id)}
      <button
        type="button"
        role="tab"
        class:active={tab === item.id}
        aria-selected={tab === item.id}
        title={item.label}
        on:click={() => (tab = item.id)}
      >
        <svelte:component this={item.icon} size={16} />
        <span class="tab-label">{item.label}</span>
        {#if badge[item.id]}<span class="tab-dot" aria-label="activity"></span>{/if}
      </button>
    {/each}
  </div>

  <div class="panel-body">
    {#if demo}
      <p class="panel-empty">Connect to a gateway to use this panel.</p>
    {:else if tab === 'files'}
      <FilesTab {sessionId} {openPath} refreshKey={filesRefresh} />
    {:else if tab === 'git'}
      <GitTab {sessionId} refreshKey={gitRefresh} onopenfile={openFile} />
    {:else if tab === 'memory'}
      {#if stateError && !state}<p class="panel-error">{stateError}</p>{/if}
      <MemoryTab
        memory={state?.memory ?? null}
        runtime={state?.memoryRuntime ?? null}
        agentRunning={state?.agentRunning ?? false}
      />
    {:else if tab === 'tasks'}
      {#if stateError && !state}<p class="panel-error">{stateError}</p>{/if}
      <TasksTab {sessionId} {state} />
    {/if}
    {#if terminalMounted && !demo}
      <div class="terminal-slot" class:hidden={tab !== 'terminal'}>
        <TerminalTab
          {sessionId}
          generation={sessionState.control.generation}
          {hasControl}
          active={open && tab === 'terminal'}
        />
      </div>
    {/if}
  </div>
</aside>
