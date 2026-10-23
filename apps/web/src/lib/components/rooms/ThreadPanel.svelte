<script lang="ts">
  /**
   * A worker's thread beside its room (design screen 2): the thread's title
   * and where it came from, the worker strip (the worker and its team, each
   * with its state), the messages with tool calls as chips, and the reply box.
   * The room stays visible on the left; this column is the design's 420px.
   */
  import { ArrowUpRight, MessageSquare, Plus, X } from '@lucide/svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';
  import { listFocus } from '../../a11y';
  import { speakerFace, hueOf, initialOf, type Face } from '../../faces';
  import { ApiError } from '../../http';
  import { locale, t } from '../../i18n';
  import { engineLink } from '../../routes';
  import {
    questionOutcome,
    speakerName,
    statusLabel,
    workerTree,
    workersApi,
    type QuestionAnswer,
    type ThreadMessage,
    type Worker,
    type WorkerStatus,
  } from '../../workers';
  import Markdown from '../Markdown.svelte';

  interface Props {
    threadId: string;
    messages: ThreadMessage[];
    workers: Worker[];
    error?: string;
    /** The thread is being fetched: a skeleton line until it arrives. */
    loading?: boolean;
    /** The faces: who the thread came from, and how its messages look. */
    faces?: Face[];
    /** The person looking: only whom the worker works for may act on it. */
    user: string;
    onclose: () => void;
  }

  let {
    threadId,
    messages,
    workers,
    error = '',
    loading = false,
    faces = [],
    user,
    onclose,
  }: Props = $props();

  const latest = $derived<Worker | undefined>(workers[0]);
  const mine = $derived(!!latest && latest.for === user);
  const tree = $derived(workerTree(messages, workers));
  const from = $derived(latest ? faces.find((face) => face.id === latest.faceId) : undefined);
  let draft = $state('');
  let busy = $state(false);
  let actionError = $state('');
  /** Typed answers to questions, by interaction. */
  let answers = $state<Record<string, string>>({});

  /** Who a message is from: a face's name, a worker's, or a person's. */
  function nameOf(message: Pick<ThreadMessage, 'speaker' | 'user'>): string {
    return speakerFace(faces, message.speaker)?.name ?? speakerName(message);
  }

  /** The worker a teammate works under, for the `↳ lint` marker. */
  function parentOf(speaker: string): string | undefined {
    return tree.find((row) => row.speaker === speaker)?.parent;
  }

  /** A worker row's word: its state, then what it last did. */
  function rowText(row: (typeof tree)[number]): string {
    const state = row.status ? statusLabel(row.status) : '';
    if (state && row.line) return `${state} · ${row.line}`;
    return state || row.line;
  }

  function glyphFor(status: WorkerStatus | undefined) {
    return status ? glyphOf(status) : 'idle';
  }

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    actionError = '';
    try {
      await run();
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
    } finally {
      busy = false;
    }
  }

  function say(event: SubmitEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void act(async () => {
      await workersApi.say(threadId, text);
      draft = '';
    });
  }

  function answer(message: ThreadMessage, given: QuestionAnswer) {
    void act(() => workersApi.answer(threadId, message.body.interactionId ?? '', given));
  }

  const time = (at: number) =>
    new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(at);

  /** The two or three letters a worker's square shows (`lint`, `rv`). */
  const initialsOf = (name: string) => [...name].slice(0, 4).join('');
</script>

