<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';
  import { Check, ChevronRight, CircleAlert, LoaderCircle, Lock } from '@lucide/svelte';
  import type { ToolCall } from '../types';
  import { effectiveTools, summarizeRun, writeBlock } from '../work';

  interface Props {
    /** Every tool call the card stands for (its summary line). */
    tools: ToolCall[];
    /** The tool cards (or tool-only turns) shown when it is open. */
    children: Snippet;
  }

  let { tools, children }: Props = $props();

  const summary = $derived(summarizeRun(tools));
  const blocked = $derived(effectiveTools(tools).some((tool) => writeBlock(tool)));
  const title = $derived.by(() => {
    const names = new Set(effectiveTools(tools).map((tool) => tool.name));
    if (names.has('edit') || names.has('write')) return 'Made changes';
    if (names.has('bash')) return 'Ran commands';
    if (['read', 'grep', 'find', 'ls'].some((name) => names.has(name))) return 'Explored the code';
    return 'Used tools';
  });
  const seconds = $derived(
    summary.durationMs === undefined
      ? ''
      : summary.durationMs < 1000
        ? `${summary.durationMs} ms`
        : `${(summary.durationMs / 1000).toFixed(summary.durationMs < 10_000 ? 1 : 0)} s`,
  );
  const statusLabel = $derived(
    summary.status === 'running' ? 'Running' : summary.status === 'failed' ? 'Failed' : 'Done',
  );

  let open = $state(false);
  let userToggled = $state(false);
  // Like a tool card: a failure opens it so errors are never hidden behind a click.
  $effect.pre(() => {
    const failed = summary.status === 'failed';
    if (!untrack(() => userToggled)) open = failed;
  });
</script>

<div class="run-card" class:failed={summary.status === 'failed'} class:open>
  <button
    class="run-summary"
    type="button"
    aria-expanded={open}
    onclick={() => {
      userToggled = true;
      open = !open;
    }}
  >
    <ChevronRight class={open ? 'rotated' : ''} size={14} aria-hidden="true" />
    <strong>{title}</strong>
    <span class="run-meta">{summary.count} tools{seconds ? ` · ${seconds}` : ''}</span>
    <span class="run-files">
      {#each summary.files.slice(0, 3) as file (file)}<code>{file}</code>{/each}
      {#if summary.files.length > 3}<span>+{summary.files.length - 3}</span>{/if}
    </span>
    {#if blocked}<span class="run-blocked" title="A write was blocked by another session"
        ><Lock size={13} /></span
      >{/if}
    <span
      class="run-status"
      data-status={summary.status}
      role="img"
      aria-label={statusLabel}
      title={statusLabel}
    >
      {#if summary.status === 'running'}<LoaderCircle
          class="spin"
          size={15}
        />{:else if summary.status === 'failed'}<CircleAlert size={15} />{:else}<Check
          size={15}
        />{/if}
    </span>
  </button>
  {#if open}
    <div class="run-body">{@render children()}</div>
  {/if}
</div>

<style>
  .run-card {
    margin: 4px 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
  }
  .run-card.open {
    background: var(--bg);
  }
  .run-card.failed {
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .run-summary {
    width: 100%;
    min-height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border: 0;
    border-radius: inherit;
    color: var(--ink);
    background: transparent;
    font-size: 13px;
    text-align: left;
  }
  .run-summary:hover {
    background: var(--bg-hover);
  }
  .run-summary :global(svg) {
    flex: none;
    color: var(--muted);
    transition: transform 0.15s var(--ease);
  }
  .run-summary :global(.rotated) {
    transform: rotate(90deg);
  }
  .run-summary strong {
    flex: none;
    font-weight: 500;
  }
  .run-meta {
    flex: none;
    color: var(--muted);
    font-size: 12px;
  }
  .run-files {
    min-width: 0;
    flex: 1;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    overflow: hidden;
  }
  .run-files code,
  .run-files span {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--text-2);
    background: var(--bg-layer);
    font-family: var(--mono);
    font-size: 11px;
  }
  .run-blocked {
    display: grid;
  }
  .run-blocked :global(svg) {
    color: var(--warning);
  }
  .run-status {
    display: grid;
  }
  .run-status[data-status='succeeded'] :global(svg) {
    color: var(--success);
  }
  .run-status[data-status='failed'] :global(svg) {
    color: var(--danger);
  }
  .run-status[data-status='running'] :global(svg) {
    color: var(--accent);
  }
  .run-body {
    padding: 4px 8px 8px;
    border-top: 1px solid var(--line);
  }
  @media (max-width: 650px) {
    .run-files {
      display: none;
    }
    .run-summary strong {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }
</style>
