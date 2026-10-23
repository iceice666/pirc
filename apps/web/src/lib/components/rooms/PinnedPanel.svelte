<script lang="ts">
  /**
   * The room's pinned messages, in the column the header's Pinned button
   * opens (the design replaces the strip above the log).
   */
  import { Pin, X } from '@lucide/svelte';
  import { locale, t } from '../../i18n';
  import { speakerFace, type Face } from '../../faces';
  import type { RoomMessage } from '../../rooms';

  interface Props {
    pinned: RoomMessage[];
    faces: Face[];
    onjump: (messageId: string) => void;
    onclose: () => void;
  }

  let { pinned, faces, onjump, onclose }: Props = $props();

  function who(message: RoomMessage): string {
    if (message.speaker === 'user') return message.user ?? t('common.unknownUser');
    return speakerFace(faces, message.speaker)?.name ?? message.speaker.replace(/^face:/, '');
  }

  const time = (at: number) =>
    new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(at);
</script>

<aside class="panel" aria-label={t('rooms.pinned.title')}>
  <header>
    <h2 class="section-label">{t('rooms.pinned.title')}</h2>
    <button type="button" class="icon" aria-label={t('thread.close')} onclick={onclose}
      ><X size={16} /></button
    >
  </header>
  {#if !pinned.length}
    <p class="empty">{t('rooms.pinned.empty')}</p>
  {:else}
    <ul>
      {#each pinned as message (message.id)}
        <li>
          <button
            type="button"
            class="pin"
            aria-label={t('rooms.pinned.jump')}
            onclick={() => onjump(message.id)}
          >
            <span class="top"
              ><Pin size={14} aria-hidden="true" /><span>{who(message)}</span>
              <time datetime={new Date(message.createdAt).toISOString()}
                >{time(message.createdAt)}</time
              ></span
            >
            <span class="what">{message.body.text ?? t('rooms.pinned.attachment')}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 12px 8px 4px 16px;
  }
  h2 {
    flex: 1;
    margin: 0;
  }
  ul {
    margin: 0;
    padding: 4px 8px 16px;
    list-style: none;
    overflow-y: auto;
  }
  .pin {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    margin-bottom: 4px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .pin:hover {
    background: var(--bg-hover);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .top span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .what {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text-2);
    font-size: 13px;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .empty {
    margin: 8px 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .icon {
    display: grid;
    place-items: center;
    padding: 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
</style>
