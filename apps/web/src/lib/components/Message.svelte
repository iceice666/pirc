<script lang="ts">
  import {
    Brain,
    ChevronRight,
    CircleAlert,
    Copy,
    GitBranch,
    Image as ImageIcon,
    Info,
    Layers,
    Puzzle,
    SquareTerminal,
    TriangleAlert,
  } from '@lucide/svelte';
  import type { ConversationMessage } from '../types';
  import Markdown from './Markdown.svelte';
  import RunCard from './RunCard.svelte';
  import ToolCard from './ToolCard.svelte';

  interface Props {
    message: ConversationMessage;
    /** Already inside a run card: list the tools without another card around them. */
    grouped?: boolean;
  }

  let { message, grouped = false }: Props = $props();

  let thinkingOpen = $state(false);
  let systemOpen = $state(false);

  function time(date: string) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  let kind = $derived(message.systemKind ?? 'custom');
  let SystemIcon = $derived(
    kind === 'bash'
      ? SquareTerminal
      : kind === 'compaction'
        ? Layers
        : kind === 'branch'
          ? GitBranch
          : kind === 'notice'
            ? message.level === 'error'
              ? CircleAlert
              : message.level === 'warning'
                ? TriangleAlert
                : Info
            : Puzzle,
  );
  // Short system entries read fine inline; long summaries/outputs collapse.
  let runtimeEvent = $derived(kind === 'team' || kind === 'background');
  let collapsible = $derived(
    kind === 'compaction' || kind === 'branch' || kind === 'bash' || runtimeEvent,
  );
  // Notices read like a tool row: "Source: detail" splits into name + summary,
  // and only the first line shows until expanded.
  let noticeFirstLine = $derived(message.content.split('\n', 1)[0]!.trim());
  let noticeParts = $derived(/^([^:]{1,40}):\s+(.+)$/.exec(noticeFirstLine));
  let noticeName = $derived(noticeParts ? noticeParts[1]! : noticeFirstLine);
  let noticeDetail = $derived(noticeParts ? noticeParts[2]! : '');
  let noticeExpandable = $derived(
    kind === 'notice' && (message.content.trim().includes('\n') || noticeFirstLine.length > 80),
  );
  let streamingThinking = $derived(!!message.isPartial && !message.content && !!message.thinking);
  let thinkingVisible = $derived(thinkingOpen || streamingThinking);
  // Tool/thinking-only assistant turns stack tightly, like one process log.
  let processOnly = $derived(
    message.role === 'assistant' &&
      !message.content &&
      !message.stopReason &&
      !message.errorMessage &&
      !message.images?.length,
  );
  let hasBody = $derived(
    !!message.content || !!message.isPartial || !!message.errorMessage || !!message.images?.length,
  );
</script>

