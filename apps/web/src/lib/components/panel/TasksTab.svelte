<script lang="ts">
  import { ArrowLeft, Bot, ListChecks, RefreshCw, SquareTerminal, Users } from '@lucide/svelte';
  import { panelApi, type BackgroundTask, type PanelState } from '../../panel-api';
  import { watch } from '../../watch.svelte';

  interface Props {
    sessionId: string;
    panelState: PanelState | undefined;
  }

  let { sessionId, panelState }: Props = $props();

  let selected: BackgroundTask | undefined = $state();
  let output = $state('');
  let error = $state('');
  let loading = $state(false);
  let outputEl: HTMLPreElement | undefined = $state();

  // The tab outlives a session switch; a task id means nothing in another session.
  watch(
    () => sessionId,
    () => {
      selected = undefined;
      output = '';
      error = '';
    },
  );

  async function openTask(task: BackgroundTask) {
    selected = task;
    await refreshOutput();
  }
  async function refreshOutput() {
    if (!selected) return;
    const id = sessionId;
    const taskId = selected.id;
    loading = true;
    error = '';
    try {
      const result = await panelApi.backgroundOutput(id, taskId);
      if (id !== sessionId || selected?.id !== taskId) return;
      selected = result.task;
      output = result.output;
      requestAnimationFrame(() => outputEl?.scrollTo({ top: outputEl.scrollHeight }));
    } catch (cause) {
      if (id !== sessionId || selected?.id !== taskId) return;
      error = cause instanceof Error ? cause.message : 'Unable to load output.';
    } finally {
      loading = false;
    }
  }
  function elapsed(start?: string | number, end?: string | number) {
    if (!start) return '';
    const from = new Date(start).getTime();
    const to = end ? new Date(end).getTime() : Date.now();
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  let tasks = $derived((panelState?.backgroundTasks ?? []).slice().reverse());
  let agents = $derived(panelState?.team.agents ?? []);
  let teammates = $derived(agents.filter((agent) => agent.mode !== 'subagent'));
  let subagents = $derived(agents.filter((agent) => agent.mode === 'subagent').reverse());
  let boardTasks = $derived(panelState?.team.tasks ?? []);
  let teamEvents = $derived((panelState?.team.events ?? []).slice(-12).reverse());
  // Keep a running task's view fresh when the parent reports a change.
  let live = $derived(selected ? tasks.find((task) => task.id === selected?.id) : undefined);
  watch(
    () => live && `${live.id}\n${live.status}`,
    (key, previous) => {
      if (key && previous?.split('\n')[0] === key.split('\n')[0]) void refreshOutput();
    },
  );
</script>

<div class="tab-body">
  {#if selected}
    <div class="drill-head">
      <button
        class="icon-button small"
        type="button"
        aria-label="Back"
        onclick={() => (selected = undefined)}><ArrowLeft size={16} /></button
      >
      <span class="drill-title mono">{selected.id}</span>
      <span class="chip status-{selected.status}">{selected.status.replace('_', ' ')}</span>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh output"
        onclick={refreshOutput}
        disabled={loading}><RefreshCw class={loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    <pre class="task-command">{selected.command}</pre>
    {#if error}<p class="panel-error">{error}</p>{/if}
    <pre class="task-output" bind:this={outputEl}>{output || 'No output yet.'}</pre>
  {:else if !panelState?.agentRunning && !tasks.length && !agents.length}
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
                  ><span class="mono">{task.id}</span> · {elapsed(
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
