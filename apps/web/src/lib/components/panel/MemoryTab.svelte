<script lang="ts">
  import { Brain, CircleAlert, LoaderCircle } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '../../app.svelte';
  import type { Meter } from '../../panel-api';
  import { watch } from '../../watch.svelte';

  interface Props {
    /** Shown in the panel: loads on activation and follows memory changes while shown. */
    active?: boolean;
  }

  let { active = true }: Props = $props();

  const memory = $derived(app.panel.value?.memory ?? null);
  const runtime = $derived(app.panel.value?.memoryRuntime ?? null);
  const agentRunning = $derived(app.panel.value?.agentRunning ?? false);

  watch(
    () => active,
    (shown) => {
      if (shown) void app.panel.refresh();
    },
    { immediate: true },
  );
  // Memory reports progress every turn; only follow it while the tab is shown.
  onDestroy(
    app.onPanel((signal) => {
      if (!active) return;
      if (signal.type === 'run-finished') app.panel.schedule(100);
      else if (signal.sections.includes('memory')) app.panel.schedule();
    }),
  );

  let filter: 'active' | 'all' | 'dropped' = $state('active');
  const expanded = new SvelteSet<string>();

  const pct = (meter: Meter) =>
    meter.max > 0 ? Math.min(100, (meter.value / meter.max) * 100) : 0;
  const tokens = (value: number) =>
    value >= 10_000
      ? `${Math.round(value / 1000)}k`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value);
  const phaseLabel: Record<string, string> = {
    starting: 'Starting consolidation',
    observer: 'Observing recent turns',
    reflector: 'Reflecting on observations',
    dropper: 'Pruning low-value observations',
  };
  function toggle(id: string) {
    if (!expanded.delete(id)) expanded.add(id);
  }

  let meters = $derived(
    memory
      ? [
          { key: 'observation', label: 'Next observation', meter: memory.thresholds.observation },
          { key: 'reflection', label: 'Next reflection', meter: memory.thresholds.reflection },
          { key: 'compaction', label: 'Next compaction', meter: memory.thresholds.compaction },
          { key: 'pool', label: 'Active observation pool', meter: memory.thresholds.activePool },
        ]
      : [],
  );
  let observations = $derived(
    (memory?.observations ?? [])
      .filter((o) => (filter === 'all' ? true : filter === 'dropped' ? o.dropped : !o.dropped))
      .slice()
      .reverse(),
  );
  let errors = $derived(Object.entries(runtime?.lastErrors ?? {}));
  let limited = $derived((runtime?.rateLimited ?? []).filter((item) => item.until > Date.now()));
</script>

