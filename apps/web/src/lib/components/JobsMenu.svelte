<script lang="ts">
  /**
   * Background work at a glance, in the top bar (Codex's "Running N terminals",
   * DeepSeek Harness's job list): a quiet trigger that shows only while the
   * session has jobs, and a popover listing running tasks and agents, then
   * finished tasks. A task row expands into its output tail; a running task
   * stops with a two-press button (control lease required).
   */
  import { Bot, ChevronDown, ChevronRight, LoaderCircle, Square, Users } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { panelApi, type BackgroundTask, type PanelState, type TeamMember } from '../panel-api';
  import { watch } from '../watch.svelte';

  interface Props {
    sessionId: string;
    hasControl?: boolean;
    generation: number | undefined;
    /** Bumped by the parent when background or team state changed. */
    refreshKey?: number;
    /** Static state for the offline demo; nothing is fetched. */
    demo?: PanelState | undefined;
  }

  let {
    sessionId,
    hasControl = false,
    generation,
    refreshKey = 0,
    demo = undefined,
  }: Props = $props();

  let panelState: PanelState | undefined = $state();
  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let now = $state(Date.now());
  let expanded: string | undefined = $state();
  let output = $state('');
  let outputError = $state('');
  let outputEl: HTMLPreElement | undefined = $state();
  let finishedOpen = $state(false);
  /** Finished tasks the user cleared from the list (client-side only). */
  let cleared = $state(new Set<string>());
  let armed: string | undefined = $state();
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let stopError = $state('');
  let loading = false;
  let queued = false;

  const LIVE_AGENT = (agent: TeamMember) =>
    !['stopped', 'failed', 'done'].includes(agent.status ?? 'stopped');
  const liveTask = (task: BackgroundTask) =>
    task.status === 'running' || task.status === 'stopping';

  async function load() {
    if (demo) return;
    if (loading) {
      queued = true;
      return;
    }
    loading = true;
    const id = sessionId;
    try {
      const next = await panelApi.state(id);
      if (id === sessionId) panelState = next;
    } catch {
      /* keep the last list; the node may be restarting */
    } finally {
      loading = false;
      if (queued) {
        queued = false;
        void load();
      }
    }
  }

  onDestroy(() => {
    if (armTimer) clearTimeout(armTimer);
  });

  function toggleOpen() {
    open = !open;
    now = Date.now();
    if (open) void load();
  }
  async function toggleTask(task: BackgroundTask) {
    if (expanded === task.id) {
      expanded = undefined;
      return;
    }
    expanded = task.id;
    output = '';
    await loadOutput();
  }
  async function loadOutput() {
    const id = expanded;
    if (!id) return;
    if (demo) {
      output = '$ bun run dev\n  VITE ready in 412 ms\n  ➜  Local: http://localhost:5173/';
      return;
    }
    const follow =
      !outputEl || outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 24;
    try {
      const result = await panelApi.backgroundOutput(sessionId, id, 200);
      if (expanded !== id) return;
      output = result.output;
      outputError = '';
      if (follow) requestAnimationFrame(() => outputEl?.scrollTo({ top: outputEl.scrollHeight }));
    } catch (cause) {
      outputError = cause instanceof Error ? cause.message : 'Output unavailable.';
    }
  }
  async function pressStop(task: BackgroundTask) {
    if (armed !== task.id) {
      armed = task.id;
      stopError = '';
      if (armTimer) clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = undefined), 3000);
      return;
    }
    armed = undefined;
    if (!generation) return;
    try {
      const { task: next } = await panelApi.stopBackground(sessionId, task.id, generation);
      if (panelState)
        panelState = {
          ...panelState,
          backgroundTasks: panelState.backgroundTasks.map((item) =>
            item.id === next.id ? next : item,
          ),
        };
    } catch (cause) {
      stopError = cause instanceof Error ? cause.message : 'Could not stop the task.';
    }
  }
  function clearFinished() {
    cleared = new Set([...cleared, ...finished.map((task) => task.id)]);
    if (expanded && cleared.has(expanded)) expanded = undefined;
  }

  function duration(start?: string | number, end?: string | number) {
    if (!start) return '';
    const from = new Date(start).getTime();
    const to = end ? new Date(end).getTime() : now;
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  function detail(task: BackgroundTask) {
    if (task.status === 'running') return task.tty ? 'tty' : '';
    if (task.status === 'stopping') return 'stopping';
    if (task.status === 'completed') return task.exitCode ? `exit ${task.exitCode}` : 'done';
    if (task.status === 'failed')
      return task.exitCode != null ? `exit ${task.exitCode}` : (task.error ?? 'failed');
    return task.status.replace('_', ' ');
  }
  const dot = (task: BackgroundTask) =>
    liveTask(task)
      ? 'ongoing'
      : task.status === 'completed' && !task.exitCode
        ? 'done'
        : task.status === 'stopped'
          ? 'idle'
          : 'error';

  function outside(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      open = false;
      root?.querySelector<HTMLButtonElement>('.jobs-trigger')?.focus();
    }
  }
  watch(
    () => sessionId,
    () => {
      panelState = demo;
      open = false;
      expanded = undefined;
      cleared = new Set();
      void load();
    },
    { immediate: true },
  );
  watch(
    () => refreshKey,
    () => void load(),
  );
  let tasks = $derived((panelState?.backgroundTasks ?? []).slice().reverse());
  let liveTasks = $derived(tasks.filter(liveTask));
  let finished = $derived(tasks.filter((task) => !liveTask(task) && !cleared.has(task.id)));
  let agents = $derived((panelState?.team.agents ?? []).filter(LIVE_AGENT));
  let liveCount = $derived(liveTasks.length + agents.length);
  let visible = $derived(liveCount + finished.length > 0);
  $effect.pre(() => {
    if (!visible) open = false;
  });
  let label = $derived(
    liveCount
      ? `${liveCount} running`
      : `${finished.length} background task${finished.length === 1 ? '' : 's'}`,
  );
  // A ticking clock for durations, only while the list is visible.
  $effect(() => {
    if (!open || !liveCount) return;
    const clock = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(clock);
  });
  let expandedTask = $derived(tasks.find((task) => task.id === expanded));
  let pollWanted = $derived(open && !!expandedTask && liveTask(expandedTask));
  // The expanded output follows a running task.
  $effect(() => {
    if (!pollWanted) return;
    const poll = setInterval(() => void loadOutput(), 2000);
    return () => clearInterval(poll);
  });
  // A status change of the expanded task (e.g. it finished) refreshes its output.
  watch(
    () => expandedTask && `${expandedTask.id}\n${expandedTask.status}`,
    (key, previous) => {
      if (key && previous?.split('\n')[0] === key.split('\n')[0]) void loadOutput();
    },
  );
