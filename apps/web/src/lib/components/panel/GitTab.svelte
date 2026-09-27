<script lang="ts">
  import { ArrowLeft, GitBranch, GitCommitHorizontal, RefreshCw } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { app } from '../../app.svelte';
  import { Loader } from '../../loader.svelte';
  import {
    panelApi,
    type Commit,
    type CommitDetail,
    type GitFile,
    type GitStatus,
  } from '../../panel-api';
  import { ago } from '../../time';
  import { watch } from '../../watch.svelte';
  import DiffView from './DiffView.svelte';

  interface Props {
    sessionId: string;
    /** Shown in the panel; refreshes wait until then. */
    active?: boolean;
    onopenfile?: (path: string) => void;
  }

  let { sessionId, active = true, onopenfile = () => {} }: Props = $props();

  let view: 'changes' | 'history' = $state('changes');
  let status: GitStatus | undefined = $state.raw();
  let selected: { file: GitFile; staged: boolean } | undefined = $state.raw();
  let diff: { diff: string; truncated: boolean } | undefined = $state.raw();
  let commits: Commit[] = $state.raw([]);
  let more = $state(false);
  let commit: CommitDetail | undefined = $state.raw();
  /** A change arrived while the tab was hidden; reload when it is shown. */
  let stale = false;
  const statusLoader = new Loader();
  const historyLoader = new Loader();
  const diffLoader = new Loader();
  const commitLoader = new Loader();
  const listError = $derived(statusLoader.error || historyLoader.error || commitLoader.error);

  const label: Record<string, string> = {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    R: 'Renamed',
    C: 'Copied',
    U: 'Conflict',
    T: 'Type changed',
    '?': 'Untracked',
  };

  let files = $derived(status?.repo ? status.files : []);
  let staged = $derived(files.filter((file) => file.index !== ' ' && file.index !== '?'));
  let unstaged = $derived(files.filter((file) => file.worktree !== ' '));

  async function load() {
    stale = false;
    const id = sessionId;
    const next = await statusLoader.run(
      (signal) => panelApi.gitStatus(id, signal),
      'Unable to read Git status.',
    );
    if (!next || id !== sessionId) return;
    status = next;
    if (view === 'history' && next.repo) void refreshHistory();
    if (selected) void openDiff(selected.file, selected.staged, false);
  }

  const HISTORY_PAGE = 50;
  /** Append the next page ("Load more"), or load the first one. */
  async function loadHistory(reset: boolean) {
    const id = sessionId;
    const skip = reset ? 0 : commits.length;
    const page = await historyLoader.run(
      (signal) => panelApi.gitLog(id, skip, HISTORY_PAGE, signal),
      'Unable to load history.',
    );
    if (!page || id !== sessionId) return;
    commits = reset ? page.commits : [...commits, ...page.commits];
    more = page.more;
  }

  /**
   * Re-read the newest page and prepend commits made since, keeping pages the
   * user already loaded. A rewritten history (no overlap) starts over.
   */
  async function refreshHistory() {
    if (!commits.length) return loadHistory(true);
    const id = sessionId;
    const page = await historyLoader.run(
      (signal) => panelApi.gitLog(id, 0, HISTORY_PAGE, signal),
      'Unable to load history.',
    );
    if (!page || id !== sessionId) return;
    const overlap = page.commits.findIndex((item) => item.sha === commits[0]!.sha);
    if (overlap === -1) {
      commits = page.commits;
      more = page.more;
    } else if (overlap > 0) commits = [...page.commits.slice(0, overlap), ...commits];
  }

  async function openDiff(file: GitFile, isStaged: boolean, reset = true) {
    selected = { file, staged: isStaged };
    if (reset) diff = undefined;
    const id = sessionId;
    const result = await diffLoader.run(
      (signal) =>
        panelApi.gitDiff(
          id,
          { path: file.path, staged: isStaged, untracked: file.worktree === '?' },
          signal,
        ),
      'Unable to load diff.',
    );
    if (result && id === sessionId) diff = result;
  }

  async function openCommit(item: Commit) {
    commit = undefined;
    const id = sessionId;
    const result = await commitLoader.run(
      (signal) => panelApi.gitShow(id, item.sha, signal),
      'Unable to load commit.',
    );
    if (result && id === sessionId) commit = result;
  }

  function back() {
    diffLoader.abort();
    commitLoader.abort();
    selected = undefined;
    commit = undefined;
  }

  async function switchView(next: 'changes' | 'history') {
    view = next;
    back();
    if (next === 'history' && status?.repo && !commits.length) await loadHistory(true);
  }

  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const dir = (path: string) => path.split('/').slice(0, -1).join('/');
  const code = (file: GitFile, isStaged: boolean) => (isStaged ? file.index : file.worktree);

  watch(
    () => sessionId,
    () => {
      for (const loader of [statusLoader, historyLoader, diffLoader, commitLoader]) loader.abort();
      status = undefined;
      commits = [];
      more = false;
      commit = undefined;
      selected = undefined;
      diff = undefined;
      void load();
    },
    { immediate: true },
  );
  // The working tree may have changed.
  onDestroy(
    app.onPanel((signal) => {
      if (signal.type === 'changed' && !signal.sections.includes('git')) return;
      if (active) void load();
      else stale = true;
    }),
  );
  watch(
    () => active,
    (shown) => {
      if (shown && stale) void load();
    },
  );
