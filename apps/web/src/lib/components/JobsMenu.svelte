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
  import { motion } from '../motion';
  import { tick } from 'svelte';
  import { rovingFocus } from '../a11y';
  import { app } from '../app.svelte';
  import { errorMessage } from '../errors';
  import { Loader } from '../loader.svelte';
  import { panelApi, type BackgroundTask, type TeamMember } from '../panel-api';
  import { duration } from '../time';
  import { watch } from '../watch.svelte';

  const sessionId = $derived(app.sessionState?.session.id ?? '');
  const hasControl = $derived(app.hasControl);
  const generation = $derived(app.generation);
  const panelState = $derived(app.panel.value);

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let now = $state(Date.now());
  let expanded: string | undefined = $state();
  let output = $state('');
  let outputEl: HTMLPreElement | undefined = $state();
  let finishedOpen = $state(false);
  /** Finished tasks the user cleared from the list (client-side only). */
  let cleared = $state.raw(new Set<string>());
  let armed: string | undefined = $state();
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let stopError = $state('');
  const outputLoader = new Loader();

  const LIVE_AGENT = (agent: TeamMember) =>
    !['stopped', 'failed', 'done'].includes(agent.status ?? 'stopped');
  const liveTask = (task: BackgroundTask) =>
    task.status === 'running' || task.status === 'stopping';

  onDestroy(() => {
    if (armTimer) clearTimeout(armTimer);
  });
  // Background tasks or team members changed (or a run ended, which may stop them).
  onDestroy(
    app.onPanel((signal) => {
      if (signal.type === 'run-finished') app.panel.schedule(100);
      else if (signal.sections.some((section) => section === 'background' || section === 'team'))
        app.panel.schedule();
    }),
  );

  let popover: HTMLDivElement | undefined = $state();
  async function toggleOpen() {
    open = !open;
    now = Date.now();
    if (!open) return;
    void app.panel.refresh();
    // Move focus into the popover; arrow keys then walk its rows.
    await tick();
    popover?.querySelector<HTMLElement>('button')?.focus();
  }
  async function toggleTask(task: BackgroundTask) {
    if (expanded === task.id) {
      collapse();
      return;
    }
    expanded = task.id;
    output = '';
    await loadOutput();
  }
  function collapse() {
    outputLoader.abort();
    expanded = undefined;
  }
  /** Fetch the expanded task's output tail. Resolves true when it changed. */
  async function loadOutput(): Promise<boolean> {
    const id = expanded;
    const session = sessionId;
    if (!id) return false;
    if (app.usingDemo) {
      output = '$ bun run dev\n  VITE ready in 412 ms\n  ➜  Local: http://localhost:5173/';
      return false;
    }
    const result = await outputLoader.run(
      (signal) => panelApi.backgroundOutput(session, id, 200, signal),
      'Output unavailable.',
    );
    if (!result || expanded !== id || sessionId !== session) return false;
    // Measured after the await: the element may belong to a task shown since.
    const follow =
      !outputEl || outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 24;
    const changed = result.output !== output;
    output = result.output;
    if (follow && changed)
      requestAnimationFrame(() => outputEl?.scrollTo({ top: outputEl.scrollHeight }));
    return changed;
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
    const session = sessionId;
    try {
      const { task: next } = await panelApi.stopBackground(session, task.id, generation);
      if (session === sessionId) app.panel.updateTask(next);
    } catch (cause) {
      if (session === sessionId) stopError = errorMessage(cause, 'Could not stop the task.');
    }
  }
  function clearFinished() {
    cleared = new Set([...cleared, ...finished.map((task) => task.id)]);
    if (expanded && cleared.has(expanded)) collapse();
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

  // Outside clicks and Escape close the popover; listen only while it is open.
  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      open = false;
      root?.querySelector<HTMLButtonElement>('.jobs-trigger')?.focus();
    };
    const focusin = (event: FocusEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keydown);
    window.addEventListener('focusin', focusin);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('focusin', focusin);
    };
  });
  watch(
    () => sessionId,
    () => {
      stopError = '';
      open = false;
      collapse();
      cleared = new Set();
      void app.panel.refresh();
    },
    { immediate: true },
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
  /**
   * The expanded output follows a running task. No event reports new output,
   * so poll, backing off from 2 s to 10 s while the output stays the same.
   */
  $effect(() => {
    if (!pollWanted) return;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(async () => {
        delay = (await loadOutput()) ? 2000 : Math.min(10_000, delay * 1.5);
        next();
      }, delay);
    };
    next();
    return () => clearTimeout(timer);
  });
  // A status change of the expanded task (e.g. it finished) refreshes its output.
  watch(
    () => expandedTask && `${expandedTask.id}\n${expandedTask.status}`,
    (key, previous) => {
      if (key && previous?.split('\n')[0] === key.split('\n')[0]) void loadOutput();
    },
  );
