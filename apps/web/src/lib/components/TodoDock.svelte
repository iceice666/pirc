<script lang="ts">
  /**
   * The agent's task list, docked on top of the composer (as in Codex and
   * DeepSeek Harness). Collapsed, the header names the task in progress and
   * the progress count; expanded, it lists every task with a status dot.
   */
  import { ListChecks } from '@lucide/svelte';
  import { loadLayout, saveLayout } from '../storage';
  import type { TodoItem, TodoList } from '../todo';
  import DockSection from './DockSection.svelte';

  interface Props {
    list: TodoList;
  }

  let { list }: Props = $props();

  let expanded = $state(loadLayout('todoExpanded', false));
  const persist = (open: boolean) => saveLayout('todoExpanded', open);

  let active = $derived(list.items.filter((item) => item.status === 'in_progress'));
  let allDone = $derived(list.total > 0 && list.done === list.total);
  let headline = $derived(
    active.length
      ? active[0]!.text + (active.length > 1 ? ` +${active.length - 1}` : '')
      : allDone
        ? 'All tasks completed'
        : 'Tasks',
  );

  /** Items have no id; key by text (numbered when repeated) so rows follow reorders. */
  let keyed = $derived.by(() => {
    const seen = new Map<string, number>();
    return list.items.map((item) => {
      const count = seen.get(item.text) ?? 0;
      seen.set(item.text, count + 1);
      return { item, key: `${item.text}\u0000${count}` };
    });
  });

  const label: Record<TodoItem['status'], string> = {
    completed: 'Completed',
    in_progress: 'In progress',
    pending: 'Pending',
  };
</script>

<DockSection label="Tasks" class="todo-dock" bind:expanded ontoggle={persist}>
  {#snippet head()}
    <span class="todo-lead">
      {#if active.length}<span class="state-dot ongoing" aria-hidden="true"
        ></span>{:else}<ListChecks size={14} />{/if}
    </span>
    <span class="dock-title" class:active={active.length > 0}>{headline}</span>
    <span class="todo-progress" role="img" aria-label="{list.done} of {list.total} completed">
      <span class="todo-meter"
        ><span style:width="{list.total ? (list.done / list.total) * 100 : 0}%"></span></span
      >
      {list.done}/{list.total}
    </span>
  {/snippet}
  <ol class="dock-list todo-list">
    {#each keyed as { item, key } (key)}
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
</DockSection>