{#snippet avatar(message: ThreadMessage)}
  {@const face = speakerFace(faces, message.speaker)}
  {@const worker = message.speaker.startsWith('worker:')}
  <span
    class="avatar"
    class:face={!!face}
    class:worker
    style:--hue={hueOf(nameOf(message))}
    style:background={face?.color ?? undefined}
    aria-hidden="true"
    >{worker ? initialsOf(nameOf(message)) : initialOf(nameOf(message), face?.avatar)}</span
  >
{/snippet}

<aside
  class="thread"
  aria-label={latest ? t('thread.panel', { title: latest.title }) : t('thread.title')}
>
  <header>
    <MessageSquare class="lead" size={20} aria-hidden="true" />
    <div class="title">
      <h2>{latest?.title ?? t('thread.title')}</h2>
      <p class="from">
        {#if from}
          <span class="face" style:color={from.color ?? undefined}
            >{t('thread.from', { name: from.name })}</span
          >
        {:else}
          <span>{t('thread.from', { name: latest?.faceId ?? '' })}</span>
        {/if}
        {#if latest?.workspace}<span aria-hidden="true"> · </span><span>{latest.workspace}</span
          >{/if}
        {#if latest}
          <span class="state" role="status"
            ><StatusGlyph state={glyphOf(latest.status)} />{statusLabel(
              latest.status,
              tree.filter((row) => row.depth === 0).length,
            )}{latest.readOnly ? ` · ${t('thread.readOnly')}` : ''}</span
          >
        {/if}
      </p>
    </div>
    {#if latest?.targetSessionId}
      <a
        class="engine"
        href={engineLink({ session: latest.targetSessionId })}
        aria-label={t('thread.session')}
        title={t('thread.session')}
        ><ArrowUpRight size={14} aria-hidden="true" />{t('common.tab.engine')}</a
      >
    {/if}
    <button type="button" class="icon" aria-label={t('thread.close')} onclick={onclose}
      ><X size={18} /></button
    >
  </header>

  {#if tree.length}
    <section class="workers" aria-label={t('thread.workers')} role="status">
      {#each tree as row (row.speaker)}
        <div class="worker-row" class:child={row.depth === 1}>
          {#if row.depth === 1}<span class="elbow" aria-hidden="true"></span>{/if}
          <StatusGlyph state={glyphFor(row.status)} size={8} />
          <span class="worker-name">{row.name}</span>
          <span class="worker-state {row.status ?? 'unknown'}" title={rowText(row)}
            >{rowText(row)}</span
          >
        </div>
      {/each}
    </section>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <ol
    class="messages"
    role="log"
    aria-label={t('thread.messages')}
    tabindex="0"
    use:listFocus={{ selector: 'li.item' }}
  >
    {#if error}<li class="error" role="alert">{error}</li>{/if}
    {#if loading && !messages.length}
      <li class="skeleton" aria-hidden="true"><span></span><span></span></li>
      <li class="sr-only" role="status">{t('thread.loading')}</li>
    {:else if !messages.length && !error}
      <li class="empty">{t('thread.empty')}</li>
    {/if}
    {#each messages as message (message.id)}
      {@const face = speakerFace(faces, message.speaker)}
      {#if message.kind === 'line'}
        <li class="item line" class:child={message.depth === 1} tabindex="-1">
          <Plus size={12} aria-hidden="true" />
          <span class="text">{message.body.text ?? ''}</span>
          <time datetime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time
          >
        </li>
      {:else}
        <li class="item {message.kind}" class:child={message.depth === 1} tabindex="-1">
          <span class="gutter">{@render avatar(message)}</span>
          <div class="said">
            <div class="who">
              <span
                class="name"
                class:worker={message.speaker.startsWith('worker:')}
                style:color={face ? (face.color ?? undefined) : undefined}>{nameOf(message)}</span
              >
              {#if message.speaker.startsWith('worker:')}
                <span class="tag">{t('thread.workerTag')}</span>
              {/if}
              {#if message.depth === 1 && parentOf(message.speaker)}
                <span class="parent"
                  >{t('thread.nested', { name: parentOf(message.speaker) ?? '' })}</span
                >
              {/if}
              <time datetime={new Date(message.createdAt).toISOString()}
                >{time(message.createdAt)}</time
              >
            </div>
            {#if message.kind === 'tool'}
              <div class="tool-chip" title={message.body.summary ?? message.body.tool ?? ''}>
                <span class="tool-name">{message.body.tool ?? ''}</span>
                <code>{message.body.summary ?? message.body.tool ?? t('thread.tool')}</code>
              </div>
            {:else if message.kind === 'question'}
              <div class="question">
                <p>
                  {message.body.request?.title ??
                    message.body.request?.message ??
                    t('thread.question')}
                </p>
                {#if message.body.request?.title && message.body.request?.message}
                  <p class="more">{message.body.request.message}</p>
                {/if}
                {#if message.body.status !== 'pending'}
                  <p class="more">
                    {questionOutcome({
                      status: message.body.status ?? 'answered',
                      answeredBy: message.body.answeredBy,
                      answer: message.body.answer,
                    })}
                  </p>
                {:else if !mine}
                  <p class="more">
                    {t('thread.waitingFor', {
                      name: latest?.for ?? t('thread.whomItWorksFor'),
                    })}
                  </p>
                {:else if message.body.kind === 'confirm'}
                  <div class="choices">
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() => answer(message, { confirmed: true })}
                      >{message.body.request?.confirmLabel ?? t('common.yes')}</button
                    >
                    {#if message.body.request?.allowAgain}
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => answer(message, { confirmed: true, again: true })}
                        >{t('rooms.question.allowAgain')}</button
                      >
                    {/if}
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() => answer(message, { confirmed: false })}
                      >{message.body.request?.cancelLabel ?? t('common.no')}</button
                    >
                  </div>
                {:else if message.body.kind === 'select' && message.body.request?.options?.length}
                  <div class="choices">
                    {#each message.body.request.options as option (option)}
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => answer(message, { value: option })}>{option}</button
                      >
                    {/each}
                  </div>
                {:else}
                  <form
                    class="choices"
                    onsubmit={(event) => {
                      event.preventDefault();
                      const value = answers[message.id]?.trim();
                      if (value) answer(message, { value });
                    }}
                  >
                    <input
                      aria-label={t('thread.answer.label')}
                      placeholder={message.body.request?.placeholder ?? t('thread.answer.label')}
                      bind:value={answers[message.id]}
                    />
                    <button type="submit" disabled={busy}>{t('thread.answer.send')}</button>
                  </form>
                {/if}
              </div>
            {:else if message.speaker === 'user'}
              <span class="text">{message.body.text ?? ''}</span>
            {:else}
              <!-- A worker writes Markdown; there is no Files pane here either. -->
              <Markdown source={message.body.text ?? ''} compact fileLinks={false} />
            {/if}
            {#if message.body.context}
              <details>
                <summary>{t('thread.given')}</summary>
                <pre>{message.body.context}</pre>
              </details>
            {/if}
          </div>
        </li>
      {/if}
    {/each}
  </ol>

  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
  <form class="composer" onsubmit={say}>
    <input
      aria-label={t('thread.say.label')}
      placeholder={mine
        ? t('thread.say.jump')
        : t('thread.waitingFor', { name: latest?.for ?? t('thread.whomItWorksFor') })}
      disabled={!mine || busy}
      bind:value={draft}
    />
    <button type="submit" disabled={!mine || busy || !draft.trim()}
      >{t('rooms.composer.send')}</button
    >
  </form>
</aside>

<style>
  .thread {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  /* A 52px header: the thread's mark, its title and where it came from. */
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .lead {
    flex: none;
    color: var(--muted);
  }
  .title {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  h2 {
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .from {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--faint);
    font-size: 12px;
  }
  .from .face {
    font-weight: 500;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .state::before {
    content: ' · ';
    color: var(--faint);
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .engine {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    min-height: 32px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 13px;
    text-decoration: none;
  }
  .engine:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
  }
  .icon:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  /* The worker strip: a 30px row each, teammates indented under their worker. */
  .workers {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .worker-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 0 4px;
    font-size: 13px;
  }
  .worker-row.child {
    padding-left: 24px;
  }
  .elbow {
    width: 10px;
    height: 10px;
    margin-left: -12px;
    border-left: 1.5px solid var(--line-strong);
    border-bottom: 1.5px solid var(--line-strong);
    border-radius: 0 0 0 4px;
    transform: translateY(-4px);
  }
  .worker-name {
    color: var(--ink);
    font-family: var(--font-mono);
  }
  .worker-state {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .worker-state.running {
    color: var(--success);
  }
  .worker-state.waiting_input {
    color: var(--warning);
  }
  .worker-state.failed {
    color: var(--danger);
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .item {
    display: flex;
    gap: 12px;
    padding: 8px 16px;
    font-size: 14px;
  }
  /* A teammate's message: indented, with a smaller square. */
  .item.child {
    padding: 4px 16px 8px 60px;
  }
  .gutter {
    flex: none;
    display: flex;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: hsl(var(--hue) 45% 48%);
    color: white;
    font-size: 12px;
    font-weight: 700;
  }
  .avatar.worker {
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
  }
  .item.child .avatar {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    font-size: 10px;
  }
  .said {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .name {
    color: var(--ink);
    font-weight: 600;
    font-size: 14px;
  }
  .name.worker {
    font-family: var(--font-mono);
  }
  .item.child .name {
    font-size: 13px;
  }
  .tag {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-transform: uppercase;
  }
  .parent {
    color: var(--faint);
    font-size: 12px;
  }
  time {
    color: var(--faint);
    font-size: 12px;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .item.line {
    align-items: center;
    gap: 8px;
    padding: 2px 16px 2px 60px;
    color: var(--muted);
    font-size: 12px;
  }
  .item.line.child {
    padding-left: 60px;
  }
  /* A tool call: the tool in words, its one line in mono. */
  .tool-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--muted);
    font-size: 12px;
  }
  .tool-name {
    flex: none;
    color: var(--faint);
  }
  .tool-chip code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--code-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .question {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--warning-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 35%, transparent);
  }
  .question p {
    margin: 0;
  }
  .more {
    font-size: 12px;
    color: var(--muted);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .choices button {
    min-height: 28px;
    padding: 2px 10px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--bg-layer);
    color: var(--ink);
    font-size: 13px;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  /* The reply box: a filled 44px bar, always there (the design's composer). */
  .composer {
    display: flex;
    gap: 8px;
    padding: 0 12px 20px;
  }
  .composer input {
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--bg-composer);
    font-size: 14px;
  }
  .composer input:disabled {
    opacity: 0.7;
  }
  .composer button {
    flex: none;
    padding: 0 14px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--on-accent);
    font-size: 13px;
    font-weight: 600;
  }
  .composer button:disabled {
    background: var(--bg-hover);
    color: var(--muted);
  }
  .error {
    margin: 4px 16px;
    color: var(--danger);
    font-size: 13px;
  }
  .empty {
    padding: 12px 16px;
    color: var(--muted);
    font-size: 13px;
  }
  /* A skeleton line while the thread loads, as the log has. */
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 8px 16px;
  }
  .skeleton span {
    height: 12px;
    border-radius: 6px;
    background: var(--bg-hover);
    animation: breathe 1.6s var(--ease) infinite;
  }
  .skeleton span:nth-child(2) {
    width: 60%;
    animation-delay: 0.2s;
  }
  @keyframes breathe {
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton span {
      animation: none;
    }
  }
  pre {
    white-space: pre-wrap;
    font-size: 12px;
  }
</style>
