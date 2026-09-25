<script lang="ts">
  import { ArrowLeft, GitBranch, GitCommitHorizontal, RefreshCw } from '@lucide/svelte';
  import {
    panelApi,
    type Commit,
    type CommitDetail,
    type GitFile,
    type GitStatus,
  } from '../../panel-api';
  import DiffView from './DiffView.svelte';

  export let sessionId: string;
  /** Bumped by the parent when the working tree may have changed. */
  export let refreshKey = 0;
  export let onopenfile: (path: string) => void = () => {};

  let view: 'changes' | 'history' = 'changes';
  let status: GitStatus | undefined;
  let error = '';
  let loading = false;
  let selected: { file: GitFile; staged: boolean } | undefined;
  let diff: { diff: string; truncated: boolean } | undefined;
  let commits: Commit[] = [];
  let more = false;
  let commit: CommitDetail | undefined;
  let loadedFor = '';

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

  $: files = status?.repo ? status.files : [];
  $: staged = files.filter((file) => file.index !== ' ' && file.index !== '?');
  $: unstaged = files.filter((file) => file.worktree !== ' ');

  async function load() {
    loading = true;
    error = '';
    const id = sessionId;
    try {
      const next = await panelApi.gitStatus(id);
      if (id !== sessionId) return;
      status = next;
      if (view === 'history' && next.repo) await loadHistory(true);
      if (selected) await openDiff(selected.file, selected.staged, false);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to read Git status.';
    } finally {
      loading = false;
    }
  }

  async function loadHistory(reset: boolean) {
    const id = sessionId;
    const page = await panelApi.gitLog(id, reset ? 0 : commits.length);
    if (id !== sessionId) return;
    commits = reset ? page.commits : [...commits, ...page.commits];
    more = page.more;
  }

  async function openDiff(file: GitFile, isStaged: boolean, reset = true) {
    selected = { file, staged: isStaged };
    if (reset) diff = undefined;
    try {
      diff = await panelApi.gitDiff(sessionId, {
        path: file.path,
        staged: isStaged,
        untracked: file.worktree === '?',
      });
    } catch (cause) {
      diff = { diff: '', truncated: false };
      error = cause instanceof Error ? cause.message : 'Unable to load diff.';
    }
  }

  async function openCommit(item: Commit) {
    commit = undefined;
    try {
      commit = await panelApi.gitShow(sessionId, item.sha);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to load commit.';
    }
  }

  async function switchView(next: 'changes' | 'history') {
    view = next;
    commit = undefined;
    selected = undefined;
    if (next === 'history' && status?.repo && !commits.length) {
      try {
        await loadHistory(true);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Unable to load history.';
      }
    }
  }

  function ago(time: number) {
    const seconds = Math.max(0, (Date.now() - time) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
    return new Date(time).toLocaleDateString();
  }
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const dir = (path: string) => path.split('/').slice(0, -1).join('/');
  const code = (file: GitFile, isStaged: boolean) => (isStaged ? file.index : file.worktree);

  $: if (sessionId !== loadedFor) {
    loadedFor = sessionId;
    status = undefined;
    commits = [];
    commit = undefined;
    selected = undefined;
    void load();
  }
  let lastRefresh = refreshKey;
  $: if (refreshKey !== lastRefresh) {
    lastRefresh = refreshKey;
    void load();
  }
</script>

<div class="tab-body">
  {#if selected}
    <div class="drill-head">
      <button
        class="icon-button small"
        type="button"
        aria-label="Back"
        on:click={() => (selected = undefined)}><ArrowLeft size={16} /></button
      >
      <button
        class="drill-title linkish"
        type="button"
        title="Open file"
        on:click={() => selected && onopenfile(selected.file.path)}
      >
        {selected.file.path}
      </button>
      <span class="chip"
        >{selected.staged ? 'Staged' : (label[code(selected.file, false)] ?? 'Changed')}</span
      >
    </div>
    {#if diff}<DiffView diff={diff.diff} truncated={diff.truncated} />{:else}<p class="panel-empty">
        Loading diff…
      </p>{/if}
  {:else if commit}
    <div class="drill-head">
      <button
        class="icon-button small"
        type="button"
        aria-label="Back"
        on:click={() => (commit = undefined)}><ArrowLeft size={16} /></button
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
          on:click={() => switchView('changes')}
          >Changes{#if files.length}<span class="count">{files.length}</span>{/if}</button
        >
        <button
          role="tab"
          type="button"
          class:active={view === 'history'}
          aria-selected={view === 'history'}
          on:click={() => switchView('history')}>History</button
        >
      </div>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh"
        on:click={load}
        disabled={loading}><RefreshCw class={loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    {#if error}<p class="panel-error">{error}</p>{/if}
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
                      on:click={() => openDiff(file, group.isStaged)}
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
              <button type="button" class="commit-row" on:click={() => openCommit(item)}>
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
        {#if more}<button class="load-more" type="button" on:click={() => loadHistory(false)}
            >Load more</button
          >{/if}
      {/if}
    {:else if loading}
      <p class="panel-empty">Loading…</p>
    {/if}
  {/if}
</div>
