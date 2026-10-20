<script lang="ts">
  import { Paperclip, Pin } from '@lucide/svelte';
  import { roomsApi, type RoomMessage } from '../../rooms';

  interface Props {
    message: RoomMessage;
    /** The previous message: a run by the same speaker shows its header once. */
    previous?: RoomMessage;
    onopenroom?: (roomId: string) => void;
    onpin?: (message: RoomMessage, pinned: boolean) => void;
  }

  let { message, previous, onopenroom, onpin }: Props = $props();

  /** Faces by id until plan 10 lists them: only the host exists. */
  const FACES: Record<string, string> = { host: 'pirc' };

  const name = $derived(
    message.speaker === 'user'
      ? (message.user ?? 'someone')
      : (FACES[message.speaker.replace(/^face:/, '')] ?? message.speaker.replace(/^face:/, '')),
  );
  const isFace = $derived(message.speaker !== 'user');
  const sameRun = $derived(
    !!previous &&
      previous.kind !== 'line' &&
      message.kind !== 'question' &&
      previous.speaker === message.speaker &&
      previous.user === message.user &&
      message.createdAt - previous.createdAt < 5 * 60_000,
  );
  const time = $derived(
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
      message.createdAt,
    ),
  );
  const fullTime = $derived(new Date(message.createdAt).toLocaleString());
  /** A stable hue per speaker. */
  const hue = $derived([...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7));
  const initial = $derived([...name][0]?.toUpperCase() ?? '?');
</script>

{#if message.kind === 'line'}
  <div class="line" role="note">
    {#if message.body.move}
      <button type="button" class="link" onclick={() => onopenroom?.(message.body.move!.roomId)}
        >{message.body.text ?? ''}</button
      >
    {:else}
      <span>{message.body.text ?? ''}</span>
    {/if}
    <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
  </div>
{:else}
  <article
    class="message"
    class:continued={sameRun}
    class:question={message.kind === 'question'}
    aria-label="{name}{message.kind === 'question' ? ' asks' : ''}, {fullTime}"
    aria-busy={message.body.streaming ? 'true' : undefined}
  >
    <div class="gutter">
      {#if sameRun}
        <time
          class="hover-time"
          datetime={new Date(message.createdAt).toISOString()}
          title={fullTime}>{time}</time
        >
      {:else}
        <span class="avatar" class:face={isFace} style:--hue={hue} aria-hidden="true"
          >{initial}</span
        >
      {/if}
    </div>
    <div class="content">
      {#if !sameRun}
        <header>
          <span class="name">{name}</span>
          <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
          {#if message.kind === 'question'}<span class="asks">asks you</span>{/if}
          {#if message.pinnedAt}<Pin size={12} aria-label="Pinned" />{/if}
        </header>
      {/if}
      {#if message.body.text || message.body.streaming}
        <p class="text">
          {message.body.text ?? ''}{#if message.body.streaming}<span
              class="caret"
              aria-hidden="true">▍</span
            >{/if}
        </p>
      {/if}
      {#each message.body.attachments ?? [] as attachment (attachment.id)}
        {#if attachment.kind === 'image'}
          <a
            href={roomsApi.uploadUrl(message.roomId, attachment.id)}
            target="_blank"
            rel="noopener"
          >
            <img
              class="image"
              src={roomsApi.uploadUrl(message.roomId, attachment.id)}
              alt="Attachment from {name}"
              loading="lazy"
            />
          </a>
        {:else}
          <a class="file" href={roomsApi.uploadUrl(message.roomId, attachment.id)} download
            ><Paperclip size={14} />{attachment.filename ?? 'file'}</a
          >
        {/if}
      {/each}
    </div>
    {#if onpin}
      <button
        type="button"
        class="pin"
        aria-label={message.pinnedAt ? 'Unpin' : 'Pin'}
        title={message.pinnedAt ? 'Unpin' : 'Pin'}
        onclick={() => onpin(message, !message.pinnedAt)}><Pin size={14} /></button
      >
    {/if}
  </article>
{/if}

<style>
  .message {
    position: relative;
    display: grid;
    grid-template-columns: 40px 1fr;
    gap: 12px;
    padding: 6px 20px 2px;
  }
  .message.continued {
    padding-top: 0;
  }
  .message.question .content {
    padding: 6px 10px;
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-layer);
  }
  .asks {
    font-size: 12px;
    color: var(--accent);
  }
  .caret {
    color: var(--muted);
    animation: blink 1s steps(1) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
  .message:hover {
    background: var(--bg-hover);
  }
  .gutter {
    display: flex;
    justify-content: center;
  }
  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 600;
    color: white;
    background: hsl(var(--hue) 45% 48%);
  }
  .avatar.face {
    background: var(--accent);
  }
  .hover-time {
    visibility: hidden;
    padding-top: 3px;
    font-size: 11px;
    color: var(--muted);
  }
  .message:hover .hover-time {
    visibility: visible;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .name {
    font-weight: 600;
  }
  time {
    font-size: 12px;
    color: var(--muted);
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .image {
    display: block;
    max-width: min(360px, 100%);
    max-height: 280px;
    margin-top: 6px;
    border-radius: var(--radius-sm);
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 6px 10px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    color: var(--ink);
    text-decoration: none;
  }
  .pin {
    position: absolute;
    top: 4px;
    right: 16px;
    display: none;
    padding: 4px;
    border: 0;
    border-radius: 6px;
    background: var(--bg-layer);
    color: var(--muted);
    cursor: pointer;
  }
  .message:hover .pin,
  .pin:focus-visible {
    display: block;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 20px 4px 72px;
    font-size: 13px;
    color: var(--muted);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
</style>
