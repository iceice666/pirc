<script lang="ts">
  import { Check, ChevronDown, CircleAlert, LoaderCircle, Terminal } from '@lucide/svelte';
  import type { ToolCall } from '../types';

  export let tool: ToolCall;
  let open = false;

  $: statusLabel =
    tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Done';
  $: payload = tool.output ?? (tool.input === undefined ? '' : JSON.stringify(tool.input, null, 2));
</script>

<div
  class:failed={tool.status === 'failed'}
  class:running={tool.status === 'running'}
  class="tool-card"
>
  <button class="tool-summary" type="button" on:click={() => (open = !open)} aria-expanded={open}>
    <span class="tool-icon" aria-hidden="true"><Terminal size={15} strokeWidth={1.8} /></span>
    <span class="tool-name">
      <strong>{tool.title ?? tool.name}</strong>
      <span>{statusLabel}</span>
    </span>
    <span class="tool-status" aria-label={statusLabel}>
      {#if tool.status === 'running'}
        <LoaderCircle class="spin" size={15} />
      {:else if tool.status === 'failed'}
        <CircleAlert size={15} />
      {:else}
        <Check size={15} />
      {/if}
    </span>
    <ChevronDown class={open ? 'rotated' : ''} size={16} aria-hidden="true" />
  </button>
  {#if open}
    <div class="tool-content">
      {#if payload}<pre>{payload}</pre>{:else}<p>No output returned.</p>{/if}
    </div>
  {/if}
</div>
