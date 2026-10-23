<script lang="ts">
  /**
   * The dashboard's Brain section (design screen 5): the newest turns across
   * every room, one row each, with the room it happened in and the note that
   * only one turn runs at a time. A turn belongs to a room, so this asks each
   * room for its latest few and merges them; the Brain section below lists one
   * room's turns in full.
   */
  import { brainApi, tokens, turnOutcome, type BrainTurn } from '../../brain';
  import { ApiError } from '../../http';
  import { locale, t } from '../../i18n';
  import { duration } from '../../time';

  interface Props {
    roomNames: Record<string, string>;
    /** The rooms to read, in the list's order. */
    roomIds: string[];
    /** Rows shown. */
    limit?: number;
    disabled?: boolean;
    /** The "All turns" link: the Brain section's anchor, handled by the page. */
    onall: (event: MouseEvent) => void;
  }

  let { roomNames, roomIds, limit = 5, disabled = false, onall }: Props = $props();

  let turns = $state<BrainTurn[]>([]);
  let loading = $state(true);
  let error = $state('');

  /** A few per room, so one busy room cannot fill the whole table. */
  const PER_ROOM = 4;

  async function load(ids: string[]) {
    loading = true;
    error = '';
    try {
      const pages = await Promise.all(
        ids.map((id) => brainApi.turns(id, PER_ROOM).then((page) => page.turns ?? [])),
      );
      turns = pages
        .flat()
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit);
    } catch (cause) {
      turns = [];
      error = cause instanceof ApiError ? cause.message : t('engine.error.gateway');
    } finally {
      loading = false;
    }
  }

  // The rooms arrive once the page has them; a demo has nothing to ask.
  let asked = $state<string[]>();
  $effect(() => {
    if (disabled || !roomIds.length || asked === roomIds) return;
    asked = roomIds;
    void load(roomIds);
  });

  const time = (at: number) => {
    const when = new Date(at);
    const today = new Date();
    const sameDay =
      when.getFullYear() === today.getFullYear() &&
      when.getMonth() === today.getMonth() &&
      when.getDate() === today.getDate();
    return new Intl.DateTimeFormat(
      locale(),
      sameDay
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    ).format(at);
  };
  const why = (turn: BrainTurn) =>
    turn.kind === 'wake'
      ? t('engine.brain.kindWake')
      : turn.kind === 'report'
        ? t('engine.brain.kindReport')
        : t(turn.messageIds.length === 1 ? 'engine.brain.message' : 'engine.brain.messages', {
            count: turn.messageIds.length,
          });
</script>

<section class="turns" aria-labelledby="turns-title">
  <div class="block-head">
    <h2 id="turns-title" class="section-label">{t('engine.brain.title')}</h2>
    <span class="note">{t('engine.brain.note')}</span>
    <a class="all" href="#brain" onclick={onall}>{t('engine.brain.all')}</a>
  </div>
  {#if disabled}
    <p class="muted">{t('engine.demoUnavailable')}</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if loading && !turns.length}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else if !turns.length}
    <p class="muted">{t('engine.brain.empty')}</p>
  {:else}
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>{t('engine.brain.started')}</th>
            <th>{t('engine.brain.room')}</th>
            <th>{t('engine.brain.why')}</th>
            <th>{t('engine.brain.outcome')}</th>
            <th class="number">{t('engine.brain.took')}</th>
            <th class="number">{t('engine.brain.used')}</th>
          </tr>
        </thead>
        <tbody>
          {#each turns as turn (turn.id)}
            <tr class:failed={!!turn.error || turn.outcome === 'failed'}>
              <td class="faint">{time(turn.startedAt)}</td>
              <td class="room">#{roomNames[turn.roomId] ?? turn.roomId}</td>
              <td>{why(turn)}</td>
              <td>
                {turnOutcome(turn)}
                {#if turn.error}<small class="error">{turn.error}</small>{/if}
              </td>
              <td class="faint number"
                >{turn.endedAt ? duration(turn.startedAt, turn.endedAt) : '…'}</td
              >
              <td class="faint number">{turn.usage ? tokens(turn.usage.totalTokens) : ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .turns {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .block-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .block-head h2 {
    margin: 0;
  }
  .note {
    color: var(--faint);
    font-size: 12px;
  }
  .all {
    margin-left: auto;
    font-size: 13px;
  }
  .table-card {
    overflow-x: auto;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  table {
    width: 100%;
    min-width: 640px;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    padding: 10px 8px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
  }
  th:first-child,
  td:first-child {
    padding-left: 16px;
  }
  th:last-child,
  td:last-child {
    padding-right: 16px;
  }
  td {
    padding: 10px 8px;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }
  td.room {
    color: var(--ink);
  }
  td.faint {
    color: var(--muted);
  }
  .number {
    text-align: right;
  }
  small {
    display: block;
  }
  .error {
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
</style>
