<script lang="ts">
  /**
   * The dashboard's Open loops card (design screen 5): how many loops are in
   * the prompt, the first few of them with what they are, where they came from
   * and the room they belong to, and a way into the full list. Closing and
   * reopening stay in the Open loops section, so this card only reads.
   */
  import { ApiError } from '../../http';
  import { t } from '../../i18n';
  import { describeAnchor, loopsApi, type OpenLoop } from '../../loops';

  interface Props {
    /** Room names by id; a room not in it shows its id. */
    roomNames: Record<string, string>;
    disabled?: boolean;
    /** Bumped when a loop changed elsewhere: reload. */
    revision?: number;
    /** The "All loops" link: the Open loops section's anchor, handled by the page. */
    onall: (event: MouseEvent) => void;
  }

  let { roomNames, disabled = false, revision = 0, onall }: Props = $props();

  /** Items shown before "All loops". */
  const SHOWN = 4;

  let loops = $state<OpenLoop[]>([]);
  let limit = $state(40);
  let loading = $state(true);
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
      const page = await loopsApi.list('open');
      loops = page.loops ?? [];
      limit = page.limit ?? limit;
      error = '';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
    } finally {
      loading = false;
    }
  }

  const detail = (loop: OpenLoop) =>
    [
      describeAnchor(loop) || t('engine.loops.noAnchor'),
      loop.roomId ? `#${roomNames[loop.roomId] ?? loop.roomId}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<section class="card" aria-labelledby="loops-card-title">
  <div class="card-head">
    <h2 id="loops-card-title" class="section-label">{t('engine.section.loops')}</h2>
    <span class="count">{t('engine.loops.inPrompt', { count: loops.length, limit })}</span>
  </div>
  {#if disabled}
    <p class="muted">{t('engine.demoUnavailable')}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if loading && !loops.length}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else if !loops.length}
    <p class="muted">{t('engine.loops.empty')}</p>
  {:else}
    <ul class="items">
      {#each loops.slice(0, SHOWN) as loop (loop.id)}
        <li>
          <span class="what">{loop.what}</span>
          <span class="meta">
            {detail(loop)}
            <code class="origin">{loop.origin}</code>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <a class="all" href="#loops" onclick={onall}>{t('engine.loops.all')}</a>
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
    color: var(--faint);
    font-size: 12px;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .items li {
    display: flex;
    flex-direction: column;
  }
  .what {
    color: var(--ink);
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    color: var(--faint);
    font-size: 12px;
  }
  .origin {
    padding: 0 5px;
    border-radius: 4px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .all {
    margin-top: auto;
    padding-top: 4px;
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
</style>
