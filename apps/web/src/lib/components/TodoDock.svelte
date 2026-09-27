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

<style>
  .todo-meter {
    width: 36px;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--line-dark);
  }
  .todo-meter > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--success);
    transition: width 0.3s var(--ease);
  }
  .todo-list {
    max-height: 220px;
    display: grid;
    gap: 1px;
  }
  .todo-item {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 4px 6px;
    color: var(--text-2);
    font-size: 13px;
    line-height: 20px;
  }
  .todo-item .state-dot {
    margin: 0 3px;
  }
  .todo-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .todo-item.status-in_progress {
    color: var(--ink);
    font-weight: 500;
  }
  .todo-item.status-completed .todo-text {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: var(--faint);
  }
  .todo-tag {
    flex: none;
    padding: 0 6px;
    border-radius: 4px;
    color: var(--muted);
    background: var(--bg-hover);
    font-size: 11px;
    font-weight: 400;
    line-height: 18px;
  }
  .todo-tag.blocked {
    color: var(--warning);
    background: var(--warning-soft);
  }
  @media (max-width: 650px) {
    .todo-list {
      max-height: 160px;
    }
  }
</style>
