<script lang="ts">
  import { Check, ChevronRight, CircleAlert, LoaderCircle } from '@lucide/svelte';
  import type { ConversationMessage } from '../types';
  import { responseParts, responseSummary } from '../work';
  import { tr } from '../i18n.svelte';
  import Message from './Message.svelte';
  let { messages }: { messages: ConversationMessage[] } = $props();
  let open = $state(false);
  const parts = $derived(responseParts(messages));
  const summary = $derived(responseSummary(messages));
  const label = $derived(
    summary.thinking
      ? tr('Thinking…')
      : summary.status === 'running'
        ? tr('Running: {0}', [summary.latest?.name ?? tr('Working…')])
        : summary.count
          ? tr('Completed {0} operations', [summary.count])
          : tr('Activity details'),
  );
</script>

{#if parts.activity.length}
  <div class="response-activity">
    <button
      class="activity-toggle"
      type="button"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <ChevronRight class={open ? 'rotated' : ''} size={14} aria-hidden="true" />
      <span
        >{label}{#if summary.failed}
          · {tr('{0} failed', [summary.failed])}{/if}</span
      >
      {#if summary.status === 'running'}<LoaderCircle
          class="spin"
          size={15}
          aria-label={tr('Running')}
        />
      {:else if summary.failed}<CircleAlert size={15} aria-label={tr('Failed')} />
      {:else}<Check size={15} aria-label={tr('Done')} />{/if}
    </button>
    {#if open}
      <div class="activity-details">
        {#each parts.activity as message (message.id)}<Message {message} grouped />{/each}
      </div>
    {/if}
  </div>
{/if}
{#each parts.visible as message (message.id)}<Message {message} />{/each}

<style>
  .response-activity {
    margin: 4px 0 12px;
  }
  .activity-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 36px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--text-2);
    background: var(--bg-subtle);
    font: inherit;
    font-size: 13px;
    text-align: left;
  }
  .activity-toggle span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .activity-toggle :global(svg) {
    flex: none;
  }
  .activity-toggle :global(.rotated) {
    transform: rotate(90deg);
  }
  .activity-details {
    padding: 8px 0 0 12px;
    border-left: 1px solid var(--line);
  }
</style>
