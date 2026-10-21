<script lang="ts">
  /** A room's latest brain turns: when, why, how it ended and what it cost (plan 02). */
  import { brainApi, tokens, turnOutcome, type BrainTurn } from '../../brain';
  import { ApiError } from '../../http';
  import { duration } from '../../time';

  interface Props {
    roomNames: Record<string, string>;
    /** The rooms to choose from, the list's order. */
    roomIds: string[];
    disabled?: boolean;
  }

  let { roomNames, roomIds, disabled = false }: Props = $props();

  let roomId = $state('general');
  let turns = $state<BrainTurn[]>([]);
  let loading = $state(false);
  let error = $state('');

  const choices = $derived(roomIds.includes('general') ? roomIds : ['general', ...roomIds]);

  async function load(id: string) {
    loading = true;
    error = '';
    try {
      const page = await brainApi.turns(id);
      if (id === roomId) turns = page.turns;
    } catch (cause) {
      if (id !== roomId) return;
      turns = [];
      error = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      if (id === roomId) loading = false;
    }
  }

  $effect(() => {
    if (!disabled) void load(roomId);
  });

  const at = (time: number) =>
    new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(time);
</script>

<section class="settings-section" aria-labelledby="brain-title">
  <h3 id="brain-title">Brain turns</h3>
  <label class="room">
    Room
    <select bind:value={roomId}>
      {#each choices as id (id)}
        <option value={id}>#{roomNames[id] ?? id}</option>
      {/each}
    </select>
  </label>
  {#if disabled}
    <p class="muted">Not available in demo mode.</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if loading && !turns.length}
    <p class="muted" role="status">Loading…</p>
  {:else if !turns.length}
    <p class="muted">No turns in this room yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Started</th><th>Why</th><th>Outcome</th><th>Took</th><th>Used</th></tr>
      </thead>
      <tbody>
        {#each turns as turn (turn.id)}
          <tr class:failed={!!turn.error || turn.outcome === 'failed'}>
            <td>{at(turn.startedAt)}</td>
            <td
              >{turn.kind === 'wake'
                ? 'Came back on its own'
                : `${turn.messageIds.length} message${turn.messageIds.length === 1 ? '' : 's'}`}</td
            >
            <td>
              {turnOutcome(turn)}
              {#if turn.error}<small class="error">{turn.error}</small>{/if}
            </td>
            <td>{turn.endedAt ? duration(turn.startedAt, turn.endedAt) : '…'}</td>
            <td>{turn.usage ? tokens(turn.usage.totalTokens) : ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .room {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  select {
    padding: 4px 6px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 500;
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
