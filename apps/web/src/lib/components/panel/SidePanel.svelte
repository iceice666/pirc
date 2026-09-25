<script lang="ts">
  /**
   * Right-hand side panel, Codex/ChatGPT style: a tab strip over Overview
   * (run, queue, session), Files, Git, Memory, Tasks and Terminal. Data tabs
   * load lazily and refresh on `panel_changed` events and run transitions.
   */
  import {
    Activity,
    Brain,
    FolderTree,
    GitBranch,
    LayoutDashboard,
    ListChecks,
    Maximize2,
    Minimize2,
    SquareTerminal,
  } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { panelApi, type PanelState, type PanelTab } from '../../panel-api';
  import type { ClientSessionState, ModelOption, RunStatus, Workspace } from '../../types';
  import FilesTab from './FilesTab.svelte';
  import GitTab from './GitTab.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import TasksTab from './TasksTab.svelte';
  import TerminalTab from './TerminalTab.svelte';

  export let open = true;
  export let wide = false;
  export let tab: PanelTab = 'overview';
  export let sessionState: ClientSessionState;
  export let runStatus: RunStatus | undefined;
  export let hasControl: boolean;
  export let models: ModelOption[];
  export let selectedModel: string;
  export let thinking: string;
  export let activeWorkspace: Workspace | undefined;
  export let usingDemo = false;
  /** Incremented by the parent for every `panel_changed` event; sections listed in `changed`. */
  export let changeTick = 0;
  export let changed: string[] = [];
  export let formatDuration: (startedAt?: string) => string;

  let state: PanelState | undefined;
  let stateError = '';
  let gitRefresh = 0;
  let filesRefresh = 0;
  let openPath: string | undefined;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let loadedFor = '';
  // Terminals stay mounted once visited so their sockets survive tab switches.
  let terminalMounted = false;

  const tabs: Array<{ id: PanelTab; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
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
      if (open && (tab === 'memory' || tab === 'tasks' || tab === 'overview')) void loadState();
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
    if (tab === 'memory' || tab === 'tasks' || tab === 'overview') void loadState();
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

  $: badge = {
    tasks: (state?.backgroundTasks ?? []).filter((task) => task.status === 'running').length,
    memory: state?.memoryRuntime?.phase ? 1 : 0,
  } as Record<string, number>;
</script>

<aside class:open class:wide class="details side-panel" aria-label="Session side panel">
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
    <button
      class="panel-wide icon-button small"
      type="button"
      aria-label={wide ? 'Narrow panel' : 'Widen panel'}
      title={wide ? 'Narrow panel' : 'Widen panel'}
      on:click={() => (wide = !wide)}
    >
      {#if wide}<Minimize2 size={15} />{:else}<Maximize2 size={15} />{/if}
    </button>
  </div>

  <div class="panel-body">
    {#if tab === 'overview'}
      <div class="details-section run-overview">
        <div class="section-heading">
          <span>Current run</span><span class:working={runStatus === 'running'} class="run-badge"
            >{runStatus ?? 'idle'}</span
          >
        </div>
        <div class="run-card">
          <div class="run-orbit"><span></span><Activity size={20} /></div>
          <div>
            <strong
              >{runStatus === 'running'
                ? 'Pi is working'
                : runStatus === 'waiting_input'
                  ? 'Waiting for you'
                  : 'No active run'}</strong
            ><span
              >{runStatus === 'running'
                ? `Elapsed ${formatDuration(sessionState.run?.startedAt)}`
                : 'Ready for a prompt'}</span
            >
          </div>
        </div>
        <dl class="detail-list">
          <div>
            <dt>Runner</dt>
            <dd><span class="tiny-dot"></span>{sessionState.runnerStatus}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {models.find((model) => model.id === selectedModel)?.displayName ?? selectedModel}
            </dd>
          </div>
          <div>
            <dt>Thinking</dt>
            <dd class="capitalize">{thinking}</dd>
          </div>
          <div>
            <dt>Control</dt>
            <dd>{hasControl ? 'This browser' : (sessionState.control.holderName ?? 'Viewer')}</dd>
          </div>
        </dl>
      </div>

      <div class="details-section">
        <div class="section-heading">
          <span>Queue</span><span>{sessionState.queue.length}</span>
        </div>
        {#if sessionState.queue.length}
          <div class="queue-list">
            {#each sessionState.queue as item, index}
              <div class="queue-item">
                <span>{index + 1}</span>
                <div>
                  <strong>{item.kind === 'follow_up' ? 'Follow up' : 'Steer'}</strong>
                  <p>{item.content}</p>
                </div>
              </div>
            {/each}
          </div>
        {:else}<p class="muted-note">
            Nothing queued. Follow-ups appear here while a run is active.
          </p>{/if}
      </div>

      {#if state?.memory?.enabled}
        <div class="details-section">
          <button class="section-heading as-link" type="button" on:click={() => (tab = 'memory')}>
            <span>Memory</span><span
              >{state.memory.counts.reflections + state.memory.counts.active}</span
            >
          </button>
          <p class="muted-note">
            {state.memory.counts.reflections} reflections · {state.memory.counts.active} active observations{#if state.memoryRuntime?.phase}
              · consolidating…{/if}
          </p>
        </div>
      {/if}

      <div class="details-section">
        <div class="section-heading"><span>Session</span></div>
        <dl class="detail-list compact">
          <div>
            <dt>Workspace</dt>
            <dd>{activeWorkspace?.displayName}</dd>
          </div>
          <div>
            <dt>Host</dt>
            <dd>{activeWorkspace?.hostId}</dd>
          </div>
          <div>
            <dt>Epoch</dt>
            <dd class="mono">{sessionState.runnerEpoch.slice(0, 12)}</dd>
          </div>
          <div>
            <dt>Cursor</dt>
            <dd class="mono">{sessionState.cursor}</dd>
          </div>
        </dl>
      </div>
      {#if usingDemo}<div class="demo-note">
          Preview data is shown because the gateway is not connected.
        </div>{/if}
    {:else if demo}
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
