<script lang="ts">
  import { tr } from '../../i18n.svelte';

  import { onDestroy } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import { app } from '../../app.svelte';
  import { ApiError } from '../../http';
  import { Loader } from '../../loader.svelte';
  import {
    panelApi,
    type CheckpointCapture,
    type CheckpointFileView,
    type CheckpointList,
    type CheckpointOperation,
    type CheckpointPathReview,
    type CheckpointPreview,
    type CheckpointRecoveryJob,
  } from '../../panel-api';
  import { uuid } from '../../id';
  import { getClientId } from '../../storage';
  import { watch } from '../../watch.svelte';
  import { checkpointDiff } from '../../checkpoint-diff';
  import DiffView from './DiffView.svelte';

  interface Props {
    sessionId: string;
    /** Includes the session, account, workspace and owning node identities. */
    scope: string;
    online: boolean;
    hasControl: boolean;
    generation: number | undefined;
    active?: boolean;
  }

  let { sessionId, scope, online, hasControl, generation, active = true }: Props = $props();

  type Screen = 'list' | 'selection' | 'preview' | 'job';
  type ComparePair = 'recorded' | 'recovery';

  let screen = $state<Screen>('list');
  let data = $state.raw<CheckpointList>();
  let selectedCaptureId = $state('');
  let selectedOperations = $state<string[]>([]);
  let reviewObservational = $state(false);
  let preview = $state.raw<CheckpointPreview>();
  let previewKey = $state('');
  let previewOperations = $state<string[]>([]);
  let currentJob = $state.raw<CheckpointRecoveryJob>();
  let keepCurrentConfirmed = $state(false);
  let inspectPath = $state<CheckpointPathReview>();
  let comparePair = $state<ComparePair>('recorded');
  let fileViews = $state.raw<{ before?: CheckpointFileView; after?: CheckpointFileView }>();
  let fileError = $state('');
  let stale = $state(false);
  let mutationError = $state('');
  let busy = $state(false);
  let staleList = $state(false);
  let epoch = 0;
  let mutationController: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const listLoader = new Loader();
  const jobLoader = new Loader();
  const fileLoader = new Loader();
  const listError = $derived(listLoader.error || jobLoader.error);
  const canRecover = $derived(online && hasControl && generation !== undefined);
  const captures = $derived(data?.captures ?? []);
  const jobs = $derived(data?.jobs ?? []);
  const selectedCapture = $derived(captures.find((capture) => capture.id === selectedCaptureId));
  const operationById = $derived(
    new Map((selectedCapture?.operations ?? []).map((operation) => [operation.id, operation])),
  );
  const selectedPaths = $derived(
    new Set(
      selectedOperations
        .map((id) => operationById.get(id)?.path)
        .filter((path): path is string => !!path),
    ),
  );
  const pathOperations = $derived(
    new Map((selectedCapture?.operations ?? []).map((operation) => [operation.path, operation])),
  );
  const unresolved = $derived(
    !!currentJob?.manifest.paths.some((path) => path.status !== 'inverse_reviewed_observation'),
  );
  const jobCapture = $derived(captures.find((capture) => capture.id === currentJob?.captureId));
  const fileDiff = $derived.by(() => {
    if (!fileViews?.before || !fileViews.after) return '';
    if (
      fileViews.before.binary ||
      fileViews.after.binary ||
      fileViews.before.excluded ||
      fileViews.after.excluded
    )
      return '';
    return checkpointDiff(fileViews.before.text, fileViews.after.text, inspectPath?.path ?? '');
  });
  const filePreviewTruncated = $derived(
    !!fileViews &&
      (fileViews.before?.truncated ||
        fileViews.after?.truncated ||
        (fileViews.before?.text?.length ?? 0) >= 16_000 ||
        (fileViews.after?.text?.length ?? 0) >= 16_000),
  );

  function isCurrent(requestEpoch: number, id: string) {
    return requestEpoch === epoch && id === sessionId;
  }

  function abortRequests() {
    listLoader.abort();
    jobLoader.abort();
    fileLoader.abort();
    mutationController?.abort();
    mutationController = undefined;
    clearTimeout(pollTimer);
  }

  function clearReview() {
    selectedOperations = [];
    reviewObservational = false;
    preview = undefined;
    previewKey = '';
    previewOperations = [];
    currentJob = undefined;
    keepCurrentConfirmed = false;
    inspectPath = undefined;
    fileViews = undefined;
    fileError = '';
    stale = false;
    mutationError = '';
  }

  function appendPage(page: CheckpointList, reset: boolean) {
    if (reset || !data) {
      data = page;
      return;
    }
    const knownCaptures = new Set(data.captures.map((item) => item.id));
    const knownJobs = new Set(data.jobs.map((item) => item.id));
    data = {
      ...page,
      captures: [...data.captures, ...page.captures.filter((item) => !knownCaptures.has(item.id))],
      jobs: [...data.jobs, ...page.jobs.filter((item) => !knownJobs.has(item.id))],
    };
  }

  async function load(reset = true) {
    if (!active || !online) {
      staleList = true;
      return;
    }
    const id = sessionId;
    const requestEpoch = epoch;
    const cursor = reset ? undefined : data?.cursor;
    const page = await listLoader.run(
      (signal) => panelApi.checkpoints(id, cursor, signal),
      tr('Unable to load checkpoints.'),
    );
    if (!page || !isCurrent(requestEpoch, id)) return;
    appendPage(page, reset);
    staleList = false;
    if (!page.enabled) {
      screen = 'list';
      clearReview();
      return;
    }
    if (currentJob) {
      const updated = page.jobs.find((item) => item.id === currentJob?.id);
      if (updated) currentJob = updated;
    }
  }

  async function loadMore() {
    if (!data?.more || !data.cursor) return;
    await load(false);
  }

  function captureIsClosed(capture: CheckpointCapture) {
    return capture.state !== 'capturing';
  }

  function canSelect(operation: CheckpointOperation) {
    return operation.state === 'observed' && !!operation.after;
  }

  function selectCapture(capture: CheckpointCapture) {
    if (!canRecover || !captureIsClosed(capture)) return;
    selectedCaptureId = capture.id;
    clearReview();
    screen = 'selection';
  }

  function toggleOperation(operation: CheckpointOperation, checked: boolean) {
    if (
      !selectedCapture ||
      !canRecover ||
      !captureIsClosed(selectedCapture) ||
      !canSelect(operation)
    )
      return;
    mutationError = '';
    preview = undefined;
    previewKey = '';
    previewOperations = [];
    screen = 'selection';
    if (!checked) {
      selectedOperations = selectedOperations.filter((id) => id !== operation.id);
      return;
    }
    const selectedForPath = selectedCapture.operations.find(
      (item) => item.path === operation.path && selectedOperations.includes(item.id),
    );
    if (selectedForPath) return;
    selectedOperations = [...selectedOperations, operation.id];
  }

  async function previewSelection() {
    if (!canRecover || !selectedCapture || !selectedOperations.length || !reviewObservational)
      return;
    mutationError = '';
    stale = false;
    busy = true;
    const id = sessionId;
    const captureId = selectedCapture.id;
    const requestEpoch = epoch;
    const controller = new AbortController();
    mutationController = controller;
    try {
      const result = await panelApi.checkpointPreview(
        id,
        captureId,
        { operations: selectedOperations, reviewObservational: true },
        controller.signal,
      );
      if (!isCurrent(requestEpoch, id) || controller.signal.aborted) return;
      preview = result;
      previewOperations = [...selectedOperations];
      previewKey = uuid();
      screen = 'preview';
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(requestEpoch, id)) {
        if (error instanceof ApiError && error.status === 409) stale = true;
        mutationError = error instanceof Error ? error.message : tr('Unable to preview recovery.');
        if (stale) void load(true);
      }
    } finally {
      if (mutationController === controller) mutationController = undefined;
      if (isCurrent(requestEpoch, id)) busy = false;
    }
  }

  async function prepareRecovery() {
    if (
      !canRecover ||
      !selectedCapture ||
      !preview ||
      !reviewObservational ||
      !previewKey ||
      selectedOperations.join('\0') !== previewOperations.join('\0')
    )
      return;
    mutationError = '';
    stale = false;
    busy = true;
    const id = sessionId;
    const captureId = selectedCapture.id;
    const requestEpoch = epoch;
    const controller = new AbortController();
    mutationController = controller;
    try {
      const job = await panelApi.prepareCheckpointRecovery(
        id,
        captureId,
        {
          version: 1,
          key: previewKey,
          previewRevision: preview.revision,
          operations: previewOperations,
          reviewObservational: true,
          clientId: getClientId(),
          generation: generation!,
        },
        controller.signal,
      );
      if (!isCurrent(requestEpoch, id) || controller.signal.aborted) return;
      currentJob = job;
      data = data
        ? { ...data, jobs: [job, ...data.jobs.filter((item) => item.id !== job.id)] }
        : data;
      keepCurrentConfirmed = false;
      inspectPath = undefined;
      fileViews = undefined;
      screen = 'job';
      scheduleJobPoll(job);
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(requestEpoch, id)) {
        if (error instanceof ApiError && error.status === 409) stale = true;
        mutationError = error instanceof Error ? error.message : tr('Unable to prepare recovery.');
        if (stale) {
          preview = undefined;
          screen = 'selection';
          void load(true);
        }
      }
    } finally {
      if (mutationController === controller) mutationController = undefined;
      if (isCurrent(requestEpoch, id)) busy = false;
    }
  }

  async function ensureCapture(captureId: string) {
    if (captures.some((capture) => capture.id === captureId)) return true;
    if (!active || !online || !data?.more || !data.cursor) return false;
    const id = sessionId;
    const requestEpoch = epoch;
    let cursor = data.cursor;
    for (let pageCount = 0; pageCount < 50 && cursor; pageCount++) {
      const page = await listLoader.run(
        (signal) => panelApi.checkpoints(id, cursor, signal),
        tr('Unable to load checkpoints.'),
      );
      if (!page || !isCurrent(requestEpoch, id)) return false;
      appendPage(page, false);
      if (page.captures.some((capture) => capture.id === captureId)) return true;
      if (!page.more || !page.cursor || page.cursor === cursor) return false;
      cursor = page.cursor;
    }
    return captures.some((capture) => capture.id === captureId);
  }

  async function openJob(job: CheckpointRecoveryJob) {
    currentJob = job;
    selectedCaptureId = job.captureId;
    screen = 'job';
    mutationError = '';
    fileViews = undefined;
    inspectPath = undefined;
    keepCurrentConfirmed = false;
    stale = job.state === 'stale';
    await ensureCapture(job.captureId);
    if (active && online) void refreshJob();
    else staleList = true;
  }

  async function refreshJob() {
    if (!currentJob || !active || !online) return undefined;
    const id = sessionId;
    const captureId = currentJob.captureId;
    const jobId = currentJob.id;
    const requestEpoch = epoch;
    const updated = await jobLoader.run(
      (signal) => panelApi.checkpointRecovery(id, captureId, jobId, signal),
      tr('Unable to refresh recovery status.'),
    );
    if (!updated || !isCurrent(requestEpoch, id)) return undefined;
    currentJob = updated;
    if (updated.state === 'stale') stale = true;
    if (data)
      data = {
        ...data,
        jobs: [updated, ...data.jobs.filter((item) => item.id !== updated.id)],
      };
    scheduleJobPoll(updated);
    return updated;
  }

  function scheduleJobPoll(job: CheckpointRecoveryJob) {
    clearTimeout(pollTimer);
    if (!active || !online || job.state !== 'preparing') return;
    const requestEpoch = epoch;
    pollTimer = setTimeout(() => {
      if (requestEpoch === epoch && active) void refreshJob();
    }, 1800);
  }

  async function refreshAll() {
    stale = false;
    mutationError = '';
    await load(true);
    if (currentJob && online) await refreshJob();
  }

  function backToSelection() {
    currentJob = undefined;
    preview = undefined;
    previewKey = '';
    previewOperations = [];
    inspectPath = undefined;
    fileViews = undefined;
    keepCurrentConfirmed = false;
    screen = selectedCapture ? 'selection' : 'list';
  }

  function showStaleSelection() {
    stale = true;
    screen = 'selection';
    preview = undefined;
    previewKey = '';
    previewOperations = [];
    void refreshAll();
  }

  async function inspect(entry: CheckpointPathReview, pair: ComparePair = comparePair) {
    if (!currentJob || !active) return;
    inspectPath = entry;
    comparePair = pair;
    fileViews = undefined;
    fileError = '';
    if (!jobCapture) {
      fileError = tr('Refresh checkpoints to load the operation details.');
      return;
    }
    const selectedOperationIds = new Set(currentJob.operations);
    const operation = jobCapture.operations.find(
      (item) => item.path === entry.path && selectedOperationIds.has(item.id),
    );
    if (!operation) {
      fileError = tr('Refresh checkpoints to load the operation details.');
      return;
    }
    const id = sessionId;
    const requestEpoch = epoch;
    const captureId = currentJob.captureId;
    const jobId = currentJob.id;
    const sides: [CheckpointFileView['side'], CheckpointFileView['side']] =
      pair === 'recorded' ? ['before', 'after'] : ['current', 'candidate'];
    const result = await fileLoader.run(async (signal) => {
      const [before, after] = await Promise.all([
        panelApi.checkpointFile(
          id,
          captureId,
          operation.id,
          sides[0],
          pair === 'recovery' ? jobId : undefined,
          signal,
        ),
        panelApi.checkpointFile(
          id,
          captureId,
          operation.id,
          sides[1],
          pair === 'recovery' ? jobId : undefined,
          signal,
        ),
      ]);
      return { before, after };
    }, tr('Unable to load checkpoint file preview.'));
    if (result && isCurrent(requestEpoch, id) && inspectPath?.path === entry.path)
      fileViews = result;
  }

  async function continueRecovery() {
    if (!canRecover || !currentJob || (unresolved && !keepCurrentConfirmed)) return;
    if (currentJob.state === 'opened' && currentJob.continuation?.sessionId) {
      await app.openSession(currentJob.continuation.sessionId);
      return;
    }
    const id = sessionId;
    const requestEpoch = epoch;
    const original = currentJob;
    mutationError = '';
    stale = false;
    busy = true;
    const refresh = await jobLoader.run(
      (signal) => panelApi.checkpointRecovery(id, original.captureId, original.id, signal),
      tr('Unable to refresh recovery status.'),
    );
    if (!refresh || !isCurrent(requestEpoch, id)) {
      busy = false;
      return;
    }
    currentJob = refresh;
    if (refresh.revision !== original.revision || !['ready', 'opened'].includes(refresh.state)) {
      stale = refresh.state === 'stale' || refresh.revision !== original.revision;
      mutationError = tr('Recovery changed. Review the refreshed status before continuing.');
      busy = false;
      return;
    }
    const controller = new AbortController();
    mutationController = controller;
    try {
      const result = await panelApi.continueCheckpointRecovery(
        id,
        refresh.captureId,
        refresh.id,
        {
          revision: refresh.revision,
          acceptUnresolved: keepCurrentConfirmed,
          clientId: getClientId(),
          generation: generation!,
        },
        controller.signal,
      );
      if (!isCurrent(requestEpoch, id) || controller.signal.aborted) return;
      currentJob = result.job;
      if (data)
        data = {
          ...data,
          jobs: [result.job, ...data.jobs.filter((item) => item.id !== result.job.id)],
        };
      // This intentionally opens the fresh conversation returned for this job.
      await app.openSession(result.session.id);
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(requestEpoch, id)) {
        if (error instanceof ApiError && error.status === 409) stale = true;
        mutationError = error instanceof Error ? error.message : tr('Unable to continue recovery.');
        if (stale) void refreshAll();
      }
    } finally {
      if (mutationController === controller) mutationController = undefined;
      if (isCurrent(requestEpoch, id)) busy = false;
    }
  }

  function openOriginSession() {
    const originSessionId = data?.origin?.sessionId;
    if (originSessionId) void app.openSession(originSessionId);
  }

  function dateLabel(value: number | string | undefined) {
    if (value === undefined) return tr('Unknown time');
    const date = new Date(
      typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value,
    );
    return Number.isNaN(date.getTime()) ? tr('Unknown time') : date.toLocaleString();
  }

  function captureGaps(capture: CheckpointCapture) {
    return Array.isArray(capture.gaps) ? capture.gaps.length > 0 : capture.gaps;
  }

  function captureRun(capture: CheckpointCapture) {
    if (typeof capture.run === 'string') return capture.run;
    return capture.run?.id ?? capture.run?.status ?? '';
  }

  const operationStateLabel = (state: string) =>
    state === 'observed'
      ? tr('Observed')
      : state === 'excluded'
        ? tr('Excluded')
        : state === 'open'
          ? tr('Still open')
          : tr('Not covered');

  const pathStatusLabel = (status: CheckpointPathReview['status']) =>
    status === 'inverse_reviewed_observation'
      ? tr('Inverse reviewed')
      : status === 'review_observational'
        ? tr('Observational review')
        : status === 'conflict'
          ? tr('Conflict · keep current')
          : tr('Excluded · keep current');

  function formatBytes(value: number) {
    if (value < 1024) return `${value.toLocaleString()} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function versionLabel(
    version: CheckpointOperation['before'] | CheckpointOperation['after'] | undefined,
  ) {
    if (!version) return tr('Unavailable');
    if (version.kind === 'absent') return tr('Absent');
    if (version.kind === 'excluded')
      return `${tr('Excluded')}: ${version.reason ?? tr('Unknown reason')}`;
    return `${formatBytes(version.size ?? 0)}${version.executable ? ` · ${tr('Executable')}` : ''}`;
  }

  function sideDescription(file: CheckpointFileView | undefined, label: string) {
    if (!file) return tr('{0}: unavailable', [label]);
    if (file.excluded) return tr('{0}: excluded ({1})', [label, tr('File cannot be inspected')]);
    if (file.absent) return tr('{0}: file was absent', [label]);
    if (file.binary) return tr('{0}: binary file; text preview is unavailable', [label]);
    return tr('{0}: text preview unavailable', [label]);
  }

  watch(
    () => [sessionId, scope, generation, hasControl] as const,
    () => {
      epoch++;
      abortRequests();
      screen = 'list';
      data = undefined;
      selectedCaptureId = '';
      clearReview();
      staleList = false;
      busy = false;
      if (active && online) void load(true);
      else staleList = true;
    },
    { immediate: true },
  );

  watch(
    () => [active, online] as const,
    ([shown, connected], previous) => {
      if (!shown) {
        epoch++;
        abortRequests();
        busy = false;
        fileViews = undefined;
        if (currentJob?.state === 'preparing') staleList = true;
        return;
      }
      if (!connected) {
        epoch++;
        abortRequests();
        busy = false;
        fileViews = undefined;
        staleList = true;
        return;
      }
      if (!previous || !previous[0] || !previous[1] || staleList) void load(true);
      if (currentJob) void refreshJob();
    },
  );

  onDestroy(
    app.onPanel((signal) => {
      if (signal.type !== 'changed' || !signal.sections.includes('checkpoints')) return;
      if (active) void load(true);
      else staleList = true;
    }),
  );

  onDestroy(() => {
    epoch++;
    abortRequests();
  });
</script>

<div class="checkpoints">
  <div class="checkpoints-toolbar">
    <h3>{tr('Checkpoints')}</h3>
    <button
      class="icon-button small"
      type="button"
      aria-label={tr('Refresh checkpoints')}
      disabled={!online || listLoader.loading || jobLoader.loading}
      onclick={refreshAll}
      ><RefreshCw class={listLoader.loading || jobLoader.loading ? 'spin' : ''} size={15} /></button
    >
  </div>
  {#if !online}<p class="notice" role="status">
      {tr('Reconnect to inspect or prepare a recovery.')}
    </p>
  {:else if !hasControl}<p class="notice" role="status">
      {tr('Take control of this session to preview or prepare recovery.')}
    </p>
  {/if}
  {#if listError}<p class="panel-error" role="alert">{listError}</p>{/if}
  {#if mutationError}<p class="panel-error" role="alert">{mutationError}</p>{/if}
  {#if stale}<p class="notice warning" role="status">
      {tr('This recovery is stale. Refresh it and review the current files again.')}
      <button type="button" class="link" onclick={refreshAll}>{tr('Refresh now')}</button>
    </p>{/if}
  {#if data?.origin}
    <section class="checkpoint-origin" aria-label={tr('Recovery origin')}>
      <div>
        <h4>{tr('Recovery origin')}</h4>
        <p class="checkpoint-meta">
          {tr('Capture {0} · job {1}', [data.origin.captureId, data.origin.jobId])}
        </p>
      </div>
      <button class="button ghost" type="button" onclick={openOriginSession}
        >{tr('Open original session')}</button
      >
    </section>
  {/if}
  {#if data?.enabled === false}
    <p class="panel-empty">
      {tr('Checkpoint capture is opt-in on the node through PIRC_CHECKPOINT_WORKSPACES.')}
    </p>
  {:else if !data && listLoader.loading}
    <p class="panel-empty" role="status">{tr('Loading checkpoints…')}</p>
  {:else if data?.enabled}
    {#if screen === 'list'}
      {#if jobs.length}
        <section class="checkpoint-section">
          <h4>{tr('Recovery workspaces')}</h4>
          <ul class="checkpoint-list">
            {#each jobs as job (job.id)}
              <li>
                <button class="checkpoint-row" type="button" onclick={() => openJob(job)}>
                  <span class="checkpoint-name">{job.state}</span>
                  <span class="checkpoint-meta"
                    >{tr('{0} paths · {1} copied', [
                      job.manifest.paths.length.toLocaleString(),
                      formatBytes(job.manifest.copiedBytes),
                    ])}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <section class="checkpoint-section">
        <h4>{tr('Closed runs')}</h4>
        {#if !captures.length}
          <p class="panel-empty">{tr('No closed checkpoint runs are available.')}</p>
        {:else}
          <ul class="checkpoint-list">
            {#each captures as capture (capture.id)}
              {@const closed = captureIsClosed(capture)}
              <li>
                <button
                  class="checkpoint-row"
                  class:disabled={!closed || !canRecover}
                  type="button"
                  disabled={!closed || !canRecover}
                  onclick={() => selectCapture(capture)}
                >
                  <span class="checkpoint-name"
                    >{dateLabel(capture.createdAt ?? capture.created)}</span
                  >
                  <span class="checkpoint-meta">
                    {capture.state} · {tr('{0} operations', [
                      capture.operations.length.toLocaleString(),
                    ])}
                    {#if capture.pinned}<span class="chip">{tr('Pinned')}</span>{/if}
                    {#if !closed}<span class="chip warning-chip">{tr('Run is still open')}</span
                      >{/if}
                  </span>
                </button>
                <p class="coverage">{capture.coverage}</p>
                {#if captureGaps(capture)}<p class="notice warning">
                    {tr('Coverage has gaps; some file changes may not be represented.')}
                  </p>{/if}
                {#if captureRun(capture)}<p class="checkpoint-meta">
                    {tr('Run')}: <span class="mono">{captureRun(capture)}</span>
                  </p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
      {#if data.more}<button
          class="load-more"
          type="button"
          disabled={listLoader.loading || !online}
          onclick={loadMore}>{tr('Load more')}</button
        >{/if}
      {#if staleList}<p class="checkpoint-meta">{tr('Checkpoint data may be out of date.')}</p>{/if}
    {:else if screen === 'selection' && selectedCapture}
      <div class="drill-head">
        <button
          class="icon-button small"
          type="button"
          aria-label={tr('Back')}
          onclick={() => (screen = 'list')}>←</button
        >
        <span class="drill-title">{tr('Review a closed run')}</span>
      </div>
      <p class="coverage">{selectedCapture.coverage}</p>
      {#if captureGaps(selectedCapture)}<p class="notice warning">
          {tr('Coverage has gaps; some file changes may not be represented.')}
        </p>{/if}
      {#if selectedCapture.operationsTruncated}<p class="notice warning">
          {tr('Only the first 100 operations are listed. This operation list is incomplete.')}
        </p>{/if}
      <p class="checkpoint-meta">{tr('Choose at most one observed operation for each path.')}</p>
      <ul class="operation-list">
        {#each selectedCapture.operations as operation (operation.id)}
          {@const pathConflict =
            selectedPaths.has(operation.path) && !selectedOperations.includes(operation.id)}
          <li>
            <label class="operation-row" class:unavailable={!canSelect(operation) || pathConflict}>
              <input
                type="checkbox"
                checked={selectedOperations.includes(operation.id)}
                disabled={!canRecover || !canSelect(operation) || pathConflict}
                onchange={(event) => toggleOperation(operation, event.currentTarget.checked)}
              />
              <span class="operation-info">
                <span class="operation-path">{operation.path || tr('Unknown path')}</span>
                <span class="checkpoint-meta">{operationStateLabel(operation.state)}</span>
              </span>
            </label>
            <div class="version-pair">
              <span>{tr('Before')}: {versionLabel(operation.before)}</span>
              <span>{tr('After')}: {versionLabel(operation.after)}</span>
            </div>
          </li>
        {/each}
      </ul>
      <label class="consent-row">
        <input
          type="checkbox"
          bind:checked={reviewObservational}
          disabled={!canRecover || !selectedOperations.length}
        />
        <span
          >{tr(
            'I have reviewed the observational coverage and understand this copy may omit concurrent or unrecorded changes.',
          )}</span
        >
      </label>
      <button
        class="button primary"
        type="button"
        disabled={!canRecover || !selectedOperations.length || !reviewObservational || busy}
        onclick={previewSelection}
      >
        {busy ? tr('Previewing…') : tr('Preview recovery')}
      </button>
    {:else if screen === 'preview' && preview}
      <div class="drill-head">
        <button
          class="icon-button small"
          type="button"
          aria-label={tr('Back')}
          onclick={backToSelection}>←</button
        >
        <span class="drill-title">{tr('Recovery preview')}</span>
      </div>
      <div class="recovery-summary">
        <p>
          {tr('{0} copied · {1} exclusions', [
            formatBytes(preview.copiedBytes),
            Object.keys(preview.exclusions).length.toLocaleString(),
          ])}
        </p>
        <p class="coverage">{preview.coverage}</p>
      </div>
      {#if Object.keys(preview.exclusions).length}
        <h4>{tr('Excluded paths')}</h4>
        <ul class="exclusion-list">
          {#each Object.entries(preview.exclusions) as [path, reason] (path)}
            <li><span>{path}</span><span class="checkpoint-meta">{reason}</span></li>
          {/each}
        </ul>
      {/if}
      <p class="notice">
        {tr(
          'Preparing creates an independent recovery workspace. Continuing opens a new conversation; this source session stays available.',
        )}
      </p>
      <button
        class="button primary"
        type="button"
        disabled={!canRecover || busy || !reviewObservational}
        onclick={prepareRecovery}
      >
        {busy ? tr('Preparing…') : tr('Prepare independent workspace')}
      </button>
    {:else if screen === 'job' && currentJob}
      <div class="drill-head">
        <button
          class="icon-button small"
          type="button"
          aria-label={tr('Back')}
          onclick={backToSelection}>←</button
        >
        <span class="drill-title">{tr('Recovery workspace')}</span>
        <span class="chip">{currentJob.state}</span>
      </div>
      <p class="coverage">{currentJob.manifest.coverage}</p>
      <p class="checkpoint-meta">
        {tr('{0} copied · {1} reserved', [
          formatBytes(currentJob.manifest.copiedBytes),
          formatBytes(currentJob.reservedBytes),
        ])}
      </p>
      {#if currentJob.state === 'preparing'}<p class="notice" role="status">
          {tr('Preparing an independent workspace…')}
        </p>{/if}
      {#if currentJob.state === 'stale'}<p class="notice warning" role="status">
          {tr('The source changed. Refresh the checkpoint and preview again.')}
        </p>{/if}
      {#if currentJob.manifest.paths.length}
        <h4>{tr('Review paths')}</h4>
        <ul class="review-paths">
          {#each currentJob.manifest.paths as entry (entry.path)}
            <li>
              <div class="review-path-head">
                <span class="operation-path">{entry.path}</span>
                <span
                  class="chip"
                  class:warning-chip={entry.status !== 'inverse_reviewed_observation'}
                  >{pathStatusLabel(entry.status)}</span
                >
              </div>
              <div class="version-pair">
                <span>{tr('Before')}: {versionLabel(entry.before)}</span>
                <span>{tr('After')}: {versionLabel(entry.after)}</span>
                <span>{tr('Current')}: {versionLabel(entry.current)}</span>
                <span>{tr('Candidate')}: {versionLabel(entry.candidate)}</span>
              </div>
              <button
                class="button ghost"
                type="button"
                disabled={!online}
                onclick={() => inspect(entry, 'recorded')}>{tr('Inspect before and after')}</button
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if Object.keys(currentJob.manifest.exclusions).length}
        <h4>{tr('Excluded paths')}</h4>
        <ul class="exclusion-list">
          {#each Object.entries(currentJob.manifest.exclusions) as [path, reason] (path)}
            <li><span>{path}</span><span class="checkpoint-meta">{reason}</span></li>
          {/each}
        </ul>
      {/if}
      {#if inspectPath}
        <section class="file-review">
          <h4>{inspectPath.path}</h4>
          <div class="segmented compare-tabs" role="tablist" aria-label={tr('File comparison')}>
            <button
              type="button"
              role="tab"
              aria-selected={comparePair === 'recorded'}
              class:active={comparePair === 'recorded'}
              onclick={() => inspect(inspectPath!, 'recorded')}>{tr('Before / after')}</button
            >
            <button
              type="button"
              role="tab"
              aria-selected={comparePair === 'recovery'}
              class:active={comparePair === 'recovery'}
              onclick={() => inspect(inspectPath!, 'recovery')}>{tr('Current / candidate')}</button
            >
          </div>
          {#if fileError}<p class="panel-error" role="alert">{fileError}</p>
          {:else if fileLoader.loading}<p class="checkpoint-meta" role="status">
              {tr('Loading file preview…')}
            </p>
          {:else if fileViews?.before && fileViews.after}
            {#if filePreviewTruncated}<p class="notice warning">
                {tr('Text previews are limited to 16,000 characters per file.')}
              </p>{/if}
            {#if fileViews.before.binary || fileViews.after?.binary || fileViews.before.excluded || fileViews.after?.excluded}
              <div class="binary-review">
                <p>
                  {sideDescription(
                    fileViews.before,
                    tr(comparePair === 'recorded' ? 'Before' : 'Current'),
                  )}
                </p>
                <p>
                  {sideDescription(
                    fileViews.after,
                    tr(comparePair === 'recorded' ? 'After' : 'Candidate'),
                  )}
                </p>
              </div>
            {:else}
              <DiffView diff={fileDiff} />
            {/if}
          {/if}
          <div class="review-actions">
            <button
              class="button ghost"
              type="button"
              disabled={!online}
              onclick={() =>
                inspect(inspectPath!, comparePair === 'recorded' ? 'recovery' : 'recorded')}
              >{comparePair === 'recorded'
                ? tr('Inspect current and candidate')
                : tr('Inspect before and after')}</button
            >
            <button class="button ghost" type="button" onclick={() => app.openSession(sessionId)}
              >{tr('Open original session')}</button
            >
          </div>
        </section>
      {:else}
        <button class="button ghost" type="button" onclick={() => app.openSession(sessionId)}
          >{tr('Open original session')}</button
        >
      {/if}
      {#if unresolved}
        <label class="consent-row unresolved-confirm">
          <input
            type="checkbox"
            bind:checked={keepCurrentConfirmed}
            disabled={!canRecover || currentJob.state === 'preparing'}
          />
          <span
            >{tr(
              'I reviewed conflicts and unresolved paths; keep their current files in the recovery workspace.',
            )}</span
          >
        </label>
      {/if}
      <p class="notice">
        {tr(
          'Continue in recovery workspace opens a new conversation. It does not resume this session or copy its history or memory.',
        )}
      </p>
      {#if currentJob.state === 'ready' || currentJob.state === 'opened'}
        <button
          class="button primary"
          type="button"
          disabled={!canRecover || busy || (unresolved && !keepCurrentConfirmed)}
          onclick={continueRecovery}
        >
          {busy
            ? tr('Opening…')
            : currentJob.state === 'opened' && currentJob.continuation?.sessionId
              ? tr('Open recovery conversation')
              : tr('Continue in recovery workspace')}
        </button>
      {/if}
    {/if}
  {:else if data && data.enabled && screen !== 'list'}
    <p class="panel-empty">
      {tr('This recovery is no longer available. Refresh checkpoints and choose it again.')}
    </p>
  {/if}
</div>

<style>
  .checkpoints {
    display: grid;
    align-content: start;
    gap: 10px;
    min-width: 0;
    padding: 4px 0 12px;
  }
  .checkpoints-toolbar,
  .review-path-head,
  .review-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3,
  h4,
  p {
    margin: 0;
  }
  h3 {
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
  }
  h4 {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }
  .checkpoint-section {
    display: grid;
    gap: 6px;
  }
  .checkpoint-origin {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px;
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line);
  }
  .checkpoint-list,
  .operation-list,
  .review-paths,
  .exclusion-list {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .checkpoint-list > li,
  .operation-list > li,
  .review-paths > li {
    display: grid;
    gap: 4px;
    min-width: 0;
    padding: 8px;
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line);
  }
  .checkpoint-row {
    display: grid;
    gap: 3px;
    width: 100%;
    padding: 4px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    text-align: left;
  }
  .checkpoint-row:not(:disabled):hover {
    background: var(--bg-hover);
  }
  .checkpoint-row.disabled,
  .checkpoint-row:disabled {
    opacity: 0.6;
  }
  .checkpoint-name,
  .operation-path {
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 12px;
    font-weight: 600;
  }
  .checkpoint-meta,
  .coverage,
  .version-pair {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .coverage {
    padding: 0 4px;
  }
  .operation-row,
  .consent-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.45;
  }
  .operation-row input,
  .consent-row input {
    flex: none;
    margin-top: 2px;
    accent-color: var(--accent);
  }
  .operation-row.unavailable {
    opacity: 0.58;
  }
  .operation-info {
    display: grid;
    min-width: 0;
  }
  .version-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 8px;
    padding-left: 26px;
  }
  .notice {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: var(--bg-subtle);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .notice.warning {
    color: var(--warning-ink, var(--text-2));
    background: color-mix(in srgb, var(--warning) 10%, var(--bg-subtle));
  }
  .warning-chip {
    color: var(--warning);
  }
  .consent-row {
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .unresolved-confirm {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .operation-list {
    max-height: 36vh;
    overflow: auto;
  }
  .recovery-summary {
    display: grid;
    gap: 5px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    color: var(--ink);
    background: var(--bg-layer);
    box-shadow: 0 0 0 1px var(--line);
    font-size: 12px;
  }
  .exclusion-list > li {
    display: grid;
    gap: 2px;
    padding: 5px 2px;
    border-bottom: 1px solid var(--line);
    color: var(--text-2);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .review-paths {
    max-height: 44vh;
    overflow: auto;
  }
  .review-path-head {
    align-items: flex-start;
  }
  .review-path-head .chip {
    flex: none;
  }
  .file-review {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .compare-tabs {
    display: flex;
    overflow: auto;
  }
  .compare-tabs button {
    flex: 1;
    white-space: nowrap;
  }
  .binary-review {
    display: grid;
    gap: 4px;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--muted);
    font-size: 11px;
  }
  .review-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .load-more {
    justify-self: center;
    padding: 6px 12px;
    border: 0;
    border-radius: 999px;
    color: var(--accent);
    background: transparent;
    font-size: 12.5px;
  }
  .load-more:hover:not(:disabled) {
    background: var(--accent-soft);
  }
</style>
