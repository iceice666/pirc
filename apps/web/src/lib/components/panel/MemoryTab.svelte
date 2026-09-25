<script lang="ts">
  import { Brain, CircleAlert, LoaderCircle } from '@lucide/svelte';
  import type { MemoryPanel, MemoryRuntime, Meter } from '../../panel-api';

  export let memory: MemoryPanel | null;
  export let runtime: MemoryRuntime | null;
  export let agentRunning = false;

  let filter: 'active' | 'all' | 'dropped' = 'active';
  let expanded = new Set<string>();

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
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    expanded = expanded;
  }

  $: meters = memory
    ? [
        { key: 'observation', label: 'Next observation', meter: memory.thresholds.observation },
        { key: 'reflection', label: 'Next reflection', meter: memory.thresholds.reflection },
        { key: 'compaction', label: 'Next compaction', meter: memory.thresholds.compaction },
        { key: 'pool', label: 'Active observation pool', meter: memory.thresholds.activePool },
      ]
    : [];
  $: observations = (memory?.observations ?? [])
    .filter((o) => (filter === 'all' ? true : filter === 'dropped' ? o.dropped : !o.dropped))
    .slice()
    .reverse();
  $: errors = Object.entries(runtime?.lastErrors ?? {});
  $: limited = (runtime?.rateLimited ?? []).filter((item) => item.until > Date.now());
</script>

<div class="tab-body">
  {#if !memory}
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
              on:click={() => toggle(item.id)}
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
      <div class="segmented small" role="tablist" aria-label="Observation filter">
        {#each ['active', 'all', 'dropped'] as option}
          <button
            type="button"
            role="tab"
            class:active={filter === option}
            aria-selected={filter === option}
            on:click={() => (filter = option as typeof filter)}>{option}</button
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
              on:click={() => toggle(item.id)}
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
