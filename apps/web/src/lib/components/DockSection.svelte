<script lang="ts">
  /**
   * One card of the composer dock (goal, tasks, queue): a header that toggles
   * the body, optional header actions, and the collapsible body.
   */
  import { ChevronDown } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { slide } from 'svelte/transition';
  import { motion } from '../motion';
  import './dock.css';

  interface Props {
    /** Accessible name of the section. */
    label: string;
    class?: string;
    expanded: boolean;
    /** Called after the header toggles (e.g. to persist the choice). */
    ontoggle?: (expanded: boolean) => void;
    /** Header content inside the toggle button, before the chevron. */
    head: Snippet;
    /** Buttons after the toggle (e.g. Pause, Clear). */
    actions?: Snippet;
    children: Snippet;
  }

  let {
    label,
    class: className = '',
    expanded = $bindable(),
    ontoggle,
    head,
    actions,
    children,
  }: Props = $props();

  const bodyId = $props.id();

  function toggle() {
    expanded = !expanded;
    ontoggle?.(expanded);
  }
</script>

<section class="dock-section {className}" aria-label={label}>
  <div class="dock-head">
    <button
      class="dock-toggle"
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      onclick={toggle}
    >
      {@render head()}
      <span class:collapsed={!expanded} class="dock-chevron"><ChevronDown size={14} /></span>
    </button>
    {@render actions?.()}
  </div>
  {#if expanded}
    <div id={bodyId} transition:slide={{ duration: motion(160) }}>
      {@render children()}
    </div>
  {/if}
</section>

<style>
  :global(.dock-section) + .dock-section {
    border-top: 1px solid var(--line-dark);
  }
  .dock-head {
    height: 34px;
    display: flex;
    align-items: center;
    padding: 0 6px 0 4px;
  }
  .dock-toggle {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 12.5px;
    font-weight: 500;
  }
  .dock-toggle {
    flex: 1;
    min-width: 0;
  }
  @media (hover: none) {
    .dock-head {
      height: 44px;
    }
    .dock-toggle {
      height: 40px;
    }
  }
  .dock-toggle:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .dock-chevron {
    flex: none;
    display: grid;
    color: var(--muted);
    transition: transform 0.18s var(--ease);
  }
  .dock-chevron.collapsed {
    transform: rotate(180deg);
  }
</style>
