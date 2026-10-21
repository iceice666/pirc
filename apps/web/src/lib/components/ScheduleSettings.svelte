<script lang="ts">
  import { tr } from '../i18n.svelte';

  /**
   * Scheduled tasks (docs/guides/schedules.md): prompts that run in a new session at set
   * times. Make, change, pause and delete them here; see each run and open
   * its session; allow or dismiss runs the gateway could not start on time.
   */
  import { onMount } from 'svelte';
  import { api } from '../api';
  import { app } from '../app.svelte';
  import { ApiError } from '../http';
  import {
    CRON_PRESETS,
    NOTIFY_LABELS,
    RUN_LABELS,
    deviceTimezone,
    describeWhen,
    formatWall,
    schedulesApi,
    timezones,
    until,
    wallInput,
    type NotifyLevel,
    type Schedule,
    type ScheduleInput,
    type ScheduleRun,
  } from '../schedules';
  import { ago } from '../time';
  import { modelKey, type ModelOption, type ThinkingLevel } from '../types';
  import { watch } from '../watch.svelte';

  interface Props {
    disabled?: boolean;
    createOnMount?: boolean;
    initialScheduleId?: string;
    /** Open a run's session (the dialog closes). */
    onopenchat?: (sessionId: string) => void;
  }

  let { disabled = false, createOnMount = false, initialScheduleId, onopenchat }: Props = $props();

  const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  interface Form {
    workspaceId: string;
    title: string;
    prompt: string;
    mode: 'repeat' | 'once';
    cron: string;
    at: string;
    timezone: string;
    /** `modelKey` of the chosen model; empty for the default. */
    model: string;
    thinking: ThinkingLevel | '';
    notify: NotifyLevel;
  }

  let schedules: Schedule[] = $state([]);
  let loading = $state(true);
  /** Key of the action in flight; one at a time. */
  let busy = $state('');
  let error = $state('');
  /** Schedule whose Delete awaits a second click. */
  let confirming: string | undefined = $state();
  /** Schedule whose runs are shown, and its runs. */
  let expanded: string | undefined = $state();
  let runs: ScheduleRun[] = $state([]);
  /** `new`, or the id of the schedule being edited. */
  let editing: string | undefined = $state();
  let form: Form = $state(blank());
  let formError = $state('');
  let models: ModelOption[] = $state([]);
  let alive = true;
  const zones = timezones();

  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : tr('Unable to reach the gateway. Try again.');
  /** Workspaces on nodes: schedules run there, never in this browser. */
  const workspaces = $derived(
    app.workspaces
      .filter((workspace) => workspace.id.includes(':'))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );
  const workspaceLabel = (id: string) => {
    const workspace = app.workspaces.find((item) => item.id === id);
    return workspace ? `${workspace.displayName} · ${workspace.hostId}` : id;
  };

  /** "Test · work · offline · model-a · thinking high" */
  const whereOf = (schedule: Schedule) =>
    [
      schedule.workspace.name,
      schedule.workspace.node,
      schedule.workspace.online ? '' : tr('offline'),
      schedule.model?.id,
      schedule.thinking ? tr('Thinking: {0}', [tr(schedule.thinking)]) : '',
      schedule.notify === 'none'
        ? tr('no notifications')
        : schedule.notify === 'problems'
          ? tr('notifies on problems')
          : '',
    ]
      .filter(Boolean)
      .join(' · ');
  /** "Next 2026-09-30 09:00 (in 3h) · last completed 2h ago · proposed by your assistant" */
  const statusOf = (schedule: Schedule) =>
    [
      schedule.status === 'active' && schedule.nextRunAt !== null
        ? tr('Next {0} ({1})', [
            formatWall(schedule.nextRunAt, schedule.timezone),
            until(schedule.nextRunAt),
          ])
        : tr('No next run'),
      schedule.lastRun
        ? tr('Last: {0} {1}', [
            tr(RUN_LABELS[schedule.lastRun.status]),
            ago(schedule.lastRun.createdAt),
          ])
        : '',
      schedule.createdBySession ? tr('proposed by your assistant') : '',
    ]
      .filter(Boolean)
      .join(' · ');

  function blank(): Form {
    return {
      workspaceId: '',
      title: '',
      prompt: '',
      mode: 'repeat',
      cron: '0 9 * * *',
      at: '',
      timezone: deviceTimezone(),
      model: '',
      thinking: '',
      notify: 'all',
    };
  }

  function show(list: Schedule[]) {
    schedules = list;
    // A notification was about this one: open its runs.
    const focus = app.scheduleFocus;
    if (focus && list.some((item) => item.id === focus)) {
      app.scheduleFocus = undefined;
      expanded = focus;
    }
    app.scheduleAttention = list.reduce((sum, item) => sum + item.attention, 0);
    confirming = undefined;
    if (expanded && !list.some((item) => item.id === expanded)) expanded = undefined;
    else if (expanded) void loadRuns(expanded);
  }

  async function load() {
    try {
      const next = await schedulesApi.list();
      if (alive) show(next.schedules);
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  async function loadRuns(id: string) {
    try {
      const next = await schedulesApi.get(id);
      if (alive && expanded === id) runs = next.runs;
    } catch (cause) {
      if (alive) error = message(cause);
    }
  }

  /** Run one change, then reload the list (the gateway's view is the truth). */
  async function act(key: string, run: () => Promise<unknown>) {
    if (busy) return;
    busy = key;
    error = '';
    try {
      await run();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = '';
      if (alive) await load();
    }
  }

  function toggleRuns(schedule: Schedule) {
    if (expanded === schedule.id) {
      expanded = undefined;
      return;
    }
    expanded = schedule.id;
    runs = [];
    void loadRuns(schedule.id);
  }

  async function loadModels() {
    try {
      const list = await api.models();
      if (alive) models = list.filter((model) => model.available);
    } catch {
      /* the default model still works */
    }
  }

  function startNew() {
    form = blank();
    form.workspaceId =
      workspaces.find((workspace) => workspace.id === app.activeWorkspace?.id)?.id ??
      workspaces[0]?.id ??
      '';
    form.at = wallInput(Date.now() + 3_600_000, form.timezone);
    formError = '';
    editing = 'new';
    void loadModels();
  }

  function startEdit(schedule: Schedule) {
    form = {
      workspaceId: schedule.workspaceId,
      title: schedule.title,
      prompt: schedule.prompt,
      mode: schedule.cron !== null ? 'repeat' : 'once',
      cron: schedule.cron ?? '0 9 * * *',
      at: wallInput(schedule.runAt ?? Date.now() + 3_600_000, schedule.timezone),
      timezone: schedule.timezone,
      model: schedule.model ? modelKey(schedule.model) : '',
      thinking: schedule.thinking ?? '',
      notify: schedule.notify ?? 'all',
    };
    formError = '';
    editing = schedule.id;
    void loadModels();
  }

  async function save() {
    if (busy || !editing) return;
    const chosen = models.find((model) => modelKey(model) === form.model);
    const current = schedules.find((item) => item.id === editing);
    // Keep a model this list no longer offers rather than silently dropping it.
    const model = form.model
      ? chosen
        ? { provider: chosen.provider, id: chosen.id }
        : (current?.model ?? null)
      : null;
    const input: ScheduleInput = {
      workspaceId: form.workspaceId,
      title: form.title.trim(),
      prompt: form.prompt,
      timezone: form.timezone.trim(),
      model,
      thinking: form.thinking || null,
      notify: form.notify,
      ...(form.mode === 'repeat' ? { cron: form.cron.trim() } : { at: form.at }),
    };
    busy = 'save';
    formError = '';
    try {
      if (editing === 'new') await schedulesApi.create(input);
      else await schedulesApi.update(editing, input);
      if (!alive) return;
      editing = undefined;
      await load();
    } catch (cause) {
      if (alive) formError = message(cause);
    } finally {
      busy = '';
    }
  }

  function openRun(run: ScheduleRun) {
    if (run.sessionId) onopenchat?.(run.sessionId);
  }

  onMount(() => {
    if (disabled) loading = false;
    else
      void (async () => {
        await load();
        if (!alive) return;
        if (createOnMount) {
          startNew();
          return;
        }
        if (!initialScheduleId) return;
        let selected = schedules.find((item) => item.id === initialScheduleId);
        if (!selected) {
          try {
            const detail = await schedulesApi.get(initialScheduleId);
            if (!alive) return;
            selected = detail.schedule;
            show([...schedules, selected]);
            runs = detail.runs;
          } catch (cause) {
            if (alive) error = message(cause);
          }
        }
        if (selected && alive) {
          expanded = selected.id;
          startEdit(selected);
          void loadRuns(selected.id);
        }
      })();
    return () => {
      alive = false;
    };
  });
  // Runs start, finish and wait for you while this is open.
  watch(
    () => app.scheduleRevision,
    () => {
      if (!disabled) void load();
    },
  );
  // A notification about one schedule, while this is already open.
  watch(
    () => app.scheduleFocus,
    (focus) => {
      if (focus && !disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="schedules-title">
  <h3 id="schedules-title">{tr('Schedules')}</h3>
  <p>
    {tr(
      'Prompts that run by themselves at set times, each in a new session of their workspace. Nobody watches a run live: read its final message here or open its session. Runs the gateway could not start on time wait for you to allow them.',
    )}
  </p>

  {#if disabled}
    <p role="status">{tr('Schedules are unavailable in demo mode.')}</p>
  {:else if loading}
    <p role="status">{tr('Loading schedules…')}</p>
  {:else}
    {#if error}<p class="schedule-error" role="alert">{error}</p>{/if}

    {#if editing}
      {@render editor()}
    {:else}
      <div class="schedule-toolbar">
        <button class="button dark small" type="button" onclick={startNew}
          >{tr('New schedule')}</button
        >
      </div>
    {/if}

    {#if schedules.length}
      <ul class="schedule-list" aria-label={tr('Schedules')}>
        {#each schedules as schedule (schedule.id)}
          <li class:paused={schedule.status !== 'active'}>
            <div class="schedule-row">
              <div class="schedule-text">
                <span class="schedule-title"
                  ><strong>{schedule.title}</strong>
                  {#if schedule.status === 'paused'}<span class="badge">{tr('Paused')}</span>{/if}
                  {#if schedule.status === 'done'}<span class="badge">{tr('Done')}</span>{/if}
                  {#if schedule.attention}<span class="badge attention"
                      >{tr('{0} waiting for you', [schedule.attention])}</span
                    >{/if}</span
                >
                <small>{describeWhen(schedule)}</small>
                <small>{whereOf(schedule)}</small>
                <small>{statusOf(schedule)}</small>
              </div>
              <div class="schedule-actions">
                <button
                  class="button ghost small"
                  type="button"
                  aria-expanded={expanded === schedule.id}
                  onclick={() => toggleRuns(schedule)}>{tr('Runs')}</button
                >
                <button
                  class="button ghost small"
                  type="button"
                  disabled={!!busy || !schedule.workspace.online}
                  title={schedule.workspace.online
                    ? undefined
                    : tr('{0} is offline', [schedule.workspace.node])}
                  onclick={() => act(schedule.id, () => schedulesApi.run(schedule.id))}
                  >{tr('Run now')}</button
                >
                {#if schedule.status === 'active'}
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() =>
                      act(schedule.id, () =>
                        schedulesApi.update(schedule.id, { status: 'paused' }),
                      )}>{tr('Pause')}</button
                  >
                {:else if schedule.status === 'paused'}
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() =>
                      act(schedule.id, () =>
                        schedulesApi.update(schedule.id, { status: 'active' }),
                      )}>{tr('Resume')}</button
                  >
                {/if}
                <button
                  class="button ghost small"
                  type="button"
                  disabled={!!busy}
                  onclick={() => startEdit(schedule)}>{tr('Edit')}</button
                >
                {#if confirming === schedule.id}
                  <button
                    class="button ghost small danger"
                    type="button"
                    disabled={!!busy}
                    onclick={() => act(schedule.id, () => schedulesApi.remove(schedule.id))}
                    >{tr('Delete for good')}</button
                  >
                  <button
                    class="button ghost small"
                    type="button"
                    onclick={() => (confirming = undefined)}>{tr('Cancel')}</button
                  >
                {:else}
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() => (confirming = schedule.id)}>{tr('Delete')}</button
                  >
                {/if}
              </div>
            </div>
            {#if expanded === schedule.id}
              {@render history(schedule)}
            {/if}
          </li>
        {/each}
      </ul>
    {:else if !editing}
      <p>
        {tr(
          'No schedules yet. Make one here, or ask your assistant: it asks you before it adds one.',
        )}
      </p>
    {/if}
  {/if}
</section>

{#snippet history(schedule: Schedule)}
  <details class="schedule-prompt">
    <summary>{tr('Prompt')}</summary>
    <p>{schedule.prompt}</p>
  </details>
  {#if runs.length}
    <ol class="schedule-runs" aria-label={tr('Runs of {0}', [schedule.title])}>
      {#each runs as run (run.id)}
        <li>
          <div class="schedule-row">
            <div class="schedule-text">
              <span
                ><span class="run-status {run.status}">{tr(RUN_LABELS[run.status])}</span>
                <small
                  >{tr('due {0} · {1}', [
                    formatWall(run.dueAt, schedule.timezone),
                    ago(run.createdAt),
                  ])}</small
                ></span
              >
              {#if run.result}<p class="run-result">{run.result}</p>{/if}
            </div>
            <div class="schedule-actions">
              {#if run.status === 'missed'}
                <button
                  class="button dark small"
                  type="button"
                  disabled={!!busy || !schedule.workspace.online}
                  onclick={() => act(run.id, () => schedulesApi.run(schedule.id, run.id))}
                  >{tr('Allow and run now')}</button
                >
                <button
                  class="button ghost small"
                  type="button"
                  disabled={!!busy}
                  onclick={() => act(run.id, () => schedulesApi.dismiss(schedule.id, run.id))}
                  >{tr('Dismiss')}</button
                >
              {/if}
              {#if run.sessionId && run.session}
                <button class="button ghost small" type="button" onclick={() => openRun(run)}
                  >{tr('Open session')}</button
                >
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="schedule-empty">{tr('No runs yet.')}</p>
  {/if}
{/snippet}

{#snippet editor()}
  <form
    class="schedule-form"
    aria-label={editing === 'new' ? tr('New schedule') : tr('Edit schedule')}
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
    autocomplete="off"
  >
    <h4>{editing === 'new' ? tr('New schedule') : tr('Edit schedule')}</h4>
    <label
      ><span>{tr('Workspace')}</span><select bind:value={form.workspaceId} required>
        {#each workspaces as workspace (workspace.id)}
          <option value={workspace.id}>{workspaceLabel(workspace.id)}</option>
        {/each}
      </select></label
    >
    <label
      ><span>{tr('Title')}</span><input
        bind:value={form.title}
        maxlength="80"
        placeholder={tr('Named after the first line of the prompt')}
      /></label
    >
    <label
      ><span>{tr('Prompt')}</span><textarea
        bind:value={form.prompt}
        rows="5"
        required
        placeholder={tr('What the agent should do. Each run starts fresh with only this.')}
      ></textarea></label
    >
    <fieldset class="schedule-mode">
      <legend>{tr('When')}</legend>
      <label class="inline"
        ><input type="radio" bind:group={form.mode} value="repeat" /><span>{tr('Repeat')}</span
        ></label
      >
      <label class="inline"
        ><input type="radio" bind:group={form.mode} value="once" /><span>{tr('Once')}</span></label
      >
    </fieldset>
    {#if form.mode === 'repeat'}
      <label
        ><span>{tr('Cron (minute hour day month weekday)')}</span><input
          bind:value={form.cron}
          required
          spellcheck="false"
          class="mono"
        /></label
      >
      <div class="presets" aria-label={tr('Common repeats')}>
        {#each CRON_PRESETS as preset (preset.cron)}
          <button
            class="button ghost small"
            type="button"
            aria-pressed={form.cron.trim() === preset.cron}
            onclick={() => (form.cron = preset.cron)}>{tr(preset.label)}</button
          >
        {/each}
      </div>
    {:else}
      <label
        ><span>{tr('Time')}</span><input
          type="datetime-local"
          bind:value={form.at}
          required
        /></label
      >
    {/if}
    <label
      ><span>{tr('Time zone')}</span><input
        bind:value={form.timezone}
        list="schedule-timezones"
        required
        spellcheck="false"
      /></label
    >
    <datalist id="schedule-timezones">
      {#each zones as zone (zone)}<option value={zone}></option>{/each}
    </datalist>
    <div class="schedule-columns">
      <label
        ><span>{tr('Model')}</span><select bind:value={form.model}>
          <option value="">{tr('Workspace default')}</option>
          {#each models as model (modelKey(model))}
            <option value={modelKey(model)}>{model.displayName} · {model.provider}</option>
          {/each}
          {#if form.model && !models.some((model) => modelKey(model) === form.model)}
            <option value={form.model}>{JSON.parse(form.model).join(' / ')}</option>
          {/if}
        </select></label
      >
      <label
        ><span>{tr('Thinking')}</span><select bind:value={form.thinking}>
          <option value="">{tr('Default')}</option>
          {#each THINKING as level (level)}<option value={level}>{level}</option>{/each}
        </select></label
      >
    </div>
    <label
      ><span>{tr('Notifications')}</span><select bind:value={form.notify}>
        {#each Object.entries(NOTIFY_LABELS) as [level, label] (level)}
          <option value={level}>{tr(label)}</option>
        {/each}
      </select></label
    >
    {#if formError}<p class="schedule-error" role="alert">{formError}</p>{/if}
    <div class="form-actions">
      <button class="button ghost small" type="button" onclick={() => (editing = undefined)}
        >{tr('Cancel')}</button
      >
      <button class="button dark small" type="submit" disabled={!!busy || !form.workspaceId}
        >{editing === 'new' ? tr('Create') : tr('Save')}</button
      >
    </div>
  </form>
{/snippet}

<style>
  h4 {
    margin: 0 0 6px;
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  .schedule-error {
    color: var(--danger);
  }
  .schedule-toolbar {
    display: flex;
    justify-content: flex-end;
    margin: 12px 0;
  }
  .schedule-list,
  .schedule-runs {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .schedule-list > li {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .schedule-list > li.paused .schedule-title strong {
    color: var(--muted);
  }
  .schedule-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 12px;
  }
  .schedule-text {
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .schedule-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  small {
    color: var(--muted);
    font-size: 12px;
  }
  .badge {
    padding: 0 6px;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 11px;
  }
  .badge.attention {
    color: var(--bg);
    background: var(--accent);
  }
  .schedule-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .danger {
    color: var(--danger);
  }
  .schedule-prompt {
    margin: 8px 0 0;
    font-size: 13px;
  }
  .schedule-prompt summary {
    color: var(--text-2);
    cursor: pointer;
  }
  .schedule-prompt p,
  .run-result {
    margin: 4px 0 0;
    color: var(--text-2);
    white-space: pre-wrap;
  }
  .run-result {
    max-height: 160px;
    overflow-y: auto;
  }
  .schedule-runs {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .run-status {
    margin-right: 6px;
    font-weight: 600;
  }
  .run-status.completed {
    color: var(--success);
  }
  .run-status.failed {
    color: var(--danger);
  }
  .run-status.missed,
  .run-status.waiting_input {
    color: var(--accent);
  }
  .run-status.skipped,
  .run-status.dismissed {
    color: var(--muted);
  }
  .schedule-empty {
    font-size: 12px;
  }
  .schedule-form {
    margin: 12px 0;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .schedule-form textarea {
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
    resize: vertical;
  }
  .schedule-form textarea:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .schedule-mode {
    display: flex;
    gap: 16px;
    margin: 12px 0;
    padding: 0;
    border: 0;
  }
  .schedule-mode legend {
    margin-bottom: 6px;
    padding: 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
  }
  .schedule-mode label.inline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .schedule-mode input {
    width: 16px;
    height: 16px;
    padding: 0;
    accent-color: var(--accent);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .presets [aria-pressed='true'] {
    color: var(--accent);
  }
  .schedule-columns {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 12px;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
</style>
