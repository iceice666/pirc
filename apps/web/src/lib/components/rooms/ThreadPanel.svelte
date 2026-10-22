<script lang="ts">
  import { SquareTerminal, Square, X } from '@lucide/svelte';
  import { listFocus } from '../../a11y';
  import { ApiError } from '../../http';
  import { engineLink } from '../../routes';
  import {
    questionOutcome,
    speakerName,
    statusLabel,
    stoppable,
    threadWorkers,
    workersApi,
    type QuestionAnswer,
    type ThreadMessage,
    type Worker,
  } from '../../workers';
  import Markdown from '../Markdown.svelte';

  interface Props {
    threadId: string;
    messages: ThreadMessage[];
    workers: Worker[];
    error?: string;
    /** The person looking: only whom the worker works for may act on it. */
    user: string;
    onclose: () => void;
  }

  let { threadId, messages, workers, error = '', user, onclose }: Props = $props();

  const latest = $derived<Worker | undefined>(workers[0]);
  const mine = $derived(!!latest && latest.for === user);
  const speakers = $derived(threadWorkers(messages));
  let draft = $state('');
  let busy = $state(false);
  let actionError = $state('');
  /** Typed answers to questions, by interaction. */
  let answers = $state<Record<string, string>>({});

  /** The latest status each worker of the thread showed. */
  function lastSaid(speaker: string): string {
    const said = [...messages].reverse().find((message) => message.speaker === speaker);
    if (!said) return '';
    if (said.kind === 'tool') return said.body.summary ?? said.body.tool ?? '';
    return said.body.text ?? '';
  }

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    actionError = '';
    try {
      await run();
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : 'Unable to reach the gateway.';
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
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at);
</script>

<aside class="thread" aria-label="Thread">
  <header>
    <div class="title">
      <strong>{latest?.title ?? 'Thread'}</strong>
      {#if latest}
        <span class="status {latest.status}" role="status"
          ><span class="dot" aria-hidden="true"></span>{statusLabel(
            latest.status,
            speakers.length,
          )}{latest.readOnly ? ' · read-only' : ''}</span
        >
        <span class="where"
          >{latest.workspace}{latest.note ? ` · waits for ${latest.note}` : ''}</span
        >
      {/if}
    </div>
    {#if latest?.targetSessionId}
      <a
        class="icon"
        href={engineLink({ session: latest.targetSessionId })}
        aria-label="Its session in the engine"
        title="Its session in the engine"><SquareTerminal size={16} /></a
      >
    {/if}
    {#if latest && mine && stoppable(latest.status)}
      <button
        type="button"
        class="stop"
        disabled={busy}
        onclick={() => act(() => workersApi.stop(latest.id))}><Square size={12} />Stop</button
      >
    {/if}
    <button type="button" class="icon" aria-label="Close the thread" onclick={onclose}
      ><X size={16} /></button
    >
  </header>

  {#if speakers.length}
    <ul class="workers" aria-label="Workers">
      {#each speakers as worker (worker.speaker)}
        <li class:child={worker.depth === 1}>
          <span class="name">{speakerName({ speaker: worker.speaker, user: null })}</span>
          <span class="said">{lastSaid(worker.speaker)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <ol
    class="messages"
    role="log"
    aria-label="The thread's messages"
    tabindex="0"
    use:listFocus={{ selector: 'li.item' }}
  >
    {#if error}<li class="error" role="alert">{error}</li>{/if}
    {#each messages as message (message.id)}
      <li class="item {message.kind}" class:child={message.depth === 1} tabindex="-1">
        <span class="who">{speakerName(message)}</span>
        {#if message.kind === 'tool'}
          <code>{message.body.summary ?? message.body.tool}</code>
        {:else if message.kind === 'question'}
          <div class="question">
            <p>{message.body.request?.title ?? message.body.request?.message ?? 'A question'}</p>
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
              <p class="more">Waiting for {latest?.for ?? 'whom it works for'}.</p>
            {:else if message.body.kind === 'confirm'}
              <div class="choices">
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => answer(message, { confirmed: true })}
                  >{message.body.request?.confirmLabel ?? 'Yes'}</button
                >
                {#if message.body.request?.allowAgain}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => answer(message, { confirmed: true, again: true })}
                    >Allow again this session</button
                  >
                {/if}
                <button
                  type="button"
                  disabled={busy}
                  onclick={() => answer(message, { confirmed: false })}
                  >{message.body.request?.cancelLabel ?? 'No'}</button
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
                  aria-label="Your answer"
                  placeholder={message.body.request?.placeholder ?? 'Your answer'}
                  bind:value={answers[message.id]}
                />
                <button type="submit" disabled={busy}>Answer</button>
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
            <summary>What it was given</summary>
            <pre>{message.body.context}</pre>
          </details>
        {/if}
        <time datetime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>
      </li>
    {/each}
  </ol>

  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
  {#if latest && mine}
    <form class="composer" onsubmit={say}>
      <input
        aria-label="Say something to the worker"
        placeholder={stoppable(latest.status) ? 'Tell the worker…' : 'Give it more to do…'}
        bind:value={draft}
      />
      <button type="submit" disabled={busy || !draft.trim()}>Send</button>
    </form>
  {/if}
</aside>

<style>
  .thread {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 12px 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .status,
  .where {
    font-size: 12px;
    color: var(--muted);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .running .dot,
  .waiting_input .dot {
    background: var(--accent);
  }
  .completed .dot {
    background: var(--success, #2e9d5b);
  }
  .failed .dot {
    background: var(--danger);
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  a.icon {
    display: grid;
    place-items: center;
  }
  .icon {
    padding: 4px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .stop,
  .choices button,
  .composer button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--bg-layer);
    color: var(--ink);
  }
  ul,
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .workers {
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .workers li {
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .workers .said {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .child {
    margin-left: 20px;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px;
  }
  .item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
    align-items: baseline;
  }
  .item.line,
  .item.tool {
    color: var(--muted);
  }
  .who {
    font-weight: 600;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  code {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  time {
    font-size: 11px;
    color: var(--muted);
  }
  .question {
    padding: 6px 10px;
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg-layer);
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
  input {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  .composer {
    display: flex;
    gap: 8px;
    padding: 8px 12px 12px;
  }
  .error {
    margin: 0 16px;
    color: var(--danger);
    font-size: 13px;
  }
  pre {
    white-space: pre-wrap;
    font-size: 12px;
  }
</style>
