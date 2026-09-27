<script lang="ts">
  import { ArrowLeft, Bot, ListChecks, RefreshCw, SquareTerminal, Users } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { app } from '../../app.svelte';
  import { Loader } from '../../loader.svelte';
  import { panelApi, type BackgroundTask } from '../../panel-api';
  import { duration } from '../../time';
  import { watch } from '../../watch.svelte';

  interface Props {
    sessionId: string;
    /** Shown in the panel: loads on activation and follows changes while shown. */
    active?: boolean;
  }

  let { sessionId, active = true }: Props = $props();

  let selected: BackgroundTask | undefined = $state.raw();
  let output = $state('');
  let outputEl: HTMLPreElement | undefined = $state();
  const outputLoader = new Loader();
  const panelState = $derived(app.panel.value);

  // The tab outlives a session switch; a task id means nothing in another session.
  watch(
    () => sessionId,
    () => {
      outputLoader.abort();
      selected = undefined;
      output = '';
    },
  );

  async function openTask(task: BackgroundTask) {
    selected = task;
    output = '';
    await refreshOutput();
  }
  async function refreshOutput() {
    if (!selected) return;
    const id = sessionId;
    const taskId = selected.id;
    const result = await outputLoader.run(
      (signal) => panelApi.backgroundOutput(id, taskId, 400, signal),
      'Unable to load output.',
    );
    if (!result || id !== sessionId || selected?.id !== taskId) return;
    selected = result.task;
    output = result.output;
    requestAnimationFrame(() => outputEl?.scrollTo({ top: outputEl.scrollHeight }));
  }
  function back() {
    outputLoader.abort();
    selected = undefined;
  }

  let tasks = $derived((panelState?.backgroundTasks ?? []).slice().reverse());
  let agents = $derived(panelState?.team.agents ?? []);
  let teammates = $derived(agents.filter((agent) => agent.mode !== 'subagent'));
  let subagents = $derived(agents.filter((agent) => agent.mode === 'subagent').reverse());
  let boardTasks = $derived(panelState?.team.tasks ?? []);
  let teamEvents = $derived((panelState?.team.events ?? []).slice(-12).reverse());
  // Keep a running task's view fresh when its status changes.
  let live = $derived(selected ? tasks.find((task) => task.id === selected?.id) : undefined);
  watch(
    () => live && `${live.id}\n${live.status}`,
    (key, previous) => {
      if (key && previous?.split('\n')[0] === key.split('\n')[0]) void refreshOutput();
    },
  );

  // Tab activation refreshes the list; while shown it follows task and team changes.
  watch(
    () => active,
    (shown) => {
      if (shown) void app.panel.refresh();
    },
    { immediate: true },
  );
  onDestroy(
    app.onPanel((signal) => {
      if (!active) return;
      if (signal.type === 'run-finished') app.panel.schedule(100);
      else if (signal.sections.some((section) => section === 'background' || section === 'team'))
        app.panel.schedule();
    }),
  );
</script>

