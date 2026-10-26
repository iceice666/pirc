<script lang="ts">
  import { onMount } from 'svelte';
  import { PanelLeftOpen, RefreshCw } from '@lucide/svelte';
  import { tr } from '../i18n.svelte';
  import { ApiError, isAbort } from '../http';
  import { uuid } from '../id';
  import {
    potsApi,
    potsTaskLabels,
    potsTaskTerminal,
    validPotsInstruction,
    type PotsTask,
    type PotsOverview,
    type ResponsibilityInput,
  } from '../pots';

  interface Props {
    sidebarCollapsed?: boolean;
    onexpand?: () => void;
    onopenchat: (id: string) => void;
  }
  let { sidebarCollapsed = false, onexpand, onopenchat }: Props = $props();
  let snapshot = $state<PotsOverview>();
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let purpose = $state('');
  let selected = $state<string[]>([]);
  let observations = $state<number | undefined>();
  let dispatches = $state<number | undefined>();
  let concurrency = $state<number | undefined>();
  let instructions = $state<Record<string, string>>({});
  let owner = '';
  let epoch = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  let now = $state(Date.now());
  let createAttempt: { spec: string; input: ResponsibilityInput } | undefined;

  function clearDraft() {
    purpose = '';
    instructions = {};
    selected = [];
    observations = undefined;
    dispatches = undefined;
    concurrency = undefined;
    createAttempt = undefined;
  }
  async function refresh(clearError = true) {
    const current = ++epoch;
    controller?.abort();
    controller = new AbortController();
    snapshot = undefined;
    loading = true;
    if (clearError) error = '';
    try {
      const next = await potsApi.overview(controller.signal);
      if (disposed || current !== epoch) return;
      if (owner && owner !== next.accountKey) clearDraft();
      owner = next.accountKey;
      snapshot = next;
    } catch (cause) {
      if (!disposed && current === epoch && !isAbort(cause))
        error = tr('Unable to load pots. Refresh to try again.');
    } finally {
      if (!disposed && current === epoch) loading = false;
    }
  }
  async function act(operation: () => Promise<unknown>, created = false) {
    if (busy || loading || !snapshot) return;
    busy = true;
    error = '';
    const current = epoch;
    try {
      await operation();
      if (!disposed && current === epoch && created) clearDraft();
    } catch (cause) {
      if (!disposed && current === epoch) {
        error =
          cause instanceof ApiError && cause.status === 409
            ? tr('Pots changed on another device. Refreshed; review before trying again.')
            : cause instanceof ApiError && cause.code === 'not_ready'
              ? tr('Dispatch is not ready. No execution session was started.')
              : tr('Pots request failed. Refresh and review before trying again.');
      }
    } finally {
      if (!disposed) {
        busy = false;
        await refresh(false);
      }
    }
  }
  const valid = $derived(
    purpose.trim().length > 0 &&
      purpose.length <= 2000 &&
      selected.length > 0 &&
      selected.length <= 32 &&
      Number.isInteger(observations) &&
      observations! >= 1 &&
      observations! <= 1000000 &&
      Number.isInteger(dispatches) &&
      dispatches! >= 0 &&
      dispatches! <= 1000000 &&
      Number.isInteger(concurrency) &&
      concurrency! >= 1 &&
      concurrency! <= 32,
  );
  function create(event: SubmitEvent) {
    event.preventDefault();
    if (!valid) return;
    const spec = JSON.stringify({
      purpose: purpose.trim(),
      scopes: selected.map((workspaceId) => ({ workspaceId, access: 'progress' as const })),
      budgets: { observations: observations!, dispatches: dispatches!, concurrency: concurrency! },
    });
    if (createAttempt?.spec !== spec)
      createAttempt = { spec, input: { ...JSON.parse(spec), idempotencyKey: uuid() } };
    const input = createAttempt.input;
    void act(() => potsApi.create(input), true);
  }
  function start(task: PotsTask) {
    const instruction = instructions[task.id] ?? '';
    if (
      !snapshot?.tasks.includes(task) ||
      !snapshot.executionAvailable ||
      task.status !== 'tracked' ||
      task.coordinationPaused ||
      task.takenOver ||
      task.executionSessionId ||
      task.execution ||
      !validPotsInstruction(instruction)
    )
      return;
    void act(() => potsApi.start(task, instruction));
  }
  onMount(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    const clock = window.setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(clock);
      ++epoch;
      controller?.abort();
      window.removeEventListener('focus', focus);
    };
  });