{#snippet toolStack(tools: NonNullable<ConversationMessage['tools']>)}
  {#if tools.length > 1 && !grouped}
    <RunCard {tools}>
      <div class="tool-stack">
        {#each tools as tool (tool.id)}<ToolCard {tool} />{/each}
      </div>
    </RunCard>
  {:else}
    <div class="tool-stack">
      {#each tools as tool (tool.id)}<ToolCard {tool} />{/each}
    </div>
  {/if}
{/snippet}

{#if message.role === 'system'}
  <aside
    class="system-entry"
    data-kind={kind}
    data-level={message.level ?? 'info'}
    aria-label={message.label ?? 'System message'}
  >
    {#if kind === 'notice'}
      <button
        class="system-line"
        type="button"
        disabled={!noticeExpandable}
        aria-expanded={noticeExpandable ? systemOpen : undefined}
        title={noticeExpandable ? undefined : message.content}
        onclick={() => (systemOpen = !systemOpen)}
      >
        <span class="system-icon" aria-hidden="true"
          ><SystemIcon size={14} strokeWidth={1.8} /></span
        >
        <span class="notice-text">
          <strong>{noticeName}</strong>
          {#if noticeDetail}<span>{noticeDetail}</span>{/if}
        </span>
        <time datetime={message.createdAt}>{time(message.createdAt)}</time>
        {#if noticeExpandable}<ChevronRight
            class={systemOpen ? 'rotated' : ''}
            size={14}
            aria-hidden="true"
          />{/if}
      </button>
      {#if systemOpen}
        <div class="system-body"><Markdown source={message.content} compact /></div>
      {/if}
    {:else}
      <button
        class="system-line"
        type="button"
        disabled={!collapsible || (!message.content && !message.tools?.length)}
        aria-expanded={collapsible ? systemOpen : undefined}
        onclick={() => (systemOpen = !systemOpen)}
      >
        <span class="system-icon" aria-hidden="true"><SystemIcon size={14} /></span>
        <span class="system-title">
          {#if kind === 'bash'}<code>$ {message.label}</code>{:else}<strong>{message.label}</strong
            >{/if}
          {#if message.meta}<span>{message.meta}</span>{/if}
        </span>
        <time datetime={message.createdAt}>{time(message.createdAt)}</time>
        {#if collapsible && message.content}<ChevronRight
            class={systemOpen ? 'rotated' : ''}
            size={14}
            aria-hidden="true"
          />{/if}
      </button>
      {#if (!collapsible || systemOpen) && message.content}
        <div class="system-body">
          {#if kind === 'bash' || runtimeEvent}<pre>{message.content}</pre>{:else}<Markdown
              source={message.content}
              compact
            />{/if}
        </div>
      {/if}
      {#if message.images?.length}
        <div class="message-images">
          {#each message.images as image, index (`${index}:${image.url}`)}<img
              src={image.url}
              alt="Attachment"
              loading="lazy"
            />{/each}
        </div>
      {/if}
      {#if message.tools?.length}
        <div class="tool-stack">
          {#each message.tools as tool (tool.id)}<ToolCard {tool} />{/each}
        </div>
      {/if}
    {/if}
  </aside>
{:else}
  <article
    class:user={message.role === 'user'}
    class:assistant={message.role === 'assistant'}
    class:process={processOnly}
    class="message"
  >
    <div class="message-main">
      {#if message.thinking || message.thinkingRedacted}
        <div class="thinking" class:open={thinkingVisible} class:streaming={streamingThinking}>
          <button
            type="button"
            class="thinking-toggle"
            aria-expanded={thinkingVisible}
            onclick={() => (thinkingOpen = !thinkingOpen)}
          >
            <Brain size={15} aria-hidden="true" />
            <span
              >{streamingThinking
                ? 'Thinking…'
                : message.thinkingRedacted && !message.thinking
                  ? 'Reasoning redacted'
                  : 'Thought'}</span
            >
            <ChevronRight class={thinkingVisible ? 'rotated' : ''} size={14} aria-hidden="true" />
          </button>
          {#if thinkingVisible && message.thinking}
            <div class="thinking-body">
              <Markdown source={message.thinking} streaming={streamingThinking} compact />
            </div>
          {/if}
        </div>
      {/if}
      {#if hasBody}
        <div class="message-copy">
          {#if message.role === 'user'}
            <span class="plain">{message.content}</span>
          {:else if message.content}
            <Markdown source={message.content} streaming={message.isPartial} />
          {/if}
          {#if message.isPartial && !streamingThinking && (message.role === 'user' || !message.content)}<span
              class="stream-cursor"
              aria-label="Streaming"
            ></span>{/if}
        </div>
      {/if}
      {#if message.stopReason}
        <div class="message-error" role="status">
          <CircleAlert size={14} aria-hidden="true" />
          <span
            >{message.stopReason === 'aborted' ? 'Stopped' : 'Error'}{message.errorMessage
              ? `: ${message.errorMessage}`
              : ''}</span
          >
        </div>
      {/if}
      {#if message.images?.length}
        <div class="message-images">
          {#each message.images as image, index (`${index}:${image.url}`)}<img
              src={image.url}
              alt="Attachment"
              loading="lazy"
            />{/each}
        </div>
      {/if}
      {#if message.attachments?.length}
        <div class="message-attachments">
          {#each message.attachments as attachment (attachment.id)}
            <span><ImageIcon size={15} /> {attachment.name}</span>
          {/each}
        </div>
      {/if}
      {#if message.tools?.length}
        {@render toolStack(message.tools)}
      {/if}
      {#if !message.isPartial && message.content}
        <div class="message-actions">
          <time datetime={message.createdAt}>{time(message.createdAt)}</time>
          {#if message.role === 'assistant' && message.model}<span class="message-model"
              >{message.model}</span
            >{/if}
          {#if message.content}
            <button
              type="button"
              class="icon-action touch-target"
              aria-label="Copy message"
              title="Copy"
              onclick={() => navigator.clipboard.writeText(message.content)}
              ><Copy size={14} /></button
            >
          {/if}
        </div>
      {/if}
    </div>
  </article>
{/if}

<style>
  /* ───────────── Messages ───────────── */
  .message {
    /* Off-screen messages (code, KaTeX) skip layout and paint; `auto` keeps their last size. */
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
    display: flex;
    flex-direction: column;
    margin: 0 0 16px;
  }
  .message.process {
    margin-bottom: 2px;
  }
  .message.process .tool-stack {
    margin-top: 0;
  }
  .message.process .thinking {
    margin-bottom: 2px;
  }
  .message.process:has(+ :global(.message:not(.process))),
  .message.process:last-child {
    margin-bottom: 16px;
  }
  .message-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .message.user .message-main {
    align-items: flex-end;
    max-width: min(82%, 560px);
    margin-left: auto;
  }
  .message-copy {
    color: var(--ink);
    font-size: 15px;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
  .message-copy .plain {
    white-space: pre-wrap;
  }
  .message.user .message-copy {
    max-width: 100%;
    padding: 10px 16px;
    border-radius: var(--radius-xl);
    background: var(--bubble);
    line-height: 22px;
  }
  .stream-cursor {
    width: 8px;
    height: 8px;
    display: inline-block;
    margin-left: 4px;
    vertical-align: middle;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  .message-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .message-attachments span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 12px;
  }
  .message-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    margin-top: 2px;
    color: var(--muted);
    font-size: 12px;
    opacity: 0;
    transition: opacity 0.15s var(--ease);
  }
  .message:hover .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }
  /* No hover on touch (phones and tablets): keep copy reachable, but quieter than the text. */
  @media (hover: none) {
    .message-actions {
      opacity: 0.7;
    }
  }
  .message-model {
    overflow: hidden;
    max-width: 220px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .icon-action {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
  }
  .icon-action:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .message-images img {
    max-width: min(100%, 360px);
    max-height: 280px;
    border-radius: var(--radius-md);
    object-fit: contain;
    background: var(--bg-subtle);
  }
  /* Thinking: a quiet 24px disclosure row, body indented under the title. */
  .thinking {
    position: relative;
    margin: 0 0 8px;
  }
  .thinking-toggle {
    position: relative;
    overflow: hidden;
    height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 4px;
    margin-left: -4px;
    color: var(--text-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: 14px;
  }
  .thinking-toggle:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .thinking.streaming .thinking-toggle span {
    background: linear-gradient(
        90deg,
        var(--text-2) 0%,
        var(--text-2) 40%,
        var(--faint) 50%,
        var(--text-2) 60%,
        var(--text-2) 100%
      )
      0 0 / 250% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    animation: sweep 2.2s linear infinite;
  }
  .thinking-toggle > :global(svg:last-child) {
    color: var(--muted);
    transition: transform 0.18s var(--ease);
  }
  .thinking-toggle > :global(svg.rotated),
  .system-line > :global(svg.rotated) {
    transform: rotate(90deg);
  }
  .thinking-body {
    margin: 4px 0 4px 7px;
    padding: 0 0 0 14px;
    border-left: 1px solid var(--line-dark);
    color: var(--muted);
    font-size: 14px;
    line-height: 1.7;
  }
  .message-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    color: var(--danger);
    background: var(--danger-soft);
    font-size: 13px;
    line-height: 1.5;
  }
  .message-error :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  /* ───────────── Tool rows ───────────── */
  .tool-stack {
    display: grid;
    gap: 2px;
    margin: 8px 0 0;
  }
  .message-copy + .tool-stack {
    margin-top: 12px;
  }
  /* ───────────── System timeline entries ───────────── */
  .system-entry {
    margin: -8px 0 20px;
    color: var(--muted);
    font-size: 13px;
  }
  .system-line {
    width: 100%;
    min-height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 4px;
    color: inherit;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    font-size: inherit;
  }
  button.system-line:disabled {
    cursor: default;
    opacity: 1;
  }
  button.system-line:not(:disabled):hover {
    background: var(--bg-hover);
  }
  .system-line > time {
    margin-left: auto;
    flex: none;
    color: var(--muted);
    font-size: 12px;
  }
  .system-line > :global(svg) {
    flex: none;
    transition: transform 0.18s var(--ease);
  }
  .system-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
  }
  .system-title {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .system-title strong {
    color: var(--text-2);
    font-weight: 400;
  }
  .system-title code {
    overflow: hidden;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 12.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .system-title span {
    flex: none;
    color: var(--muted);
    font-size: 12px;
  }
  .system-body {
    margin: 4px 0 0 22px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    color: var(--text-2);
    background: var(--code-bg);
  }
  .system-body pre {
    max-height: 320px;
    margin: 0;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .system-entry .tool-stack {
    margin-top: 4px;
  }
  /* Notices sit in the process log like tool rows: flat, one line, tightly stacked. */
  .system-entry[data-kind='notice'] {
    margin: 0 0 2px;
  }
  .system-entry[data-kind='notice']:has(+ :global(.message:not(.process))),
  .system-entry[data-kind='notice']:last-child {
    margin-bottom: 16px;
  }
  .system-entry[data-kind='notice'] .system-line {
    margin-left: -4px;
    width: calc(100% + 4px);
    font-size: 14px;
  }
  .system-entry[data-kind='notice'] .system-icon {
    color: var(--muted);
  }
  .system-entry[data-kind='notice'] .system-line > :global(svg:last-child) {
    color: var(--faint);
  }
  .system-entry[data-kind='notice']
    .system-line:not(:hover):not([aria-expanded='true'])
    > :global(svg:last-child) {
    opacity: 0;
  }
  .notice-text {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .notice-text strong {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    font-weight: 400;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .notice-text span {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .system-entry[data-kind='notice'] .system-body {
    margin-bottom: 8px;
  }
  .system-entry[data-kind='notice'][data-level='warning'] .system-icon,
  .system-entry[data-kind='notice'][data-level='warning'] .notice-text strong {
    color: var(--warning);
  }
  .system-entry[data-kind='notice'][data-level='error'] .system-icon,
  .system-entry[data-kind='notice'][data-level='error'] .notice-text strong {
    color: var(--danger);
  }
  .system-entry[data-kind='bash'][data-level='warning'] .system-line {
    color: var(--warning);
  }
  .system-entry[data-kind='compaction'] .system-icon,
  .system-entry[data-kind='branch'] .system-icon {
    color: var(--accent);
  }
  @media (max-width: 650px) {
    .message-copy {
      font-size: 15px;
      line-height: 1.65;
    }
    .message.user .message-main {
      max-width: 88%;
    }
    .message.user .message-copy {
      padding: 9px 14px;
    }
    .message-actions {
      min-height: 20px;
    }
    /* Timeline rows drop their clock time: the width goes to the tool name and detail. */
    .system-line > time {
      display: none;
    }
    .system-title {
      flex: 1;
    }
    .system-title strong {
      flex: none;
      white-space: nowrap;
    }
    .system-title span {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .system-body {
      margin-left: 0;
    }
  }
</style>
