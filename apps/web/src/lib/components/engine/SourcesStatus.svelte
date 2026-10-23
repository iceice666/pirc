<script lang="ts">
  /**
   * How the sources are doing (plan 09): when each was last read, whether it
   * fails, and which rooms follow it. Adding and changing them is in Settings.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../../http';
  import { t } from '../../i18n';
  import { sourcesApi, type Source } from '../../sources';
  import { ago } from '../../time';
  import StatusGlyph from '../StatusGlyph.svelte';

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
        error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
      })
      .finally(() => (loading = false));
  });

  function health(source: Source): { label: string; tone: 'ok' | 'paused' | 'failing' } {
    if (source.pausedAt) return { label: t('common.status.paused'), tone: 'paused' };
    if (source.failures > 0)
      return {
        label: t('engine.sources.failing', { count: source.failures }),
        tone: 'failing',
      };
    return { label: t('engine.sources.fine'), tone: 'ok' };
  }
</script>

<section class="settings-section" aria-labelledby="sources-status-title">
  <h3 id="sources-status-title">{t('engine.section.sources')}</h3>
  {#if disabled}
    <p class="muted">{t('engine.demoUnavailable')}</p>
  {:else if loading}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if !sources.length}
    <p class="muted">{t('engine.sources.empty')}</p>
  {:else}
    <ul>
      {#each sources as source (source.id)}
        {@const now = health(source)}
        <li>
          <div class="row">
            <StatusGlyph
              state={now.tone === 'failing' ? 'error' : now.tone === 'paused' ? 'idle' : 'working'}
            />
            <strong>{source.name}</strong>
            <span class="muted">{source.kind}</span>
            <span class="state">{now.label}</span>
          </div>
          <div class="muted small">
            {source.lastPolledAt
              ? t('engine.source.read', { when: ago(source.lastPolledAt) })
              : t('engine.source.notRead')}
            {#if source.rooms.length}
              · {t('engine.sources.followed', {
                rooms: source.rooms.map((id) => `#${roomNames[id] ?? id}`).join(', '),
              })}
            {:else}
              · {t('engine.sources.noFollower')}
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
    padding: 4px 12px;
    list-style: none;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  li {
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
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
