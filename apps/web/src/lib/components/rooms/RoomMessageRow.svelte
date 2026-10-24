<script lang="ts">
  import {
    AlarmClock,
    ArrowRightLeft,
    Bookmark,
    FileText,
    MessageSquare,
    Pin,
    Repeat,
    ShieldCheck,
    Wrench,
  } from '@lucide/svelte';
  import { hueOf, initialOf, mentionParts, speakerFace, type Face } from '../../faces';
  import { ApiError } from '../../http';
  import { locale, t } from '../../i18n';
  import { lineAction } from '../../loops';
  import { describeOrigin, forgetRemembered } from '../../memory';
  import type { ThreadActivity } from '../../room-events';
  import { roomsApi, type QuotedMessage, type RoomMessage } from '../../rooms';
  import { engineLink, type OverviewSection } from '../../routes';
  import { wakesApi } from '../../wakes';
  import {
    questionOutcome,
    statusLabel,
    stoppable,
    workersApi,
    type QuestionAnswer,
    type WorkerAnchor,
  } from '../../workers';
  import Markdown from '../Markdown.svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';

  interface Props {
    message: RoomMessage;
    /** The previous message: a run by the same speaker shows its header once. */
    previous?: RoomMessage;
    onopenroom?: (roomId: string) => void;
    onpin?: (message: RoomMessage, pinned: boolean) => void;
    /** Open a worker's thread (plan 06). */
    onopenthread?: (threadId: string) => void;
    /** The faces (plan 10): who a face's message is from, and how it looks. */
    faces?: Face[];
    /** Open a face's page. */
    onopenface?: (faceId: string) => void;
    /** What each thread's workers did last: a working anchor's progress. */
    activity?: Record<string, ThreadActivity>;
    /** This message's thread is the one open beside the room. */
    selected?: boolean;
  }

  let {
    message,
    previous,
    onopenroom,
    onpin,
    onopenthread,
    faces = [],
    onopenface,
    activity = {},
    selected = false,
  }: Props = $props();

  const face = $derived(speakerFace(faces, message.speaker));
  const name = $derived(
    message.speaker === 'user'
      ? (message.user ?? t('common.unknownUser'))
      : (face?.name ??
          (message.speaker === 'face:host' ? 'pirc' : message.speaker.replace(/^face:/, ''))),
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
    new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(
      message.createdAt,
    ),
  );
  const fullTime = $derived(new Date(message.createdAt).toLocaleString(locale()));
  /** A stable hue per speaker; a face may have its own color and avatar. */
  const hue = $derived(hueOf(name));
  const initial = $derived(initialOf(name, face?.avatar));

  /** Its name in its own color, or the hue its avatar would have. */
  function faceColor(who: Face | undefined, fallbackName: string): string {
    return who?.color ?? `hsl(${hueOf(who?.name ?? fallbackName)} 55% 62%)`;
  }

  /** What the line remembered: shown on expanding it, undone by "Don't keep". */
  const remembered = $derived(message.body.memory?.forgotten ? undefined : message.body.memory);
  let expanded = $state(false);
  const detail = $derived.by(() => {
    if (!remembered) return '';
    const what =
      remembered.kind === 'preference' ? t('rooms.memory.preference') : t('rooms.memory.fact');
    const whose = remembered.user
      ? ` · ${t('rooms.memory.forUser', { user: remembered.user })}`
      : '';
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
      forgetError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
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
      forgetError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
    } finally {
      forgetting = false;
    }
  }

  /** Where the engine shows what the line is about. */
  const details = $derived<OverviewSection | undefined>(
    message.body.memory
      ? 'memory'
      : message.body.loop
        ? 'loops'
        : message.body.wake
          ? 'wakes'
          : undefined,
  );

  /** A worker's anchor: its thread's latest worker, kept up to date. */
  const anchor = $derived(
    message.body.worker && 'title' in message.body.worker
      ? (message.body.worker as WorkerAnchor)
      : undefined,
  );
  /** While it works: what it did last, updated in place. */
  const progress = $derived(
    anchor && (anchor.status === 'running' || anchor.status === 'waiting_input')
      ? activity[anchor.threadId]
      : undefined,
  );
  /** What its thread last did, whatever its status (the preview card's second line). */
  const lastWord = $derived(anchor ? activity[anchor.threadId] : undefined);
  /** A line or report about a worker: it opens the thread. */
  const workerThread = $derived(message.threadId ?? message.body.worker?.threadId ?? undefined);

  /**
   * A move brought this room the conversation (POST /api/rooms/:id/move with
   * a topic): its messages are quoted here, and the gateway's sentence under
   * them ("Copied N messages…") is left to clients that cannot draw it.
   */
  const quote = $derived(message.body.quote);
  /** Who said a quoted message: a face keeps its own name and colour. */
  const quotedName = (item: QuotedMessage) =>
    item.speaker === 'user'
      ? (item.user ?? t('common.unknownUser'))
      : (speakerFace(faces, item.speaker)?.name ?? item.speaker.replace(/^face:/, ''));
  const quotedColor = (item: QuotedMessage) =>
    faceColor(speakerFace(faces, item.speaker), quotedName(item));
  /** When it was said, where: a copy is read later than it was written. */
  const quotedTime = (item: QuotedMessage) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(item.at);
  const quotedFullTime = (item: QuotedMessage) =>
    new Date(item.at).toLocaleString(locale(), { dateStyle: 'full', timeStyle: 'long' });
  /** The files a quoted message carried: their names, not the files. */
  const quotedFiles = (item: QuotedMessage) =>
    (item.attachments ?? []).map((file) => file.filename ?? t('rooms.attachment.file')).join(', ');

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
      answerError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
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
      forgetError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
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
      forgetError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
    } finally {
      forgetting = false;
    }
  }
