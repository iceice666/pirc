<script lang="ts">
  /**
   * The session goal, docked on top of the composer above the task list.
   * Collapsed, the header shows the objective, its phase and the rounds used;
   * expanded, the full objective, the blocked/paused reason and pause/resume.
   */
  import { Target } from '@lucide/svelte';
  import { loadLayout, saveLayout } from '../storage';
  import type { GoalView } from '../goal';
  import DockSection from './DockSection.svelte';

  interface Props {
    goal: GoalView;
    disabled?: boolean;
    /** Sends `/goal pause` or `/goal resume`. */
    onaction: (action: 'pause' | 'resume') => void;
  }

  let { goal, disabled = false, onaction }: Props = $props();

  let expanded = $state(loadLayout('goalExpanded', false));
  const persist = (open: boolean) => saveLayout('goalExpanded', open);

  let running = $derived(goal.phase === 'active' && !goal.disarmed);
  let phaseLabel = $derived(
    goal.disarmed
      ? 'Waiting for resume'
      : { active: 'Active', paused: 'Paused', blocked: 'Blocked', complete: 'Complete' }[
          goal.phase
        ],
  );
  let dot = $derived(
    running
      ? 'ongoing'
      : goal.phase === 'complete'
        ? 'done'
        : goal.phase === 'blocked'
          ? 'error'
          : 'idle',
  );
  let canResume = $derived(
    (goal.phase === 'paused' || goal.phase === 'blocked' || goal.disarmed) &&
      (goal.maxRounds === undefined || goal.rounds < goal.maxRounds),
  );
</script>

<DockSection label="Goal" class="goal-dock" bind:expanded ontoggle={persist}>
  {#snippet head()}
    <span class="todo-lead">
      {#if running}<span class="state-dot ongoing" aria-hidden="true"></span>{:else}<Target
          size={14}
        />{/if}
    </span>
    <span class="dock-title" class:active={running}>{goal.objective}</span>
    <span class="goal-phase phase-{goal.phase}" class:disarmed={goal.disarmed}>{phaseLabel}</span>
    <span class="todo-progress" title="Continuation rounds">
      {goal.rounds}{goal.maxRounds === undefined ? '' : `/${goal.maxRounds}`}
    </span>
  {/snippet}
  {#snippet actions()}
    {#if running}
      <button class="dock-action" type="button" {disabled} onclick={() => onaction('pause')}
        >Pause</button
      >
    {:else if canResume}
      <button class="dock-action" type="button" {disabled} onclick={() => onaction('resume')}
        >Resume</button
      >
    {/if}
  {/snippet}
  <div class="goal-body">
    <p class="goal-objective">{goal.objective}</p>
    {#if goal.reason}
      <p class="goal-reason">
        <span class="state-dot {dot}" aria-hidden="true"></span>{goal.reason}
      </p>
    {/if}
  </div>
</DockSection>

<style>
  .goal-phase {
    flex: none;
    padding: 0 6px;
    border-radius: 4px;
    color: var(--muted);
    background: var(--bg-hover);
    font-size: 11px;
    font-weight: 400;
    line-height: 18px;
  }
  .goal-phase.phase-active:not(.disarmed) {
    color: var(--accent);
  }
  .goal-phase.phase-complete {
    color: var(--success);
  }
  .goal-phase.phase-blocked,
  .goal-phase.disarmed {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .goal-body {
    max-height: 180px;
    padding: 0 14px 10px 32px;
    overflow-y: auto;
    color: var(--text-2);
    font-size: 13px;
    line-height: 20px;
  }
  .goal-objective {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .goal-reason {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 6px 0 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
</style>