<div class="tab-body">
  {#if app.panel.error && !app.panel.value}
    <p class="panel-error">{app.panel.error}</p>
  {:else if !app.panel.value}
    <p class="panel-empty">Loading…</p>
  {:else if !memory}
    <p class="panel-empty">Memory state is unavailable for this session.</p>
  {:else if !memory.enabled}
    <p class="panel-empty">Observational memory is disabled in this workspace’s config.</p>
  {:else}
    <div class="memory-status">
      {#if runtime?.phase}
        <span class="chip working"
          ><LoaderCircle class="spin" size={12} />
          {phaseLabel[runtime.phase] ?? runtime.phase}</span
        >
      {:else if runtime?.autoCompacting}
        <span class="chip working"><LoaderCircle class="spin" size={12} /> Compacting</span>
      {:else}
        <span class="chip"><Brain size={12} /> {agentRunning ? 'Idle' : 'Agent stopped'}</span>
      {/if}
      {#if memory.passive}<span class="chip">Passive</span>{/if}
    </div>

    <div class="stat-grid">
      <div><strong>{memory.counts.reflections}</strong><span>Reflections</span></div>
      <div><strong>{memory.counts.active}</strong><span>Active obs.</span></div>
      <div><strong>{memory.counts.dropped}</strong><span>Dropped</span></div>
      <div><strong>{memory.counts.compactions}</strong><span>Compactions</span></div>
    </div>

    <div class="meters">
      {#each meters as item (item.key)}
        <div class="meter">
          <div class="meter-label">
            <span>{item.label}</span><span class="muted"
              >{tokens(item.meter.value)} / {tokens(item.meter.max)}</span
            >
          </div>
          <div
            class="bar"
            role="progressbar"
            aria-label={item.label}
            aria-valuenow={Math.round(pct(item.meter))}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style:width="{pct(item.meter)}%" class:full={pct(item.meter) >= 100}></span>
          </div>
        </div>
      {/each}
    </div>

    {#if errors.length || limited.length}
      <div class="panel-error">
        {#each errors as [phase, message]}<p><CircleAlert size={13} /> {phase}: {message}</p>{/each}
        {#each limited as item}<p>
            {item.model} rate-limited until {new Date(item.until).toLocaleTimeString()}
          </p>{/each}
      </div>
    {/if}

    <div class="group-title">Reflections<span>{memory.reflections.length}</span></div>
    {#if !memory.reflections.length}
      <p class="panel-empty">No reflections yet.</p>
    {:else}
      <ul class="memory-list">
        {#each memory.reflections.slice().reverse() as item (item.id)}
          <li class:dim={!item.visible}>
            <button
              type="button"
              class="memory-item"
              onclick={() => toggle(item.id)}
              aria-expanded={expanded.has(item.id)}
            >
              <span class="memory-text" class:clamped={!expanded.has(item.id)}>{item.content}</span>
              <span class="memory-sub"
                ><span class="mono">{item.id}</span> · {item.supportingObservationIds.length} sources
                · {tokens(item.tokenCount)} tok{#if !item.visible}
                  · not in context{/if}</span
              >
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="group-title">
      Observations
      <div class="segmented small" role="group" aria-label="Observation filter">
        {#each ['active', 'all', 'dropped'] as option}
          <button
            type="button"
            class:active={filter === option}
            aria-pressed={filter === option}
            onclick={() => (filter = option as typeof filter)}>{option}</button
          >
        {/each}
      </div>
    </div>
    {#if !observations.length}
      <p class="panel-empty">Nothing here yet.</p>
    {:else}
      <ul class="memory-list">
        {#each observations as item (item.id)}
          <li class:dim={item.dropped}>
            <button
              type="button"
              class="memory-item"
              onclick={() => toggle(item.id)}
              aria-expanded={expanded.has(item.id)}
            >
              <span class="memory-text" class:clamped={!expanded.has(item.id)}
                ><span class="rel rel-{item.relevance}" title="{item.relevance} relevance"
                ></span>{item.content}</span
              >
              <span class="memory-sub"
                ><span class="mono">{item.id}</span> · {item.timestamp}{#if item.dropped}
                  · dropped{/if}</span
              >
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .chip.working {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .memory-list {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .memory-status {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Four across when the panel is wide enough for "Compactions", else two by two. */
  .tab-body {
    container-type: inline-size;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }
  @container (max-width: 380px) {
    .stat-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .stat-grid > div {
    display: grid;
    gap: 1px;
    padding: 8px;
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line);
  }
  .stat-grid strong {
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .stat-grid span {
    overflow: hidden;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .meters {
    display: grid;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line);
  }
  .meter {
    display: grid;
    gap: 4px;
  }
  .meter-label {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
  }
  .meter-label .muted {
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 5px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--bg-hover-strong);
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.3s var(--ease);
  }
  .bar span.full {
    background: var(--warning);
  }
  .memory-list li.dim {
    opacity: 0.55;
  }
  .memory-item {
    width: 100%;
    display: grid;
    gap: 3px;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    font-size: 13px;
    line-height: 1.45;
    text-align: left;
  }
  .memory-item:hover {
    background: var(--bg-hover);
  }
  .memory-text {
    overflow-wrap: anywhere;
  }
  .memory-text.clamped {
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .rel {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin: 0 6px 1px 0;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--faint);
  }
  .rel-medium {
    background: var(--accent);
  }
  .rel-high {
    background: var(--warning);
  }
  .rel-critical {
    background: var(--danger);
  }
</style>
