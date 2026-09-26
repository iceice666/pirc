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
  import ToolCard from './ToolCard.svelte';

  export let message: ConversationMessage;

  let thinkingOpen = false;
  let systemOpen = false;

  function time(date: string) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  $: kind = message.systemKind ?? 'custom';
  $: systemIcon =
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
            : Puzzle;
  // Short system entries read fine inline; long summaries/outputs collapse.
  $: collapsible = kind === 'compaction' || kind === 'branch' || kind === 'bash';
  // Notices read like a tool row: "Source: detail" splits into name + summary,
  // and only the first line shows until expanded.
  $: noticeFirstLine = message.content.split('\n', 1)[0]!.trim();
  $: noticeParts = /^([^:]{1,40}):\s+(.+)$/.exec(noticeFirstLine);
  $: noticeName = noticeParts ? noticeParts[1]! : noticeFirstLine;
  $: noticeDetail = noticeParts ? noticeParts[2]! : '';
  $: noticeExpandable =
    kind === 'notice' && (message.content.trim().includes('\n') || noticeFirstLine.length > 80);
  $: streamingThinking = !!message.isPartial && !message.content && !!message.thinking;
  $: thinkingVisible = thinkingOpen || streamingThinking;
  // Tool/thinking-only assistant turns stack tightly, like one process log.
  $: processOnly =
    message.role === 'assistant' &&
    !message.content &&
    !message.stopReason &&
    !message.errorMessage &&
    !message.images?.length;
  $: hasBody =
    !!message.content || !!message.isPartial || !!message.errorMessage || !!message.images?.length;
</script>

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
        on:click={() => (systemOpen = !systemOpen)}
      >
        <span class="system-icon" aria-hidden="true"
          ><svelte:component this={systemIcon} size={14} strokeWidth={1.8} /></span
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
        on:click={() => (systemOpen = !systemOpen)}
      >
        <span class="system-icon" aria-hidden="true"
          ><svelte:component this={systemIcon} size={14} /></span
        >
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
          {#if kind === 'bash'}<pre>{message.content}</pre>{:else}<Markdown
              source={message.content}
              compact
            />{/if}
        </div>
      {/if}
      {#if message.images?.length}
        <div class="message-images">
          {#each message.images as image}<img
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
            on:click={() => (thinkingOpen = !thinkingOpen)}
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
          {#each message.images as image}<img
              src={image.url}
              alt="Attachment"
              loading="lazy"
            />{/each}
        </div>
      {/if}
      {#if message.attachments?.length}
        <div class="message-attachments">
          {#each message.attachments as attachment}
            <span><ImageIcon size={15} /> {attachment.name}</span>
          {/each}
        </div>
      {/if}
      {#if message.tools?.length}
        <div class="tool-stack">
          {#each message.tools as tool (tool.id)}<ToolCard {tool} />{/each}
        </div>
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
              class="icon-action"
              aria-label="Copy message"
              title="Copy"
              on:click={() => navigator.clipboard.writeText(message.content)}
              ><Copy size={14} /></button
            >
          {/if}
        </div>
      {/if}
    </div>
  </article>
{/if}
