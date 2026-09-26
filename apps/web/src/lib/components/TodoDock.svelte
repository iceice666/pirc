<script lang="ts">
  /**
   * The agent's task list, docked on top of the composer (as in Codex and
   * DeepSeek Harness). Collapsed, the header names the task in progress and
   * the progress count; expanded, it lists every task with a status dot.
   */
  import { ChevronDown, ListChecks } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { loadLayout, saveLayout } from '../storage';
  import type { TodoItem, TodoList } from '../todo';

  export let list: TodoList;

  let expanded = loadLayout('todoExpanded', false);
  $: saveLayout('todoExpanded', expanded);

  $: active = list.items.filter((item) => item.status === 'in_progress');
  $: allDone = list.total > 0 && list.done === list.total;
  $: headline = active.length
    ? active[0]!.text + (active.length > 1 ? ` +${active.length - 1}` : '')
    : allDone
      ? 'All tasks completed'
      : 'Tasks';

  const label: Record<TodoItem['status'], string> = {
    completed: 'Completed',
    in_progress: 'In progress',
    pending: 'Pending',
  };
</script>

<section class="dock-section todo-dock" aria-label="Tasks">
  <div class="dock-head">
    <button
      class="dock-toggle"
      type="button"
      aria-expanded={expanded}
      aria-controls="todo-dock-list"
      on:click={() => (expanded = !expanded)}
    >
      <span class="todo-lead">
        {#if active.length}<span class="state-dot ongoing" aria-hidden="true"
          ></span>{:else}<ListChecks size={14} />{/if}
      </span>
      <span class="dock-title" class:active={active.length > 0}>{headline}</span>
      <span class="todo-progress" aria-label="{list.done} of {list.total} completed">
        <span class="todo-meter"
          ><span style:width="{list.total ? (list.done / list.total) * 100 : 0}%"></span></span
        >
        {list.done}/{list.total}
      </span>
      <span class:collapsed={!expanded} class="dock-chevron"><ChevronDown size={14} /></span>
    </button>
  </div>
  {#if expanded}
    <ol id="todo-dock-list" class="dock-list todo-list" transition:slide={{ duration: 160 }}>
      {#each list.items as item, index (index)}
        <li class="todo-item status-{item.status}">
          <span
            class="state-dot {item.status === 'completed'
              ? 'done'
              : item.status === 'in_progress'
                ? 'ongoing'
                : 'idle'}"
            role="img"
            aria-label={label[item.status]}
          ></span>
          <span class="todo-text">{item.text}</span>
          {#if item.category}<span class="todo-tag">{item.category}</span>{/if}
          {#if item.blocked}<span class="todo-tag blocked">blocked</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
