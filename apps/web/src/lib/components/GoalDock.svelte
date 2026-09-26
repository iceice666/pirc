<script lang="ts">
  /**
   * The session goal, docked on top of the composer above the task list.
   * Collapsed, the header shows the objective, its phase and the rounds used;
   * expanded, the full objective, the blocked/paused reason and pause/resume.
   */
  import { ChevronDown, Target } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { loadLayout, saveLayout } from '../storage';
  import type { GoalView } from '../goal';

  export let goal: GoalView;
  export let disabled = false;
  /** Sends `/goal pause` or `/goal resume`. */
  export let onaction: (action: 'pause' | 'resume') => void;

  let expanded = loadLayout('goalExpanded', false);
  $: saveLayout('goalExpanded', expanded);

  $: running = goal.phase === 'active' && !goal.disarmed;
  $: phaseLabel = goal.disarmed
    ? 'Waiting for resume'
    : { active: 'Active', paused: 'Paused', blocked: 'Blocked', complete: 'Complete' }[goal.phase];
  $: dot = running
    ? 'ongoing'
    : goal.phase === 'complete'
      ? 'done'
      : goal.phase === 'blocked'
        ? 'error'
        : 'idle';
  $: canResume =
    (goal.phase === 'paused' || goal.phase === 'blocked' || goal.disarmed) &&
    (goal.maxRounds === undefined || goal.rounds < goal.maxRounds);
</script>

<section class="dock-section goal-dock" aria-label="Goal">
  <div class="dock-head">
    <button
      class="dock-toggle"
      type="button"
      aria-expanded={expanded}
      aria-controls="goal-dock-body"
      on:click={() => (expanded = !expanded)}
    >
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
      <span class:collapsed={!expanded} class="dock-chevron"><ChevronDown size={14} /></span>
    </button>
    {#if running}
      <button class="dock-action" type="button" {disabled} on:click={() => onaction('pause')}
        >Pause</button
      >
    {:else if canResume}
      <button class="dock-action" type="button" {disabled} on:click={() => onaction('resume')}
        >Resume</button
      >
    {/if}
  </div>
  {#if expanded}
    <div id="goal-dock-body" class="goal-body" transition:slide={{ duration: 160 }}>
      <p class="goal-objective">{goal.objective}</p>
      {#if goal.reason}
        <p class="goal-reason">
          <span class="state-dot {dot}" aria-hidden="true"></span>{goal.reason}
        </p>
      {/if}
    </div>
  {/if}
</section>