</script>

<div class="tab-body">
  {#if selected}
    <div class="drill-head">
      <button class="icon-button small" type="button" aria-label="Back" onclick={back}
        ><ArrowLeft size={16} /></button
      >
      <button
        class="drill-title linkish"
        type="button"
        title="Open file"
        onclick={() => selected && onopenfile(selected.file.path)}
      >
        {selected.file.path}
      </button>
      <span class="chip"
        >{selected.staged ? 'Staged' : (label[code(selected.file, false)] ?? 'Changed')}</span
      >
    </div>
    {#if diffLoader.error}<p class="panel-error">{diffLoader.error}</p>
    {:else if diff}<DiffView diff={diff.diff} truncated={diff.truncated} />{:else}<p
        class="panel-empty"
      >
        Loading diff…
      </p>{/if}
  {:else if commit}
    <div class="drill-head">
      <button class="icon-button small" type="button" aria-label="Back" onclick={back}
        ><ArrowLeft size={16} /></button
      >
      <span class="drill-title mono">{commit.sha.slice(0, 10)}</span>
    </div>
    <div class="commit-card">
      <pre class="commit-message">{commit.message}</pre>
      <p class="commit-meta">{commit.author} · {new Date(commit.time).toLocaleString()}</p>
      {#if commit.refs.length}<p class="refs">
          {#each commit.refs as ref}<span class="chip">{ref}</span>{/each}
        </p>{/if}
    </div>
    <DiffView diff={commit.diff} truncated={commit.truncated} />
  {:else}
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="Git view">
        <button
          role="tab"
          type="button"
          class:active={view === 'changes'}
          aria-selected={view === 'changes'}
          onclick={() => switchView('changes')}
          >Changes{#if files.length}<span class="count">{files.length}</span>{/if}</button
        >
        <button
          role="tab"
          type="button"
          class:active={view === 'history'}
          aria-selected={view === 'history'}
          onclick={() => switchView('history')}>History</button
        >
      </div>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh"
        onclick={load}
        disabled={statusLoader.loading}
        ><RefreshCw class={statusLoader.loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    {#if listError}<p class="panel-error">{listError}</p>{/if}
    {#if status && !status.repo}
      <p class="panel-empty">This workspace is not a Git repository.</p>
    {:else if status?.repo}
      <div class="branch-line">
        <GitBranch size={14} />
        <strong>{status.branch ?? 'detached'}</strong>
        {#if status.upstream}<span class="muted">→ {status.upstream}</span>{/if}
        {#if status.ahead}<span class="chip">↑{status.ahead}</span>{/if}
        {#if status.behind}<span class="chip">↓{status.behind}</span>{/if}
      </div>
      {#if view === 'changes'}
        {#if !files.length}
          <p class="panel-empty">Working tree clean.</p>
        {:else}
          {#each [{ title: 'Staged', list: staged, isStaged: true }, { title: 'Changes', list: unstaged, isStaged: false }] as group}
            {#if group.list.length}
              <div class="group-title">{group.title}<span>{group.list.length}</span></div>
              <ul class="file-list">
                {#each group.list as file (file.path + group.isStaged)}
                  <li>
                    <button
                      type="button"
                      class="file-row"
                      onclick={() => openDiff(file, group.isStaged)}
                    >
                      <span
                        class="status-code s-{code(file, group.isStaged) === '?'
                          ? 'U'
                          : code(file, group.isStaged)}"
                        title={label[code(file, group.isStaged)] ?? ''}
                        >{code(file, group.isStaged) === '?'
                          ? 'U'
                          : code(file, group.isStaged)}</span
                      >
                      <span class="file-name">{base(file.path)}</span>
                      <span class="file-dir"
                        >{file.origPath ? `${file.origPath} →` : dir(file.path)}</span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
          {#if status.truncated}<p class="panel-empty">Showing the first 5,000 files.</p>{/if}
        {/if}
      {:else if !commits.length}
        <p class="panel-empty">No commits yet.</p>
      {:else}
        <ul class="commit-list">
          {#each commits as item (item.sha)}
            <li>
              <button type="button" class="commit-row" onclick={() => openCommit(item)}>
                <GitCommitHorizontal size={15} />
                <span class="commit-text">
                  <span class="commit-subject">{item.subject}</span>
                  <span class="commit-sub"
                    ><span class="mono">{item.short}</span> · {item.author} · {ago(
                      item.time,
                    )}{#each item.refs.slice(0, 2) as ref}
                      <span class="chip">{ref.replace('HEAD -> ', '')}</span>{/each}</span
                  >
                </span>
              </button>
            </li>
          {/each}
        </ul>
        {#if more}<button
            class="load-more"
            type="button"
            disabled={historyLoader.loading}
            onclick={() => loadHistory(false)}>Load more</button
          >{/if}
      {/if}
    {:else if statusLoader.loading}
      <p class="panel-empty">Loading…</p>
    {/if}
  {/if}
</div>
