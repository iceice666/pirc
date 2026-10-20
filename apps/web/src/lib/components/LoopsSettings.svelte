<script lang="ts">
  /**
   * Open loops (plans/rewrite/04-open-loops.md): what is still open between pirc and
   * you, always on its mind until closed. Settings holds the list until the faces'
   * pages do (plan 10).
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { describeAnchor, describeClosed, loopsApi, type OpenLoop } from '../loops';
  import { describeOrigin } from '../memory';
  import { rooms } from '../rooms.svelte';
  import { ago } from '../time';
  import { watch } from '../watch.svelte';

  interface Props {
    disabled?: boolean;
  }

  let { disabled = false }: Props = $props();

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
      loop.nextCheck ? `next check: ${loop.nextCheck}` : '',
      ago(loop.lastTouchedAt),
    ]
      .filter(Boolean)
      .join(' · ');
  const closedDetail = (loop: OpenLoop) =>
    [
      loop.closedReason ? `Closed: ${describeClosed(loop.closedReason)}` : 'Closed',
      loop.closedAt ? ago(loop.closedAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

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
    () => rooms.loopsRevision,
    () => {
      if (!disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="loops-title">
  <h3 id="loops-title">Open loops</h3>
  <p>
    What is still open between pirc and you: always on its mind until it is resolved. pirc opens and
    closes them on its own and says so in the room. Past {limit}, the ones without a time that
    nobody mentioned for the longest go to memory as facts.
  </p>

  {#if disabled}
    <p role="status">Open loops are unavailable in demo mode.</p>
  {:else if loading}
    <p role="status">Loading open loops…</p>
  {:else}
    {#if error}<p class="loops-error" role="alert">{error}</p>{/if}
    {#if open.length}
      <ul class="loops-list" aria-label="Open loops">
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
                onclick={() => act(loop, () => loopsApi.close(loop.id))}>Not needed</button
              >
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>Nothing open. Ask pirc to remind you of something, or tell it what is still unresolved.</p>
    {/if}

    {#if closed.length}
      <details class="loops-closed">
        <summary>Recently closed · {closed.length}</summary>
        <ul class="loops-list" aria-label="Recently closed">
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
                  onclick={() => act(loop, () => loopsApi.reopen(loop.id))}>Not done yet</button
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
