<script lang="ts">
  /**
   * The dashboard's Sources card (design screen 5): one row per source, the
   * failing one tinted red with the last error, the paused one muted, and the
   * way into Settings → Models & sources. The Sources section below lists the
   * same sources with when each was last read and which rooms follow it.
   */
  import { ApiError } from '../../http';
  import { t } from '../../i18n';
  import { sourcesApi, type Source } from '../../sources';
  import { ago } from '../../time';
  import StatusGlyph from '../StatusGlyph.svelte';

  interface Props {
    /** Room names by id; a room not in it shows its id. */
    roomNames: Record<string, string>;
    disabled?: boolean;
    /** Open Settings on Models & sources. */
    onsettings: () => void;
  }

  let { roomNames, disabled = false, onsettings }: Props = $props();

  let sources = $state<Source[]>([]);
  let loading = $state(true);
  let error = $state('');

  $effect(() => {
    if (disabled) {
      loading = false;
      return;
    }
    void load();
  });

  async function load() {
    try {
      const list = await sourcesApi.list();
      sources = list.sources ?? [];
      error = '';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
    } finally {
      loading = false;
    }
  }

  const tone = (source: Source) =>
    source.pausedAt ? 'paused' : source.failures > 0 ? 'failing' : 'ok';
  const detail = (source: Source) => {
    const followed = source.rooms.length
      ? t('engine.sources.followed', {
          rooms: source.rooms.map((id) => `#${roomNames[id] ?? id}`).join(', '),
        })
      : t('engine.sources.noFollower');
    const read = source.lastPolledAt
      ? t('engine.source.read', { when: ago(source.lastPolledAt) })
      : t('engine.source.notRead');
    return `${read} · ${followed}`;
  };
</script>

<section class="card" aria-labelledby="sources-card-title">
  <div class="card-head">
    <h2 id="sources-card-title" class="section-label">{t('engine.section.sources')}</h2>
    <button class="link" type="button" onclick={onsettings}>{t('engine.sources.manage')}</button>
  </div>
  {#if disabled}
    <p class="muted">{t('engine.demoUnavailable')}</p>
  {:else if loading}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if !sources.length}
    <p class="muted">{t('engine.sources.empty')}</p>
  {:else}
    <ul class="items">
      {#each sources as source (source.id)}
        {@const state = tone(source)}
        <li class:failing={state === 'failing'} class:paused={state === 'paused'}>
          <div class="row">
            <StatusGlyph
              state={state === 'failing' ? 'error' : state === 'paused' ? 'idle' : 'working'}
            />
            <strong>{source.name}</strong>
            <span class:problem={state === 'failing'} class="kind">
              {#if state === 'failing'}
                {t('engine.sources.failing', { count: source.failures })}
              {:else if state === 'paused'}
                {t('common.status.paused')}
              {:else}
                {source.kind}
              {/if}
            </span>
          </div>
          <span class="detail">
            {#if state === 'failing' && source.lastError}
              {source.lastError}
            {:else}
              {detail(source)}
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .card-head h2 {
    margin: 0;
  }
  .link {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent-ink);
    font-size: 13px;
  }
  .link:hover {
    text-decoration: underline;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 -8px;
    padding: 0;
    list-style: none;
  }
  .items li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: var(--radius-md);
  }
  .items li.failing {
    background: var(--danger-soft);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .row strong {
    flex: 1;
    color: var(--ink);
    font-weight: 500;
    font-size: 14px;
  }
  .kind {
    color: var(--faint);
    font-size: 12px;
  }
  .kind.problem {
    color: var(--danger);
    font-weight: 600;
  }
  .detail {
    padding-left: 16px;
    color: var(--faint);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .items li.failing .detail {
    color: color-mix(in srgb, var(--danger) 55%, var(--ink));
  }
  .items li.paused .row strong {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
</style>
