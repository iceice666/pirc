<script lang="ts">
  /**
   * One card of the composer dock (goal, tasks, queue): a header that toggles
   * the body, optional header actions, and the collapsible body.
   */
  import { ChevronDown } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { slide } from 'svelte/transition';

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
    <div id={bodyId} transition:slide={{ duration: 160 }}>
      {@render children()}
    </div>
  {/if}
</section>
