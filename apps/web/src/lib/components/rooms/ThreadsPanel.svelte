<script lang="ts">
  /**
   * The room's threads, from the anchors already in its log: a worker handed
   * work here has a thread, and this lists them newest first (the design's
   * Threads button opens this column instead of a strip above the log).
   */
  import { MessageSquare, X } from '@lucide/svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';
  import { locale, t } from '../../i18n';
  import type { ThreadActivity } from '../../room-events';
  import type { RoomMessage } from '../../rooms';
  import { statusLabel, type WorkerAnchor } from '../../workers';

  interface Props {
    messages: RoomMessage[];
    activity: Record<string, ThreadActivity>;
    onopen: (threadId: string) => void;
    onclose: () => void;
  }

  let { messages, activity, onopen, onclose }: Props = $props();

  /** One card per thread: its newest anchor says where it stands. */
  const threads = $derived.by(() => {
    const seen = new Map<string, WorkerAnchor>();
    for (const message of [...messages].reverse()) {
      const worker = message.body.worker;
      if (worker && 'title' in worker && !seen.has(worker.threadId))
        seen.set(worker.threadId, worker);
    }
    return [...seen.values()];
  });

  const time = (at: number) =>
    new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(at);
</script>

<aside class="panel" aria-label={t('rooms.threads.title')}>
  <header>
    <h2 class="section-label">{t('rooms.threads.title')}</h2>
    <button type="button" class="icon" aria-label={t('thread.close')} onclick={onclose}
      ><X size={16} /></button
    >
  </header>
  {#if !threads.length}
    <p class="empty">{t('rooms.threads.empty')}</p>
  {:else}
    <ul>
      {#each threads as thread (thread.threadId)}
        {@const last = activity[thread.threadId]}
        <li>
          <button type="button" class="thread" onclick={() => onopen(thread.threadId)}>
            <span class="top">
              <MessageSquare size={16} aria-hidden="true" />
              <strong>{thread.title}</strong>
              <span class="status"
                ><StatusGlyph state={glyphOf(thread.status)} />{statusLabel(
                  thread.status,
                  thread.workers,
                )}</span
              >
            </span>
            <span class="last" title={last?.text}
              >{last?.text ?? t('rooms.threads.quiet')}{#if last}
                <span class="at">· {time(last.at)}</span>{/if}</span
            >
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
  .thread {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .thread:hover {
    background: var(--bg-hover);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--ink);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
  }
  .last {
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .at {
    color: var(--faint);
    font-size: 12px;
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
