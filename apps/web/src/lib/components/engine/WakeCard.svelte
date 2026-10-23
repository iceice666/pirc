<script lang="ts">
  /**
   * The dashboard's Wakes card (design screen 5): today's wakes against the
   * day's allowance, the ones coming next (cancellable until they start) and
   * the last one that ended. The Wakes section below lists them all.
   */
  import { ApiError } from '../../http';
  import { t } from '../../i18n';
  import { ago } from '../../time';
  import { describeOutcome, describeTrigger, wakesApi, type Wake } from '../../wakes';

  interface Props {
    /** Room names by id; a room not in it shows its id. */
    roomNames: Record<string, string>;
    disabled?: boolean;
    /** Bumped when a wake changed elsewhere: reload. */
    revision?: number;
    /** A wake was cancelled here, so the full list reloads too. */
    onchanged?: () => void;
  }

  let { roomNames, disabled = false, revision = 0, onchanged }: Props = $props();

  /** Coming wakes and ended ones the card shows. */
  const SHOWN = 2;

  let coming = $state<Wake[]>([]);
  let ended = $state<Wake[]>([]);
  let today = $state({ used: 0, limit: 24 });
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');

  $effect(() => {
    void revision;
    if (disabled) {
      loading = false;
      return;
    }
    void load();
  });

  async function load() {
    try {
      const list = await wakesApi.list('all', 30);
      const all = list.wakes ?? [];
      coming = all.filter((wake) => wake.outcome === null);
      ended = all.filter((wake) => wake.outcome !== null);
      today = list.today ?? today;
      error = '';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
    } finally {
      loading = false;
    }
  }

  async function cancel(wake: Wake) {
    if (busy) return;
    busy = wake.id;
    error = '';
    try {
      await wakesApi.cancel(wake.id);
      await load();
      onchanged?.();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
    } finally {
      busy = '';
    }
  }

  const room = (wake: Wake) => `#${roomNames[wake.roomId] ?? wake.roomId}`;
  const percent = $derived(
    today.limit > 0 ? Math.min(100, Math.round((today.used / today.limit) * 100)) : 0,
  );
</script>

<section class="card" aria-labelledby="wakes-card-title">
  <div class="card-head">
    <h2 id="wakes-card-title" class="section-label">{t('engine.section.wakes')}</h2>
    <span class="count">{t('engine.wakes.today', { used: today.used, limit: today.limit })}</span>
  </div>
  {#if disabled}
    <p class="muted">{t('engine.demoUnavailable')}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if loading && !coming.length && !ended.length}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else}
    <div
      class="bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax={today.limit}
      aria-valuenow={today.used}
      aria-label={t('engine.wakes.today', { used: today.used, limit: today.limit })}
    >
      <span style:width={`${percent}%`}></span>
    </div>
    <h3 class="group">{t('engine.wakes.coming')}</h3>
    {#if coming.length}
      <ul class="items">
        {#each coming.slice(0, SHOWN) as wake (wake.id)}
          <li class="row">
            <time class="when">{describeOutcome(wake)}</time>
            <span class="body">
              <span class="trigger">{describeTrigger(wake)}</span>
              <span class="meta">{room(wake)}</span>
            </span>
            {#if !wake.startedAt}
              <button class="link" type="button" disabled={!!busy} onclick={() => void cancel(wake)}
                >{t('common.cancel')}</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">{t('settings.wakes.empty')}</p>
    {/if}
    {#if ended.length}
      <h3 class="group">{t('engine.wakes.recent')}</h3>
      <ul class="items">
        {#each ended.slice(0, SHOWN) as wake (wake.id)}
          <li class="row">
            <time class="when">{ago(wake.endedAt ?? wake.scheduledAt)}</time>
            <span class="body">
              <span class="trigger">{describeTrigger(wake)}</span>
              <span class="meta">{room(wake)} · {describeOutcome(wake)}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
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
  .count {
    margin-left: auto;
    color: var(--text-2);
    font-size: 12px;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 6px;
    background: var(--accent);
  }
  .group {
    margin: 2px 0 0;
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .when {
    flex: 0 0 64px;
    color: var(--muted);
    font-size: 12px;
    line-height: 20px;
  }
  .body {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    font-size: 13px;
  }
  .trigger {
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--faint);
    font-size: 12px;
  }
  .link {
    flex: none;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: var(--accent-ink);
    font-size: 13px;
  }
  .link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .error {
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
</style>
