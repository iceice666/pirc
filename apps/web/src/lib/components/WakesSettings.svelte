<script lang="ts">
  /**
   * Wakes (plans/rewrite/05-self-wake.md): when pirc wakes up on its own, and how
   * each wake went. Most leave nothing in the room; this is where they show.
   * Settings holds the list until the engine pages do (plan 11).
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { t } from '../i18n';
  import { ago } from '../time';
  import { watch } from '../watch.svelte';
  import { describeOutcome, describeTrigger, wakesApi, type Wake } from '../wakes';

  interface Props {
    disabled?: boolean;
    /** Bumped when a wake changed somewhere: reload. */
    revision?: number;
    /** Room names by id; a room not in it shows its id. */
    roomNames?: Record<string, string>;
  }

  let { disabled = false, revision = 0, roomNames = {} }: Props = $props();

  /** Ended wakes listed at most. */
  const ENDED_PAGE = 30;

  let coming: Wake[] = $state([]);
  let ended: Wake[] = $state([]);
  let today = $state({ used: 0, limit: 24 });
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let alive = true;

  const roomName = (id: string) => `#${roomNames[id] ?? id}`;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : t('settings.gateway.unreachable');

  async function load() {
    try {
      const list = await wakesApi.list('all', ENDED_PAGE);
      if (!alive) return;
      coming = list.wakes.filter((wake) => wake.outcome === null);
      ended = list.wakes.filter((wake) => wake.outcome !== null);
      today = list.today;
      error = '';
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  async function cancel(wake: Wake) {
    if (busy) return;
    busy = wake.id;
    error = '';
    try {
      await wakesApi.cancel(wake.id);
      await load();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = '';
    }
  }

  onMount(() => {
    if (disabled) loading = false;
    else void load();
    return () => {
      alive = false;
    };
  });
  // Wakes start, end and are scheduled in the rooms while this is open.
  watch(
    () => revision,
    () => {
      if (!disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="wakes-title">
  <h3 id="wakes-title">{t('settings.wakes.title')}</h3>
  <p>{t('settings.wakes.intro', { limit: today.limit })}</p>

  {#if disabled}
    <p role="status">{t('settings.wakes.demo')}</p>
  {:else if loading}
    <p role="status">{t('settings.wakes.loading')}</p>
  {:else}
    {#if error}<p class="wakes-error" role="alert">{error}</p>{/if}
    <p class="wakes-today">
      {t('settings.wakes.today', { used: today.used, limit: today.limit })}
    </p>
    {#if coming.length}
      <ul class="wakes-list" aria-label={t('settings.wakes.comingAria')}>
        {#each coming as wake (wake.id)}
          <li>
            <div class="wakes-row">
              <div class="wakes-text">
                <span>{describeTrigger(wake)}</span>
                <small class="wakes-next">{describeOutcome(wake)} · {roomName(wake.roomId)}</small>
              </div>
              {#if !wake.startedAt}
                <button
                  class="button ghost small"
                  type="button"
                  disabled={!!busy}
                  onclick={() => cancel(wake)}>{t('common.cancel')}</button
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{t('settings.wakes.empty')}</p>
    {/if}

    {#if ended.length}
      <details class="wakes-ended">
        <summary>{t('settings.wakes.recent', { count: ended.length })}</summary>
        <ul class="wakes-list" aria-label={t('settings.wakes.recentAria')}>
          {#each ended as wake (wake.id)}
            <li>
              <div class="wakes-text">
                <span>{describeTrigger(wake)}</span>
                <small
                  >{describeOutcome(wake)} · {roomName(wake.roomId)} · {ago(
                    wake.endedAt ?? wake.scheduledAt,
                  )}</small
                >
              </div>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</section>

<style>
  .wakes-error {
    color: var(--danger);
  }
  .wakes-today {
    color: var(--muted);
    font-size: 13px;
  }
  .wakes-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .wakes-list > li {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .wakes-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 12px;
  }
  .wakes-text {
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  small {
    color: var(--muted);
    font-size: 12px;
  }
  .wakes-next {
    color: var(--accent);
  }
  .wakes-ended {
    margin-top: 10px;
  }
  .wakes-ended summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
  }
</style>
