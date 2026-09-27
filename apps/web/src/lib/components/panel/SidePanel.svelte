<script lang="ts">
  /**
   * Right-hand side panel, Codex/ChatGPT style: a tab strip over Files, Git,
   * Memory, Tasks and Terminal. Data tabs load lazily and refresh on
   * `panel_changed` events and run transitions. Its left edge is a drag handle
   * that resizes the panel.
   */
  import { Brain, FolderTree, GitBranch, ListChecks, SquareTerminal } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { onFilePreviewRequest, type FileTarget } from '../../file-links';
  import { panelApi, type PanelState, type PanelTab } from '../../panel-api';
  import { app } from '../../app.svelte';
  import { watch } from '../../watch.svelte';
  import FilesTab from './FilesTab.svelte';
  import GitTab from './GitTab.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import TasksTab from './TasksTab.svelte';
  import TerminalTab from './TerminalTab.svelte';

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

  let panelState: PanelState | undefined = $state();
  let stateError = $state('');
  let gitRefresh = $state(0);
  let filesRefresh = $state(0);
  let openRequest: (FileTarget & { seq: number }) | undefined = $state();
  let openSeq = 0;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  // Terminals stay mounted once visited so their sockets survive tab switches.
  let terminalMounted = $state(false);

  const tabs: Array<{ id: PanelTab; label: string; icon: typeof FolderTree }> = [
    { id: 'files', label: 'Files', icon: FolderTree },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'tasks', label: 'Tasks', icon: ListChecks },
    { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  ];

  const sessionId = $derived(app.sessionState?.session.id ?? '');
  const usingDemo = $derived(app.usingDemo);

  async function loadState() {
    if (usingDemo) return;
    const id = sessionId;
    try {
      const next = await panelApi.state(id);
      if (id !== sessionId) return;
      panelState = next;
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

  watch(
    () => sessionId,
    () => {
      panelState = undefined;
      openRequest = undefined;
      terminalMounted = false;
      if (open) void loadState();
    },
    { immediate: true },
  );
  $effect.pre(() => {
    if (tab === 'terminal') terminalMounted = true;
  });
  // Tab activation refreshes its data.
  watch(
    () => open && tab,
    (active) => {
      if (active === 'memory' || active === 'tasks') void loadState();
    },
    { immediate: true },
  );
  onDestroy(
    app.onPanel((signal) => {
      if (signal.type === 'changed') {
        if (signal.sections.some((section) => section !== 'git')) scheduleState();
        if (signal.sections.includes('git')) gitRefresh++;
      } else {
        // A finished run may have changed the working tree and memory.
        gitRefresh++;
        filesRefresh++;
        scheduleState(100);
      }
    }),
  );

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

  let badge = $derived({
    tasks: (panelState?.backgroundTasks ?? []).filter((task) => task.status === 'running').length,
    memory: panelState?.memoryRuntime?.phase ? 1 : 0,
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
  <div class="panel-tabs" role="tablist" aria-label="Side panel">
    {#each tabs as item (item.id)}
      <button
        type="button"
        role="tab"
        class:active={tab === item.id}
        aria-selected={tab === item.id}
        title={item.label}
        onclick={() => (tab = item.id)}
      >
        <item.icon size={16} />
        <span class="tab-label">{item.label}</span>
        {#if badge[item.id]}<span class="tab-dot" aria-label="activity"></span>{/if}
      </button>
    {/each}
  </div>

  <div class="panel-body">
    {#if usingDemo}
      <p class="panel-empty">Connect to a gateway to use this panel.</p>
    {:else if tab === 'files'}
      <FilesTab {sessionId} {openRequest} refreshKey={filesRefresh} />
    {:else if tab === 'git'}
      <GitTab {sessionId} refreshKey={gitRefresh} onopenfile={openFile} />
    {:else if tab === 'memory'}
      {#if stateError && !panelState}<p class="panel-error">{stateError}</p>{/if}
      <MemoryTab
        memory={panelState?.memory ?? null}
        runtime={panelState?.memoryRuntime ?? null}
        agentRunning={panelState?.agentRunning ?? false}
      />
    {:else if tab === 'tasks'}
      {#if stateError && !panelState}<p class="panel-error">{stateError}</p>{/if}
      <TasksTab {sessionId} {panelState} />
    {/if}
    {#if terminalMounted && !usingDemo}
      <div class="terminal-slot" class:hidden={tab !== 'terminal'}>
        <TerminalTab
          {sessionId}
          generation={app.generation}
          hasControl={app.hasControl}
          active={open && tab === 'terminal'}
        />
      </div>
    {/if}
  </div>
</aside>
