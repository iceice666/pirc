<script lang="ts">
  /**
   * The session page's waiting band (design screen 6): a worker that is asking
   * you something waits in its room, so the band says which room and links
   * there — the same place its question and thread are.
   *
   * A session knows the room a delegation was called in (`origin.roomId`); the
   * room's name comes from the rooms API. What it is asking for is not in the
   * engine's data (a session carries its run's state, not the question's
   * text), so the band stops at the room instead of inventing a request.
   */
  import { t } from '../../i18n';
  import { roomsApi } from '../../rooms';

  interface Props {
    /** The room the worker was called in. */
    roomId: string;
  }

  let { roomId }: Props = $props();

  /** Room names by id, asked once for the whole app. */
  let names = $state<Record<string, string>>({});

  $effect(() => {
    const id = roomId;
    void id;
    roomsApi
      .list(true)
      .then(({ rooms }) => {
        names = Object.fromEntries(rooms.map((room) => [room.id, room.name]));
      })
      .catch(() => {});
  });

  const name = $derived(names[roomId]);
</script>

{#if name}
  <div class="waiting-band" role="status">
    <span class="mark" aria-hidden="true"></span>
    <span class="text">{t('engine.waiting.in', { room: `# ${name}` })}</span>
    <a href="/?room={encodeURIComponent(roomId)}">{t('engine.waiting.answer')}</a>
  </div>
{/if}

<style>
  .waiting-band {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    background: var(--warning-soft);
    color: color-mix(in srgb, var(--warning) 60%, var(--ink));
    font-size: 13px;
  }
  .mark {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--warning);
  }
  .text {
    min-width: 0;
    flex: 1 1 260px;
  }
  a {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
  }
</style>
