<script lang="ts">
  import { Bot, Copy, Image as ImageIcon, RotateCcw } from '@lucide/svelte';
  import type { ConversationMessage } from '../types';
  import ToolCard from './ToolCard.svelte';

  export let message: ConversationMessage;

  function time(date: string) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<article
  class:user={message.role === 'user'}
  class:system={message.role === 'system'}
  class="message"
>
  <div class="message-gutter">
    {#if message.role === 'assistant'}<span class="agent-avatar"><Bot size={16} /></span
      >{:else if message.role === 'user'}<span class="user-avatar">You</span>{/if}
  </div>
  <div class="message-main">
    <header>
      <strong
        >{message.role === 'assistant' ? 'Pi' : message.role === 'user' ? 'You' : 'System'}</strong
      ><time datetime={message.createdAt}>{time(message.createdAt)}</time>
    </header>
    <div class="message-copy">
      {message.content}{#if message.isPartial}<span class="stream-cursor" aria-label="Streaming"
        ></span>{/if}
    </div>
    {#if message.attachments?.length}
      <div class="message-attachments">
        {#each message.attachments as attachment}
          <span><ImageIcon size={15} /> {attachment.name}</span>
        {/each}
      </div>
    {/if}
    {#if message.tools?.length}
      <div class="tool-stack">
        {#each message.tools as tool}<ToolCard {tool} />{/each}
      </div>
    {/if}
    {#if message.role === 'assistant' && !message.isPartial}
      <div class="message-actions">
        <button
          type="button"
          aria-label="Copy response"
          title="Copy response"
          on:click={() => navigator.clipboard.writeText(message.content)}
          ><Copy size={14} /> Copy</button
        >
        <button type="button" aria-label="Retry response" title="Retry response"
          ><RotateCcw size={14} /> Retry</button
        >
      </div>
    {/if}
  </div>
</article>
