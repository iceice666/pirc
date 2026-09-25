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
    margin: 0 auto 0.5rem;
    width: min(100%, 52rem);
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--border, rgb(127 127 127 / 25%));
    border-radius: 0.6rem;
    font-size: 0.82rem;
    background: var(--surface, transparent);
  }
  .widget strong {
    font-size: 0.78rem;
    letter-spacing: 0.02em;
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
    opacity: 0.75;
  }
</style>
