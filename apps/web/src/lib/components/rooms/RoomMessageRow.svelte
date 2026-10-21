<script lang="ts">
  import { Paperclip, Pin } from '@lucide/svelte';
  import { ApiError } from '../../http';
  import { lineAction } from '../../loops';
  import { describeOrigin, forgetRemembered } from '../../memory';
  import { roomsApi, type RoomMessage } from '../../rooms';
  import { wakesApi } from '../../wakes';
  import {
    questionOutcome,
    statusLabel,
    stoppable,
    workersApi,
    type QuestionAnswer,
    type WorkerAnchor,
  } from '../../workers';

  interface Props {
    message: RoomMessage;
    /** The previous message: a run by the same speaker shows its header once. */
    previous?: RoomMessage;
    onopenroom?: (roomId: string) => void;
    onpin?: (message: RoomMessage, pinned: boolean) => void;
    /** Open a worker's thread (plan 06). */
    onopenthread?: (threadId: string) => void;
  }

  let { message, previous, onopenroom, onpin, onopenthread }: Props = $props();

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

  /** What the line remembered: shown on expanding it, undone by "Don't keep". */
  const remembered = $derived(message.body.memory?.forgotten ? undefined : message.body.memory);
  let expanded = $state(false);
  const detail = $derived.by(() => {
    if (!remembered) return '';
    const what =
      remembered.kind === 'preference'
        ? 'A preference: always on its mind.'
        : 'A fact: found again when it matters.';
    const whose = remembered.user ? ` · for ${remembered.user}` : '';
    return `${what} ${describeOrigin(remembered.origin ?? '')}${whose}.`;
  });
  let forgetting = $state(false);
  let forgetError = $state('');

  /** What happened to an open loop, undone from the line once. */
  const loopAction = $derived(message.body.loop ? lineAction(message.body.loop) : undefined);
  let loopDone = $state(false);

  async function undoLoop() {
    if (!loopAction || forgetting) return;
    forgetting = true;
    forgetError = '';
    try {
      // The gateway says what happened in the room.
      await loopAction.run();
      loopDone = true;
    } catch (cause) {
      forgetError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      forgetting = false;
    }
  }

  /** pirc said it would come back: Cancel calls it off, once. */
  const wakeLine = $derived(
    message.body.wake?.event === 'scheduled' ? message.body.wake : undefined,
  );
  let wakeDone = $state(false);

  async function cancelWake() {
    if (!wakeLine || forgetting) return;
    forgetting = true;
    forgetError = '';
    try {
      // The gateway says so in the room.
      await wakesApi.cancel(wakeLine.id);
      wakeDone = true;
    } catch (cause) {
      forgetError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      forgetting = false;
    }
  }

  /** A worker's anchor: its thread's latest worker, kept up to date. */
  const anchor = $derived(
    message.body.worker && 'title' in message.body.worker
      ? (message.body.worker as WorkerAnchor)
      : undefined,
  );
  /** A line or report about a worker: it opens the thread. */
  const workerThread = $derived(message.threadId ?? message.body.worker?.threadId ?? undefined);

  /** A worker's red line, asked here (plan 07). */
  const question = $derived(message.kind === 'question' ? message.body.question : undefined);
  let answering = $state(false);
  let answerError = $state('');

  async function answerQuestion(given: QuestionAnswer) {
    if (!question || !workerThread || answering) return;
    answering = true;
    answerError = '';
    try {
      // The room's stream brings the settled question.
      await workersApi.answer(workerThread, question.interactionId, given);
    } catch (cause) {
      answerError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      answering = false;
    }
  }

  async function stopWorker() {
    if (!anchor || forgetting) return;
    forgetting = true;
    forgetError = '';
    try {
      // The anchor and the room say how it ended.
      await workersApi.stop(anchor.delegationId);
    } catch (cause) {
      forgetError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      forgetting = false;
    }
  }

  async function dontKeep() {
    if (!remembered || forgetting) return;
    forgetting = true;
    forgetError = '';
    try {
      // The gateway rewrites the line; the room's stream brings it.
      await forgetRemembered(remembered);
    } catch (cause) {
      forgetError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
    } finally {
      forgetting = false;
    }
  }
