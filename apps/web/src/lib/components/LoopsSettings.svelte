<script lang="ts">
  /**
   * Open loops (plans/rewrite/04-open-loops.md): what is still open between pirc and
   * you, always on its mind until closed. Settings holds the list until the faces'
   * pages do (plan 10).
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { t } from '../i18n';
  import { describeAnchor, describeClosed, loopsApi, type OpenLoop } from '../loops';
  import { describeOrigin } from '../memory';
  import { ago } from '../time';
  import { watch } from '../watch.svelte';

  interface Props {
    disabled?: boolean;
    /** Bumped when a loop changed somewhere: reload. */
    revision?: number;
  }

  let { disabled = false, revision = 0 }: Props = $props();

  /** Closed loops listed at most. */
  const CLOSED_PAGE = 20;

  let open: OpenLoop[] = $state([]);
  let closed: OpenLoop[] = $state([]);
  let limit = $state(40);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let alive = true;

  const openDetail = (loop: OpenLoop) =>
    [
      describeOrigin(loop.origin),
      loop.why,
      loop.nextCheck ? t('settings.loops.nextCheck', { when: loop.nextCheck }) : '',
      ago(loop.lastTouchedAt),
    ]
      .filter(Boolean)
      .join(' · ');
  const closedDetail = (loop: OpenLoop) =>
    [
      loop.closedReason
        ? t('settings.loops.closed', { reason: describeClosed(loop.closedReason) })
        : t('settings.loops.closedPlain'),
      loop.closedAt ? ago(loop.closedAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : t('settings.gateway.unreachable');

  async function load() {
    try {
      const [opened, done] = await Promise.all([
        loopsApi.list('open'),
        loopsApi.list('closed', CLOSED_PAGE),
      ]);
      if (!alive) return;
      open = opened.loops;
      limit = opened.limit;
      closed = done.loops;
      error = '';
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  async function act(loop: OpenLoop, run: () => Promise<unknown>) {
    if (busy) return;
    busy = loop.id;
    error = '';
    try {
      await run();
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
  // pirc opens and closes loops in the rooms while this is open.
  watch(
    () => revision,
    () => {
      if (!disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="loops-title">
  <h3 id="loops-title">{t('settings.loops.title')}</h3>
  <p>{t('settings.loops.intro', { limit })}</p>

  {#if disabled}
    <p role="status">{t('settings.loops.demo')}</p>
  {:else if loading}
    <p role="status">{t('settings.loops.loading')}</p>
  {:else}
    {#if error}<p class="loops-error" role="alert">{error}</p>{/if}
    {#if open.length}
      <ul class="loops-list" aria-label={t('settings.loops.title')}>
        {#each open as loop (loop.id)}
          <li>
            <div class="loops-row">
              <div class="loops-text">
                <span>{loop.what}</span>
                {#if loop.anchor}<small class="loops-next">{describeAnchor(loop)}</small>{/if}
                <small>{openDetail(loop)}</small>
              </div>
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => act(loop, () => loopsApi.close(loop.id))}
                >{t('settings.loops.notNeeded')}</button
              >
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{t('settings.loops.empty')}</p>
    {/if}

    {#if closed.length}
      <details class="loops-closed">
        <summary>{t('settings.loops.recentlyClosed', { count: closed.length })}</summary>
        <ul class="loops-list" aria-label={t('settings.loops.recentlyClosedAria')}>
          {#each closed as loop (loop.id)}
            <li>
              <div class="loops-row">
                <div class="loops-text">
                  <span>{loop.what}</span>
                  <small>{closedDetail(loop)}</small>
                </div>
                <button
                  class="button ghost small"
                  type="button"
                  disabled={!!busy}
                  onclick={() => act(loop, () => loopsApi.reopen(loop.id))}
                  >{t('settings.loops.notDoneYet')}</button
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
  .loops-error {
    color: var(--danger);
  }
  .loops-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .loops-list > li {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .loops-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 12px;
  }
  .loops-text {
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
  .loops-next {
    color: var(--accent);
  }
  .loops-closed {
    margin-top: 10px;
  }
  .loops-closed summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
  }
</style>
