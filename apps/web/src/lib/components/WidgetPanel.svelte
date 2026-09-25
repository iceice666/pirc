<script lang="ts">
  export let widgets: Record<string, string[]> = {};
  export let statuses: Record<string, string> = {};
  $: panels = Object.entries(widgets).filter(([, lines]) => lines.length);
  $: statusText = Object.values(statuses).filter(Boolean);
</script>

{#if panels.length || statusText.length}
  <aside class="widget-panel" aria-label="Agent status">
    {#each panels as [key, lines] (key)}
      <section class="widget">
        <strong>{lines[0]}</strong>
        {#if lines.length > 1}
          <ul>
            {#each lines.slice(1) as line}<li>{line}</li>{/each}
          </ul>
        {/if}
      </section>
    {/each}
    {#if statusText.length}
      <p class="status-line">{statusText.join(' · ')}</p>
    {/if}
  </aside>
{/if}

<style>
  .widget-panel {
    display: grid;
    gap: 0.4rem;
    margin: 0 auto 8px;
    width: min(796px, calc(100% - 64px));
    padding: 10px 16px;
    border-radius: var(--radius-lg);
    color: var(--text-2);
    font-size: 13px;
    background: var(--bg-subtle);
  }
  .widget strong {
    color: var(--ink);
    font-weight: 500;
  }
  ul {
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.1rem;
  }
  li {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-line {
    margin: 0;
    color: var(--muted);
  }
</style>