</script>

<section class="pots-page" aria-label={tr('pots')}>
  <header>
    {#if sidebarCollapsed}<button
        type="button"
        class="button ghost"
        aria-label={tr('Show sidebar')}
        onclick={onexpand}><PanelLeftOpen size={18} /></button
      >{/if}
    <h1>{tr('pots')}</h1>
    <button type="button" class="button ghost" disabled={busy} onclick={() => refresh()}
      ><RefreshCw size={16} />{tr('Refresh')}</button
    >
  </header>
  <p>{tr('Your personal coordinator. Suggestions are not instructions or permission to act.')}</p>
  <p class="notice">
    {tr(
      'Progress events only: no transcript reading. Execution requires your explicit instruction and Start.',
    )}
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}<p role="status">{tr('Loading…')}</p>
  {:else if snapshot}
    <section aria-labelledby="responsibilities-title">
      <h2 id="responsibilities-title">{tr('Responsibilities')}</h2>
      <form onsubmit={create}>
        <label
          ><span>{tr('Purpose')}</span><textarea maxlength="2000" bind:value={purpose} required
          ></textarea></label
        >
        <fieldset disabled={busy}>
          <legend>{tr('Selected workspaces — progress only')}</legend>
          {#each snapshot.workspaces as workspace (workspace.id)}
            <label class="check"
              ><input
                type="checkbox"
                bind:group={selected}
                value={workspace.id}
              />{workspace.name}</label
            >
          {:else}<p>{tr('No workspaces available.')}</p>{/each}
        </fieldset>
        <div class="budgets">
          <label
            ><span>{tr('Observation budget')}</span><input
              type="number"
              min="1"
              max="1000000"
              step="1"
              bind:value={observations}
              required
            /></label
          >
          <label
            ><span>{tr('Dispatch budget (0 disables dispatch)')}</span><input
              type="number"
              min="0"
              max="1000000"
              step="1"
              bind:value={dispatches}
              required
            /></label
          >
          <label
            ><span>{tr('Concurrency limit')}</span><input
              type="number"
              min="1"
              max="32"
              step="1"
              bind:value={concurrency}
              required
            /></label
          >
        </div>
        <p>
          {tr(
            'Saving does not activate observation. Activate explicitly after reviewing scopes and budgets.',
          )}
        </p>
        <button class="button primary" disabled={busy || !valid}
          >{tr('Save disabled responsibility')}</button
        >
      </form>
      {#each snapshot.responsibilities as responsibility (responsibility.id)}
        <article aria-label={responsibility.purpose}>
          <h3>{responsibility.purpose}</h3>
          <p>
            {tr(responsibility.enabled ? 'Enabled' : 'Disabled')} · {tr(
              responsibility.observationPaused ? 'Observation paused' : 'Observation unpaused',
            )} · {tr(
              responsibility.coordinationPaused ? 'Coordination paused' : 'Coordination unpaused',
            )}
          </p>
          <p>
            {responsibility.scopes
              .map(
                (scope) =>
                  snapshot!.workspaces.find((w) => w.id === scope.workspaceId)?.name ??
                  scope.workspaceId,
              )
              .join(', ')}
          </p>
          <p>
            {tr('Observed {0}/{1} · dispatched {2}/{3} · concurrency {4}', [
              responsibility.observationsUsed,
              responsibility.budgets.observations,
              responsibility.dispatchesUsed,
              responsibility.budgets.dispatches,
              responsibility.budgets.concurrency,
            ])}
          </p>
          <div class="actions">
            <button
              type="button"
              class="button"
              disabled={busy}
              onclick={() =>
                act(() =>
                  potsApi.responsibility(
                    responsibility,
                    responsibility.enabled ? 'disable' : 'activate',
                  ),
                )}>{tr(responsibility.enabled ? 'Disable' : 'Activate observation')}</button
            >
            <button
              type="button"
              class="button"
              disabled={busy || !responsibility.enabled}
              onclick={() =>
                act(() =>
                  potsApi.responsibility(
                    responsibility,
                    responsibility.observationPaused ? 'resume_observation' : 'pause_observation',
                  ),
                )}
              >{tr(
                responsibility.observationPaused ? 'Resume observation' : 'Pause observation',
              )}</button
            >
            <button
              type="button"
              class="button"
              disabled={busy || !responsibility.enabled}
              onclick={() =>
                act(() =>
                  potsApi.responsibility(
                    responsibility,
                    responsibility.coordinationPaused
                      ? 'resume_coordination'
                      : 'pause_coordination',
                  ),
                )}
              >{tr(
                responsibility.coordinationPaused ? 'Resume coordination' : 'Pause coordination',
              )}</button
            >
          </div>
        </article>
      {:else}<p>
          {tr(
            'No responsibilities. Nothing is observed until you explicitly configure and activate one.',
          )}
        </p>{/each}
    </section>
    <section aria-labelledby="suggestions-title">
      <h2 id="suggestions-title">{tr('Suggestions from pots')}</h2>
      <p>
        {tr(
          'Reading a suggestion never accepts it. Track only creates a task, not an execution session.',
        )}
      </p>
      {#each snapshot.suggestions as suggestion (suggestion.id)}
        <article aria-label={tr('Suggestion from pots')}>
          <h3>
            {tr(
              suggestion.disposition === 'superseded'
                ? 'Earlier session input request — recheck the source.'
                : suggestion.disposition === 'needs_refresh' || suggestion.evidence.expiresAt <= now
                  ? 'Suggestion needs a freshness check.'
                  : 'Session needs your input',
            )}
          </h3>
          <p>{tr('From pots')} · {tr(suggestion.disposition)}</p>
          <p>
            {tr('Evidence: workspace {0} · session {1} · epoch {2}', [
              suggestion.evidence.workspaceId,
              suggestion.evidence.sessionId,
              suggestion.evidence.runnerEpoch,
            ])}
          </p>
          {#if suggestion.snoozedUntil}<p>
              {tr('Snoozed until {0}', [new Date(suggestion.snoozedUntil).toLocaleString()])}
            </p>{/if}
          <div class="actions">
            <button
              type="button"
              class="button"
              onclick={() => onopenchat(suggestion.targetSessionId)}
              >{tr('Review source conversation')}</button
            >
            {#if (suggestion.disposition === 'pending' || suggestion.disposition === 'snoozed') && suggestion.evidence.expiresAt > now}
              <button
                type="button"
                class="button"
                disabled={busy ||
                  (suggestion.snoozedUntil !== null && suggestion.snoozedUntil > now)}
                onclick={() => act(() => potsApi.track(suggestion))}>{tr('Track only')}</button
              >
              <button
                type="button"
                class="button"
                disabled={busy}
                onclick={() =>
                  act(() =>
                    potsApi.suggestion(suggestion, { type: 'snooze', until: Date.now() + 3600000 }),
                  )}>{tr('Snooze 1 hour')}</button
              >
              <button
                type="button"
                class="button"
                disabled={busy}
                onclick={() => act(() => potsApi.suggestion(suggestion, { type: 'dismiss' }))}
                >{tr('Dismiss')}</button
              >
            {/if}
          </div>
        </article>
      {:else}<p>{tr('No suggestions.')}</p>{/each}
    </section>
    <section aria-labelledby="tasks-title">
      <h2 id="tasks-title">{tr('Tracked tasks')}</h2>
      {#each snapshot.tasks as task (task.id)}
        <article aria-label={task.id}>
          <h3>{tr('Review session input')}</h3>
          <p>{tr(potsTaskLabels[task.status] ?? task.status)} · {task.id}</p>
          <p>
            {task.takenOver
              ? tr(
                  'Taken over by you; pots coordination is fenced. Already-running execution continues.',
                )
              : tr(task.coordinationPaused ? 'Coordination paused' : 'Coordination unpaused')}
          </p>
          <p>{tr('Origin suggestion: {0}', [task.originSuggestionId])}</p>
          <p>
            {task.executionSessionId
              ? tr('Execution session: {0}', [task.executionSessionId])
              : task.status === 'tracked' || (task.status === 'stopped' && !task.execution)
                ? tr('No execution session. Tracking is not running.')
                : tr(
                    'Execution session not yet confirmed. Refresh to check current state; do not assume it is stopped.',
                  )}
          </p>
          {#if task.outcome}<p>{tr('Outcome: {0}', [task.outcome])}</p>{/if}
          {#if task.failure}<p role="status">{tr('Failure: {0}', [task.failure])}</p>{/if}
          {#if task.execution}
            <p>{tr('Authorized instruction: {0}', [task.execution.instruction])}</p>
          {:else if task.status === 'tracked'}
            <p>
              {tr(
                'Start authorizes one execution in a new session in the same workspace, using only your instruction. No source transcript or approval is copied or answered. The instruction cannot be changed after Start.',
              )}
            </p>
            <label
              ><span>{tr('Execution instruction')}</span><textarea
                bind:value={instructions[task.id]}
                disabled={busy || task.coordinationPaused || task.takenOver}
                required
              ></textarea></label
            >
            <p>{tr('Instruction must be 1–20000 UTF-8 bytes.')}</p>
            <p>
              {tr(
                'Start requires an enabled responsibility with coordination unpaused, dispatch budget remaining and a concurrency slot. Pausing coordination does not stop already-running execution.',
              )}
            </p>
            <button
              type="button"
              class="button"
              disabled={busy ||
                !snapshot.executionAvailable ||
                task.coordinationPaused ||
                task.takenOver ||
                !validPotsInstruction(instructions[task.id] ?? '')}
              onclick={() => start(task)}
              >{tr(snapshot.executionAvailable ? 'Start' : 'Start unavailable')}</button
            >
          {/if}
          <div class="actions">
            <button
              type="button"
              class="button"
              disabled={busy ||
                potsTaskTerminal(task) ||
                task.status === 'stopping' ||
                task.takenOver}
              onclick={() => act(() => potsApi.task(task, 'take_over'))}>{tr('Take over')}</button
            >
            <button
              type="button"
              class="button"
              disabled={busy ||
                potsTaskTerminal(task) ||
                task.status === 'stopping' ||
                task.takenOver}
              onclick={() =>
                act(() =>
                  potsApi.task(
                    task,
                    task.coordinationPaused ? 'resume_coordination' : 'pause_coordination',
                  ),
                )}
              >{tr(task.coordinationPaused ? 'Resume coordination' : 'Pause coordination')}</button
            >
            <button
              type="button"
              class="button"
              disabled={busy || potsTaskTerminal(task) || task.status === 'stopping'}
              onclick={() => act(() => potsApi.task(task, 'stop'))}
              >{tr(
                task.execution || task.executionSessionId ? 'Stop execution' : 'Stop tracking',
              )}</button
            >
            {#if task.executionSessionId}
              <button
                type="button"
                class="button"
                onclick={() => onopenchat(task.executionSessionId!)}
                >{tr('Open execution session')}</button
              >
            {/if}
          </div>
        </article>
      {:else}<p>{tr('No tracked tasks.')}</p>{/each}
    </section>
    <p class="notice">
      {tr('Lists show at most 100 records per category. Refresh to see current state.')}
    </p>
  {/if}
</section>

<style>
  .pots-page {
    overflow-y: auto;
    padding: 24px;
    width: 100%;
  }
  header,
  .actions,
  .budgets {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  header h1 {
    flex: 1;
    margin: 0;
  }
  section section {
    margin-top: 28px;
  }
  article,
  form {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin: 12px 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 8px 0;
  }
  label.check {
    flex-direction: row;
    align-items: center;
  }
  textarea {
    min-height: 70px;
    resize: vertical;
  }
  textarea,
  input[type='number'] {
    background: var(--bg);
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 8px;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 5px;
    margin: 12px 0;
  }
  p {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .notice {
    opacity: 0.75;
  }
  [role='alert'] {
    color: var(--danger, #c44);
  }
  h3 {
    margin-top: 0;
  }
  @media (max-width: 600px) {
    .pots-page {
      padding: 14px;
    }
    .budgets {
      display: block;
    }
  }
</style>