</script>

{#snippet said(text: string)}
  {#each mentionParts(text, faces) as part, index (index)}
    {#if part.face}<span
        class="mention"
        style:color={faceColor(part.face, part.face.name)}
        style:background="color-mix(in srgb, {faceColor(part.face, part.face.name)} 18%, transparent)"
        >{part.text}</span
      >{:else}{part.text}{/if}
  {/each}
{/snippet}

{#snippet badge(who: Face | undefined)}
  {#if who}
    {@const color = faceColor(who, who.name)}
    <span
      class="face-badge"
      style:color
      style:background="color-mix(in srgb, {color} 15%, transparent)"
      >{who.isHost ? t('common.host') : t('rooms.message.project')}</span
    >
  {/if}
{/snippet}

{#if message.kind === 'progress'}
  <div class="line progress-line" role="status" aria-busy="true" data-row tabindex="-1">
    <span class="spinner" aria-hidden="true"></span>
    <span>{message.body.text ?? ''}</span>
    <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
  </div>
{:else if message.kind === 'line'}
  <div class="line" role="note" data-row tabindex="-1">
    <span class="line-icon" aria-hidden="true">
      {#if message.body.move}<ArrowRightLeft size={14} />
      {:else if message.body.memory}<Bookmark size={14} />
      {:else if message.body.wake}<AlarmClock size={14} />
      {:else if message.body.worker}<Wrench size={14} />
      {:else if message.body.loop}<Repeat size={14} />
      {:else}<MessageSquare size={14} />{/if}
    </span>
    {#if message.body.move}
      <button type="button" class="action" onclick={() => onopenroom?.(message.body.move!.roomId)}
        >{message.body.text ?? ''}</button
      >
    {:else if remembered}
      <button
        type="button"
        class="action quiet"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}>{message.body.text ?? ''}</button
      >
      <button type="button" class="action" disabled={forgetting} onclick={dontKeep}
        >{t('rooms.memory.dontKeep')}</button
      >
    {:else if wakeLine}
      <span>{message.body.text ?? ''}</span>
      {#if !wakeDone}
        <button type="button" class="action" disabled={forgetting} onclick={cancelWake}
          >{t('common.cancel')}</button
        >
      {/if}
    {:else if message.body.worker && workerThread}
      <span>{message.body.text ?? ''}</span>
      <button type="button" class="action" onclick={() => onopenthread?.(workerThread)}
        >{t('rooms.worker.openThread')}</button
      >
    {:else if loopAction}
      <span>{message.body.text ?? ''}</span>
      {#if !loopDone}
        <button type="button" class="action" disabled={forgetting} onclick={undoLoop}
          >{loopAction.label}</button
        >
      {/if}
    {:else}
      <span>{@render said(message.body.text ?? '')}</span>
    {/if}
    {#if details}
      <a class="action quiet" href={engineLink(details)} title={t('rooms.details.title')}
        >{t('rooms.details.label')}</a
      >
    {/if}
    <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
  </div>
  {#if remembered && expanded}
    <div class="line detail">{detail}</div>
  {/if}
  {#if forgetError}<div class="line error" role="alert">{forgetError}</div>{/if}
{:else}
  <article
    id="message-{message.id}"
    data-row
    tabindex="-1"
    class="message"
    class:continued={sameRun}
    class:question={message.kind === 'question'}
    class:selected
    aria-label="{message.kind === 'question'
      ? t('rooms.message.asks', { name })
      : name}, {fullTime}"
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
        <span
          class="avatar"
          class:face={isFace && !face?.color && (face?.isHost ?? true)}
          style:--hue={hue}
          style:background={face?.color ?? undefined}
          aria-hidden="true">{initial}</span
        >
      {/if}
    </div>
    <div class="content">
      {#if !sameRun}
        <header>
          {#if face && onopenface}
            <button
              type="button"
              class="name face-name"
              style:color={faceColor(face, name)}
              onclick={() => onopenface(face.id)}>{name}</button
            >
          {:else}
            <span class="name">{name}</span>
          {/if}
          {@render badge(isFace ? face : undefined)}
          <time datetime={new Date(message.createdAt).toISOString()} title={fullTime}>{time}</time>
          {#if message.kind === 'question'}
            <span class="asks"
              ><ShieldCheck size={12} aria-hidden="true" />{t('rooms.message.asksYou')}</span
            >
          {/if}
          {#if message.pinnedAt}<Pin size={12} aria-label={t('common.pinned')} />{/if}
        </header>
      {/if}
      {#if (message.body.text || message.body.streaming) && !quote}
        {#if isFace}
          <!-- What pirc and its workers write is Markdown: code, lists, tables.
               Nothing here is a Files pane, so a workspace path shows as code
               instead of a link that would go nowhere. -->
          <Markdown
            source={message.body.text ?? ''}
            streaming={!!message.body.streaming}
            fileLinks={false}
          />
        {:else}
          <!-- Your own words stay as typed, as in the old transcript. -->
          <p class="text">
            {@render said(message.body.text ?? '')}{#if message.body.streaming}<span
                class="caret"
                aria-hidden="true">▍</span
              >{/if}
          </p>
        {/if}
      {/if}
      {#if quote}
        <!-- What the move brought along: the old room's words, quoted, each
             with who said it and when; the files keep only their names. -->
        <figure class="quote" aria-label={t('rooms.quote.label', { room: quote.from.name })}>
          <figcaption>
            <ArrowRightLeft size={14} aria-hidden="true" />
            <span
              >{t('rooms.quote.count', {
                count: quote.messages.length,
                topic: quote.topic,
              })}</span
            >
            <button type="button" class="open" onclick={() => onopenroom?.(quote.from.id)}
              >{t('rooms.quote.open', { room: quote.from.name })}</button
            >
          </figcaption>
          <ol class="copied">
            {#each quote.messages as item (item.id)}
              <li data-quoted={item.id}>
                <div class="who">
                  <span class="name" style:color={quotedColor(item)}>{quotedName(item)}</span>
                  <time datetime={new Date(item.at).toISOString()} title={quotedFullTime(item)}
                    >{quotedTime(item)}</time
                  >
                </div>
                {#if item.speaker === 'user'}
                  <p class="text">{@render said(item.text)}</p>
                {:else}
                  <Markdown source={item.text} fileLinks={false} />
                {/if}
                {#if item.cut}<p class="note">{t('rooms.quote.cut')}</p>{/if}
                {#if item.attachments?.length}
                  <p class="files"><FileText size={12} aria-hidden="true" />{quotedFiles(item)}</p>
                {/if}
              </li>
            {/each}
          </ol>
          {#if quote.omitted}
            <p class="omitted">{t('rooms.quote.omitted', { count: quote.omitted })}</p>
          {/if}
        </figure>
      {/if}
      {#if question}
        {#if question.request.title}
          <code class="request mono">{question.request.title}</code>
        {/if}
        {#if question.status === 'pending'}
          <div class="choices">
            <button
              type="button"
              class="button primary small"
              disabled={answering}
              onclick={() => answerQuestion({ confirmed: true })}>{t('common.yes')}</button
            >
            {#if question.request.allowAgain}
              <button
                type="button"
                class="button small"
                disabled={answering}
                title={t('rooms.question.allowAgainTitle')}
                onclick={() => answerQuestion({ confirmed: true, again: true })}
                >{t('rooms.question.allowAgain')}</button
              >
            {/if}
            <button
              type="button"
              class="button small"
              disabled={answering}
              onclick={() => answerQuestion({ confirmed: false })}>{t('common.no')}</button
            >
            {#if workerThread}
              <button type="button" class="action" onclick={() => onopenthread?.(workerThread)}
                >{t('rooms.worker.thread')}</button
              >
            {/if}
            <span class="reply-note">{t('rooms.question.reply')}</span>
          </div>
        {:else}
          <p class="muted small">{questionOutcome(question)}</p>
        {/if}
        {#if answerError}<p class="worker-error" role="alert">{answerError}</p>{/if}
      {/if}
      {#if anchor}
        <div
          class="thread-card"
          class:current={selected}
          aria-current={selected ? 'true' : undefined}
        >
          <div class="thread-top">
            <MessageSquare size={16} aria-hidden="true" />
            <strong class="thread-title">{anchor.title}</strong>
            <span class="thread-status"
              ><StatusGlyph state={glyphOf(anchor.status)} />{statusLabel(
                anchor.status,
                anchor.workers,
              )}</span
            >
          </div>
          <div class="thread-bottom">
            <span
              class="cluster"
              aria-label={t('rooms.threads.workers', { count: anchor.workers })}
              title={t('rooms.threads.workers', { count: anchor.workers })}
              ><span class="initial" aria-hidden="true">{anchor.workers}</span></span
            >
            <span class="last" title={lastWord?.text}
              >{lastWord?.text ?? t('rooms.threads.quiet')}</span
            >
            <button type="button" class="open" onclick={() => onopenthread?.(anchor.threadId)}
              >{t('rooms.worker.openThread')}</button
            >
          </div>
        </div>
        {#if progress}
          <p class="progress mono" title={progress.text}>{progress.text}</p>
        {/if}
        <div class="worker-actions">
          <button type="button" class="action" onclick={() => onopenthread?.(anchor.threadId)}
            >{t('rooms.worker.thread')}</button
          >
          {#if stoppable(anchor.status)}
            <button type="button" class="action" disabled={forgetting} onclick={stopWorker}
              >{t('rooms.worker.stop')}</button
            >
          {/if}
          {#if anchor.note}<span class="muted small"
              >· {t('rooms.worker.waitsFor', { note: anchor.note })}</span
            >{/if}
        </div>
        {#if forgetError}<p class="worker-error" role="alert">{forgetError}</p>{/if}
      {:else if message.body.worker && 'report' in message.body.worker && workerThread}
        <button type="button" class="action small" onclick={() => onopenthread?.(workerThread)}
          >{t('rooms.worker.openThread')}</button
        >
      {/if}
      {#each message.body.attachments ?? [] as attachment (attachment.id)}
        {#if attachment.kind === 'image'}
          <a
            class="image-tile"
            href={roomsApi.uploadUrl(message.roomId, attachment.id)}
            target="_blank"
            rel="noopener"
          >
            <img
              class="image"
              src={roomsApi.uploadUrl(message.roomId, attachment.id)}
              alt={t('rooms.attachment.alt', { name })}
              loading="lazy"
            />
          </a>
        {:else}
          <a
            class="file-card"
            href={roomsApi.uploadUrl(message.roomId, attachment.id)}
            download
            aria-label="{attachment.filename ?? t('rooms.attachment.file')}, {t(
              'rooms.attachment.download',
            )}"
            ><FileText size={28} aria-hidden="true" />
            <span class="file-what"
              ><span class="file-name">{attachment.filename ?? t('rooms.attachment.file')}</span
              ><span class="file-sub">{t('rooms.attachment.download')}</span></span
            ></a
          >
        {/if}
      {/each}
    </div>
    {#if onpin}
      <button
        type="button"
        class="pin"
        aria-label={message.pinnedAt ? t('rooms.pin.unpin') : t('rooms.pin.pin')}
        title={message.pinnedAt ? t('rooms.pin.unpin') : t('rooms.pin.pin')}
        onclick={() => onpin(message, !message.pinnedAt)}><Pin size={14} /></button
      >
    {/if}
  </article>
{/if}

<style>
  .progress {
    margin: 2px 0 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spinner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  /* 40px avatar, 16px gap, 48px on the right, as the design draws a message. */
  .message {
    position: relative;
    display: grid;
    grid-template-columns: 40px 1fr;
    gap: 16px;
    margin-top: 12px;
    padding: 4px 48px 4px 16px;
  }
  .message.continued {
    margin-top: 2px;
    padding-top: 2px;
  }
  /* A question is a warning-tinted card around the whole row. */
  .message.question {
    margin: 8px 8px 0;
    padding: 12px 40px 14px 8px;
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 35%, transparent);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .request {
    align-self: flex-start;
    margin-top: 6px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--code-bg);
    color: var(--ink);
    font-size: 13px;
  }
  .reply-note {
    color: var(--muted);
    font-size: 13px;
  }
  .muted.small {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .asks {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--warning);
    color: var(--bg);
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
  /* The thread open beside the room: its row tinted, its card ringed. */
  .message.selected {
    background: color-mix(in srgb, var(--ink) 3%, transparent);
  }
  .message.question:hover {
    background: var(--warning-soft);
  }
  .gutter {
    display: flex;
    justify-content: center;
  }
  .avatar {
    width: 40px;
    height: 40px;
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
  .content {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .name {
    font-weight: 600;
  }
  .face-name {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .face-name:hover {
    text-decoration: underline;
  }
  .face-badge {
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    text-transform: uppercase;
    letter-spacing: 0.02em;
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
  /* What a move brought along: the topic's messages, quoted in the new room
     behind a rail, the same on a phone (one column, words wrapping). */
  .quote {
    margin: 8px 0 0;
    padding: 8px 12px 8px 12px;
    border-left: 2px solid var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: var(--bg-sidebar);
  }
  .quote figcaption {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .quote .open {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .quote .open:hover {
    text-decoration: underline;
  }
  .quote .copied {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .quote .copied > li + li {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .quote .who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
  }
  .quote .who .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .quote .who time {
    color: var(--faint);
  }
  .quote .copied .text {
    margin-top: 2px;
  }
  .quote .note,
  .quote .files,
  .quote .omitted {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .quote .files {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .mention {
    padding: 0 3px;
    border-radius: 4px;
    font-weight: 500;
  }
  /* The thread preview card: title, status, the workers, what it did last. */
  .thread-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 520px;
    margin-top: 6px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg-sidebar);
  }
  .thread-card.current {
    border-color: transparent;
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .thread-top {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .thread-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
  .thread-bottom {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .cluster {
    display: inline-flex;
  }
  .initial {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--bg-sidebar);
    border-radius: 50%;
    background: var(--bg-subtle);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 9px;
  }
  .last {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-ink);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .worker-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .image-tile {
    display: block;
    max-width: 100%;
    margin-top: 6px;
    border-radius: var(--radius-md);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .image {
    display: block;
    width: 240px;
    max-width: 100%;
    height: 135px;
    border-radius: var(--radius-md);
    object-fit: cover;
  }
  /* A file attachment: its name, and "Download" underneath. */
  .file-card {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
    min-height: 52px;
    margin-top: 6px;
    padding: 8px 14px 8px 10px;
    border-radius: var(--radius-md);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--muted);
    text-decoration: none;
  }
  .file-what {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .file-name {
    color: var(--accent-ink);
    font-weight: 500;
  }
  .file-sub {
    color: var(--faint);
    font-size: 12px;
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
  /* A line at the same 72px inset as a message's text, with its icon. */
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 2px 48px 2px 72px;
    font-size: 13px;
    color: var(--muted);
  }
  .line-icon {
    display: inline-flex;
    flex: none;
  }
  .action {
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--accent-ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .action:hover {
    background: var(--bg-hover);
  }
  .action.quiet {
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