</script>

{#if message.kind === 'line'}
  <div class="line" role="note">
    {#if message.body.move}
      <button type="button" class="link" onclick={() => onopenroom?.(message.body.move!.roomId)}
        >{message.body.text ?? ''}</button
      >
    {:else if remembered}
      <button
        type="button"
        class="link quiet"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}>{message.body.text ?? ''}</button
      >
      <button type="button" class="link" disabled={forgetting} onclick={dontKeep}>Don't keep</button
      >
    {:else if wakeLine}
      <span>{message.body.text ?? ''}</span>
      {#if !wakeDone}
        <button type="button" class="link" disabled={forgetting} onclick={cancelWake}>Cancel</button
        >
      {/if}
    {:else if message.body.worker && workerThread}
      <span>{message.body.text ?? ''}</span>
      <button type="button" class="link" onclick={() => onopenthread?.(workerThread)}
        >Open the thread</button
      >
    {:else if loopAction}
      <span>{message.body.text ?? ''}</span>
      {#if !loopDone}
        <button type="button" class="link" disabled={forgetting} onclick={undoLoop}
          >{loopAction.label}</button
        >
      {/if}
    {:else}
      <span>{message.body.text ?? ''}</span>
    {/if}
    <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
  </div>
  {#if remembered && expanded}
    <div class="line detail">{detail}</div>
  {/if}
  {#if forgetError}<div class="line error" role="alert">{forgetError}</div>{/if}
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
      {#if question}
        {#if question.status === 'pending'}
          <div class="choices">
            <button
              type="button"
              class="button dark small"
              disabled={answering}
              onclick={() => answerQuestion({ confirmed: true })}>Yes</button
            >
            {#if question.request.allowAgain}
              <button
                type="button"
                class="button ghost small"
                disabled={answering}
                title="The same action, in the same place, runs without asking for the rest of the worker's session"
                onclick={() => answerQuestion({ confirmed: true, again: true })}
                >Allow again this session</button
              >
            {/if}
            <button
              type="button"
              class="button ghost small"
              disabled={answering}
              onclick={() => answerQuestion({ confirmed: false })}>No</button
            >
            {#if workerThread}
              <button type="button" class="link" onclick={() => onopenthread?.(workerThread)}
                >Thread</button
              >
            {/if}
          </div>
        {:else}
          <p class="muted small">{questionOutcome(question)}</p>
        {/if}
        {#if answerError}<p class="worker-error" role="alert">{answerError}</p>{/if}
      {/if}
      {#if anchor}
        <div class="worker {anchor.status}">
          <span class="dot" aria-hidden="true"></span>
          <span>{statusLabel(anchor.status, anchor.workers)}</span>
          {#if anchor.note}<span class="muted">· waits for {anchor.note}</span>{/if}
          <button type="button" class="link" onclick={() => onopenthread?.(anchor.threadId)}
            >Thread</button
          >
          {#if stoppable(anchor.status)}
            <button type="button" class="link" disabled={forgetting} onclick={stopWorker}
              >Stop</button
            >
          {/if}
        </div>
        {#if forgetError}<p class="worker-error" role="alert">{forgetError}</p>{/if}
      {:else if message.body.worker && 'report' in message.body.worker && workerThread}
        <button type="button" class="link small" onclick={() => onopenthread?.(workerThread)}
          >Open the thread</button
        >
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
  .choices {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .muted.small {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
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
  .link.quiet {
    color: inherit;
    text-align: left;
  }
  .line.detail {
    padding-top: 0;
    font-size: 12px;
  }
  .line.error {
    color: var(--danger);
  }
  .worker {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    padding: 2px 10px;
    border: 1px solid var(--line-dark);
    border-radius: 999px;
    font-size: 12px;
  }
  .worker .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .worker.running .dot,
  .worker.waiting_input .dot {
    background: var(--accent);
  }
  .worker.completed .dot {
    background: var(--success, #2e9d5b);
  }
  .worker.failed .dot {
    background: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 12px;
  }
  .worker-error {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--danger);
  }
</style>
