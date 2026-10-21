<script lang="ts">
  /**
   * How the sources are doing (plan 09): when each was last read, whether it
   * fails, and which rooms follow it. Adding and changing them is in Settings.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../../http';
  import { sourcesApi, type Source } from '../../sources';
  import { ago } from '../../time';

  interface Props {
    roomNames: Record<string, string>;
    disabled?: boolean;
  }

  let { roomNames, disabled = false }: Props = $props();

  let sources = $state<Source[]>([]);
  let loading = $state(true);
  let error = $state('');

  onMount(() => {
    if (disabled) {
      loading = false;
      return;
    }
    sourcesApi
      .list()
      .then((list) => (sources = list.sources))
      .catch((cause) => {
        error = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
      })
      .finally(() => (loading = false));
  });

  function health(source: Source): { label: string; tone: 'ok' | 'paused' | 'failing' } {
    if (source.pausedAt) return { label: 'Paused', tone: 'paused' };
    if (source.failures > 0)
      return { label: `Failing (${source.failures} in a row)`, tone: 'failing' };
    return { label: 'Fine', tone: 'ok' };
  }
</script>

<section class="settings-section" aria-labelledby="sources-status-title">
  <h3 id="sources-status-title">Sources</h3>
  {#if disabled}
    <p class="muted">Not available in demo mode.</p>
  {:else if loading}
    <p class="muted" role="status">Loading…</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if !sources.length}
    <p class="muted">No sources yet. Add mail, calendars or Moodle in Settings.</p>
  {:else}
    <ul>
      {#each sources as source (source.id)}
        {@const now = health(source)}
        <li>
          <div class="row">
            <span class="dot {now.tone}" aria-hidden="true"></span>
            <strong>{source.name}</strong>
            <span class="muted">{source.kind}</span>
            <span class="state">{now.label}</span>
          </div>
          <div class="muted small">
            {source.lastPolledAt ? `Read ${ago(source.lastPolledAt)}` : 'Not read yet'}
            {#if source.rooms.length}
              · followed in {source.rooms.map((id) => `#${roomNames[id] ?? id}`).join(', ')}
            {:else}
              · no room follows it
            {/if}
          </div>
          {#if source.lastError && source.failures > 0}
            <div class="error small">{source.lastError}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .state {
    margin-left: auto;
    font-size: 13px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .dot.paused {
    background: var(--muted);
  }
  .dot.failing {
    background: var(--danger);
  }
  .small {
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