</script>

{#if visible}
  <div class="jobs-menu" bind:this={root} transition:fade={{ duration: motion(120) }}>
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
      <div
        class="jobs-popover"
        role="dialog"
        aria-modal="false"
        aria-label="Background jobs"
        bind:this={popover}
        use:rovingFocus={{ selector: 'button', orientation: 'vertical', wrap: false }}
      >
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
        <span class="job-duration">{duration(task.startedAt, task.endedAt, now)}</span>
        <span class="job-chevron" class:open={expanded === task.id}><ChevronRight size={13} /></span
        >
      </button>
      {#if task.status === 'running' && hasControl}
        <button
          class="job-stop touch-target"
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
        <span class="job-stop pending" role="img" aria-label="Stopping"
          ><LoaderCircle class="spin" size={12} /></span
        >
      {/if}
    </div>
    {#if expanded === task.id}
      {#if outputLoader.error}<p class="jobs-error">{outputLoader.error}</p>{/if}
      <pre class="job-output" bind:this={outputEl}>{output || 'No output yet.'}</pre>
    {/if}
  </div>
{/snippet}

<style>
  /* Top-bar background jobs: a quiet trigger and its popover. */
  .jobs-menu {
    position: relative;
  }
  .jobs-trigger {
    height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px 0 10px;
    border: 0;
    border-radius: 999px;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    white-space: nowrap;
  }
  .jobs-trigger.live {
    color: var(--text-2);
  }
  .jobs-trigger:hover,
  .jobs-trigger.open {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .jobs-trigger > :global(svg) {
    transition: transform 0.12s var(--ease);
  }
  .jobs-trigger.open > :global(svg) {
    transform: rotate(180deg);
  }
  .jobs-count {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }
  .jobs-popover {
    position: absolute;
    z-index: 40;
    top: calc(100% + 6px);
    right: 0;
    width: min(480px, calc(100dvw - 24px));
    max-height: min(480px, calc(100dvh - 120px));
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px;
    overflow: auto;
    border-radius: var(--radius-lg);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
  }
  .jobs-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 4px 6px 2px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    line-height: 18px;
  }
  .jobs-section:first-child {
    margin-top: 0;
    border-top: 0;
  }
  .jobs-section-toggle {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 4px;
    border: 0;
    border-radius: 5px;
    color: var(--muted);
    background: transparent;
    font-size: 11px;
  }
  .jobs-section-toggle:hover {
    color: var(--text-2);
    background: var(--bg-hover);
  }
  .section-chevron,
  .job-chevron {
    display: grid;
    transition: transform 0.12s var(--ease);
  }
  .section-chevron.open,
  .job-chevron.open {
    transform: rotate(90deg);
  }
  .job-item {
    display: flex;
    flex-direction: column;
  }
  .job-line {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 10px;
  }
  .job-line.live {
    background: var(--bg-hover);
  }
  .job-row {
    min-width: 0;
    flex: 1;
    min-height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: 9px;
    color: var(--ink);
    background: transparent;
    font-size: 12.5px;
    text-align: left;
  }
  button.job-row:hover {
    background: var(--bg-hover);
  }
  .job-line.live button.job-row:hover {
    background: transparent;
  }
  .job-row.static {
    cursor: default;
  }
  .job-row.settled {
    color: var(--text-2);
  }
  .job-icon {
    flex: none;
    display: grid;
    color: var(--muted);
  }
  .job-main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .job-label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .job-label.mono {
    font: 12px/18px var(--font-mono);
  }
  .job-sub {
    overflow: hidden;
    color: var(--muted);
    font-size: 11.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .job-meta {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .job-duration {
    flex: none;
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .job-chevron {
    flex: none;
    color: var(--faint);
  }
  .job-stop {
    flex: none;
    height: 22px;
    min-width: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-right: 5px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--text-2);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line-dark);
    font-size: 11px;
  }
  .job-stop:hover:not(.pending),
  .job-stop.armed {
    color: var(--danger);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .job-stop.armed {
    padding: 0 8px;
    background: var(--danger-soft);
  }
  .job-stop.pending {
    color: var(--muted);
  }
  .job-output {
    max-height: 240px;
    margin: 4px 4px 6px;
    padding: 8px 10px;
    overflow: auto;
    border-radius: var(--radius-sm);
    color: var(--code-ink);
    background: var(--code-bg);
    box-shadow: 0 0 0 1px var(--line);
    font: 11.5px/1.5 var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .jobs-error {
    margin: 2px 8px 4px;
    color: var(--danger);
    font-size: 12px;
  }
  @media (max-width: 650px) {
    .jobs-label {
      display: none;
    }
    .jobs-trigger {
      height: 32px;
      padding: 0 8px;
    }
    .jobs-popover {
      position: fixed;
      top: 60px;
      right: 12px;
      left: 12px;
      width: auto;
    }
  }
</style>