</script>

<svelte:window onpointerdown={outside} onkeydown={keydown} />

{#if visible}
  <div class="jobs-menu" bind:this={root} transition:fade={{ duration: 120 }}>
    <button
      class="jobs-trigger"
      class:open
      class:live={liveCount > 0}
      type="button"
      aria-expanded={open}
      aria-haspopup="true"
      aria-label="{label}. Show background jobs"
      title="Background jobs"
      onclick={toggleOpen}
    >
      {#if liveCount}<span class="state-dot ongoing" aria-hidden="true"></span>{/if}
      <span class="jobs-count">{liveCount || finished.length}</span>
      <span class="jobs-label">{liveCount ? 'running' : 'finished'}</span>
      <ChevronDown size={12} />
    </button>

    {#if open}
      <div class="jobs-popover" role="dialog" aria-label="Background jobs">
        {#if liveTasks.length || agents.length}
          <div class="jobs-section">Running</div>
        {/if}
        {#each liveTasks as task (task.id)}
          {@render taskRow(task, true)}
        {/each}
        {#each agents as agent (agent.name)}
          <div class="job-row static">
            <span class="state-dot ongoing" aria-hidden="true"></span>
            <span class="job-icon"
              >{#if agent.mode === 'subagent'}<Bot size={13} />{:else}<Users size={13} />{/if}</span
            >
            <span class="job-main">
              <span class="job-label">{agent.name}</span>
              {#if agent.task}<span class="job-sub">{agent.task}</span>{/if}
            </span>
            <span class="job-meta">{agent.status}</span>
          </div>
        {/each}
        {#if stopError}<p class="jobs-error">{stopError}</p>{/if}

        {#if finished.length}
          <div class="jobs-section">
            <button
              class="jobs-section-toggle"
              type="button"
              aria-expanded={finishedOpen || !liveCount}
              onclick={() => (finishedOpen = !finishedOpen)}
            >
              <span class="section-chevron" class:open={finishedOpen || !liveCount}
                ><ChevronRight size={12} /></span
              >
              Finished {finished.length}
            </button>
            <button class="jobs-section-toggle" type="button" onclick={clearFinished}>Clear</button>
          </div>
          {#if finishedOpen || !liveCount}
            {#each finished as task (task.id)}
              {@render taskRow(task, false)}
            {/each}
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#snippet taskRow(task: BackgroundTask, live: boolean)}
  <div class="job-item" class:expanded={expanded === task.id}>
    <div class="job-line" class:live>
      <button
        class="job-row"
        class:settled={!live}
        type="button"
        aria-expanded={expanded === task.id}
        onclick={() => toggleTask(task)}
      >
        <span class="state-dot {dot(task)}" aria-hidden="true"></span>
        <span class="job-main">
          <span class="job-label mono" title={task.command}>{task.command}</span>
        </span>
        {#if detail(task)}<span class="job-meta">{detail(task)}</span>{/if}
        <span class="job-duration">{duration(task.startedAt, task.endedAt)}</span>
        <span class="job-chevron" class:open={expanded === task.id}><ChevronRight size={13} /></span
        >
      </button>
      {#if task.status === 'running' && hasControl}
        <button
          class="job-stop"
          class:armed={armed === task.id}
          type="button"
          aria-label={armed === task.id ? 'Confirm stop' : `Stop ${task.id}`}
          title={armed === task.id ? 'Click again to stop' : 'Stop task'}
          onclick={() => pressStop(task)}
        >
          <Square size={9} fill="currentColor" />
          {#if armed === task.id}<span>Stop</span>{/if}
        </button>
      {:else if task.status === 'stopping'}
        <span class="job-stop pending" aria-label="Stopping"
          ><LoaderCircle class="spin" size={12} /></span
        >
      {/if}
    </div>
    {#if expanded === task.id}
      {#if outputError}<p class="jobs-error">{outputError}</p>{/if}
      <pre class="job-output" bind:this={outputEl}>{output || 'No output yet.'}</pre>
    {/if}
  </div>
{/snippet}