<div class="tab-body">
  {#if selected}
    <div class="drill-head">
      <button class="icon-button small" type="button" aria-label="Back" onclick={back}
        ><ArrowLeft size={16} /></button
      >
      <span class="drill-title mono">{selected.id}</span>
      <span class="chip status-{selected.status}">{selected.status.replace('_', ' ')}</span>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh output"
        onclick={refreshOutput}
        disabled={outputLoader.loading}
        ><RefreshCw class={outputLoader.loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    <pre class="task-command">{selected.command}</pre>
    {#if outputLoader.error}<p class="panel-error">{outputLoader.error}</p>{/if}
    <pre class="task-output" bind:this={outputEl}>{output || 'No output yet.'}</pre>
  {:else if app.panel.error && !panelState}
    <p class="panel-error">{app.panel.error}</p>
  {:else if !panelState}
    <p class="panel-empty">Loading…</p>
  {:else if !panelState.agentRunning && !tasks.length && !agents.length}
    <p class="panel-empty">
      The agent is not running. Background tasks, subagents and teammates appear here while it is.
    </p>
  {:else}
    <div class="group-title">Background tasks<span>{tasks.length}</span></div>
    {#if !tasks.length}
      <p class="panel-empty">No background tasks.</p>
    {:else}
      <ul class="file-list">
        {#each tasks as task (task.id)}
          <li>
            <button type="button" class="task-row" onclick={() => openTask(task)}>
              <SquareTerminal size={15} />
              <span class="task-text">
                <span class="task-cmd">{task.command}</span>
                <span class="memory-sub"
                  ><span class="mono">{task.id}</span> · {duration(
                    task.startedAt,
                    task.endedAt,
                  )}{#if task.exitCode !== undefined && task.exitCode !== null}
                    · exit {task.exitCode}{/if}</span
                >
              </span>
              {#if task.tty}<span class="chip">tty</span>{/if}
              {#if task.notifyOn}<span class="chip" title="notify_on /{task.notifyOn}/"
                  >watch {task.matches ?? 0}</span
                >{/if}
              <span class="chip status-{task.status}">{task.status.replace('_', ' ')}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if subagents.length}
      <div class="group-title">Subagents<span>{subagents.length}</span></div>
      <ul class="file-list">
        {#each subagents as agent (agent.name)}
          <li class="task-row static">
            <Bot size={15} />
            <span class="task-text">
              <span class="task-cmd"
                >{agent.name}<span class="muted">
                  · {agent.kind ?? 'general'}{agent.background
                    ? ' · background'
                    : ''}{#if agent.model}
                    · {agent.model}{/if}</span
                ></span
              >
              {#if agent.task}<span class="memory-sub clamped">{agent.task}</span>{/if}
              {#if agent.lastError}<span class="memory-sub danger">{agent.lastError}</span>{/if}
            </span>
            <span class="chip status-{agent.status}">{agent.status ?? 'unknown'}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if boardTasks.length}
      <div class="group-title">Task board<span>{boardTasks.length}</span></div>
      <ul class="file-list">
        {#each boardTasks as task (task.id)}
          <li class="task-row static">
            <ListChecks size={15} />
            <span class="task-text">
              <span class="task-cmd"><span class="mono">#{task.id}</span> {task.subject}</span>
              <span class="memory-sub"
                >{task.owner ? `owner ${task.owner}` : 'unowned'}{#if task.blockedBy.length}
                  · after {task.blockedBy.map((id) => `#${id}`).join(', ')}{/if}{#if task.blocked}
                  · blocked{/if}</span
              >
            </span>
            <span class="chip status-{task.status}">{task.status.replace('_', ' ')}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="group-title">Teammates<span>{teammates.length}</span></div>
    {#if !teammates.length}
      <p class="panel-empty">No teammates spawned.</p>
    {:else}
      <ul class="file-list">
        {#each teammates as agent (agent.name)}
          <li class="task-row static">
            <Users size={15} />
            <span class="task-text">
              <span class="task-cmd"
                >{agent.name}{#if agent.model}<span class="muted"> · {agent.model}</span>{/if}</span
              >
              {#if agent.task}<span class="memory-sub clamped">{agent.task}</span>{/if}
              {#if agent.lastError}<span class="memory-sub danger">{agent.lastError}</span>{/if}
            </span>
            <span class="chip status-{agent.status}">{agent.status ?? 'unknown'}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if teamEvents.length}
      <div class="group-title">Recent team activity</div>
      <ul class="event-list">
        {#each teamEvents as event (event.id)}
          <li>
            <span class="muted">{new Date(event.time).toLocaleTimeString()}</span>
            <strong>{event.kind}</strong>
            {#if event.from || event.to}<span
                >{event.from ?? ''}{event.to ? ` → ${event.to}` : ''}</span
              >{/if}
            {#if event.body}<p>{event.body}</p>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .event-list {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .task-row {
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    font-size: 13px;
    text-align: left;
  }
  button.task-row:hover {
    background: var(--bg-hover);
  }
  .task-row :global(svg) {
    flex: none;
    color: var(--muted);
  }
  .task-text {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }
  .task-cmd {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .task-cmd {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .memory-sub.danger {
    color: var(--danger);
  }
  .task-row.static {
    align-items: flex-start;
  }
  .task-command,
  .task-output {
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border-radius: var(--radius-md);
    color: var(--code-ink);
    background: var(--code-bg);
    box-shadow: 0 0 0 1px var(--line);
    font: 12px/1.5 var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .task-output {
    max-height: calc(100dvh - 260px);
    white-space: pre;
  }
  .event-list li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    padding: 5px 8px;
    font-size: 12px;
  }
  .event-list p {
    width: 100%;
    margin: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
</style>
