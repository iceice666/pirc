<script lang="ts">
  /**
   * The Git pane (design screen 6): two columns. The left holds the branch, the
   * uncommitted changes and the history; the right shows the diff of whatever
   * is selected — a changed file or a commit, the newest commit by default.
   * Every action the old Changes/History view had stays here: refresh, loading
   * more history, opening a changed file in Files, and the staged/unstaged
   * split each file's diff is taken from.
   */
  import { GitBranch, GitCommitHorizontal, RefreshCw } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { engine } from '../../engine.svelte';
  import { locale, t } from '../../i18n';
  import type { MessageKey } from '../../i18n/messages';
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

  let status: GitStatus | undefined = $state.raw();
  let selectedFile: { file: GitFile; staged: boolean } | undefined = $state.raw();
  let fileDiff: { diff: string; truncated: boolean } | undefined = $state.raw();
  let commits: Commit[] = $state.raw([]);
  let more = $state(false);
  let selectedSha: string | undefined = $state.raw();
  let commit: CommitDetail | undefined = $state.raw();
  /** A change arrived while the tab was hidden; reload when it is shown. */
  let stale = false;
  const statusLoader = new Loader();
  const historyLoader = new Loader();
  const diffLoader = new Loader();
  const commitLoader = new Loader();
  const listError = $derived(statusLoader.error || historyLoader.error || commitLoader.error);

  /** Git's status letters, as message keys; `stateLabel` translates one. */
  const stateKeys: Record<string, MessageKey> = {
    M: 'panel.git.state.modified',
    A: 'panel.git.state.added',
    D: 'panel.git.state.deleted',
    R: 'panel.git.state.renamed',
    C: 'panel.git.state.copied',
    U: 'panel.git.state.conflict',
    T: 'panel.git.state.typeChanged',
    '?': 'panel.git.state.untracked',
  };

  let files = $derived(status?.repo ? status.files : []);
  let staged = $derived(files.filter((file) => file.index !== ' ' && file.index !== '?'));
  let unstaged = $derived(files.filter((file) => file.worktree !== ' '));
  /** The two lists of the changes view; their titles are message keys. */
  let groups: Array<{ title: MessageKey; list: GitFile[]; isStaged: boolean }> = $derived([
    { title: 'panel.git.staged', list: staged, isStaged: true },
    { title: 'panel.git.changes', list: unstaged, isStaged: false },
  ]);

  async function load() {
    stale = false;
    const id = sessionId;
    const next = await statusLoader.run(
      (signal) => panelApi.gitStatus(id, signal),
      t('panel.git.couldNotStatus'),
    );
    if (!next || id !== sessionId) return;
    status = next;
    if (next.repo) {
      if (commits.length) void refreshHistory();
      else void loadHistory(true);
    }
    // Keep the diff on screen current, and show the newest commit by default.
    if (selectedFile) void openDiff(selectedFile.file, selectedFile.staged, false);
    else if (selectedSha) void openCommit(selectedSha, false);
  }

  const HISTORY_PAGE = 50;
  /** Append the next page ("Load more"), or load the first one. */
  async function loadHistory(reset: boolean) {
    const id = sessionId;
    const skip = reset ? 0 : commits.length;
    const page = await historyLoader.run(
      (signal) => panelApi.gitLog(id, skip, HISTORY_PAGE, signal),
      t('panel.git.couldNotHistory'),
    );
    if (!page || id !== sessionId) return;
    commits = reset ? page.commits : [...commits, ...page.commits];
    more = page.more;
    // The design opens on the newest commit's diff.
    if (reset && commits.length && !selectedFile && !selectedSha) void openCommit(commits[0]!.sha);
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
      t('panel.git.couldNotHistory'),
    );
    if (!page || id !== sessionId) return;
    const overlap = page.commits.findIndex((item) => item.sha === commits[0]!.sha);
    if (overlap === -1) {
      commits = page.commits;
      more = page.more;
    } else if (overlap > 0) commits = [...page.commits.slice(0, overlap), ...commits];
  }

  async function openDiff(file: GitFile, isStaged: boolean, reset = true) {
    selectedSha = undefined;
    commit = undefined;
    commitLoader.abort();
    selectedFile = { file, staged: isStaged };
    if (reset) fileDiff = undefined;
    const id = sessionId;
    const result = await diffLoader.run(
      (signal) =>
        panelApi.gitDiff(
          id,
          { path: file.path, staged: isStaged, untracked: file.worktree === '?' },
          signal,
        ),
      t('panel.git.couldNotDiff'),
    );
    if (result && id === sessionId) fileDiff = result;
  }

  async function openCommit(sha: string, reset = true) {
    diffLoader.abort();
    selectedFile = undefined;
    fileDiff = undefined;
    selectedSha = sha;
    if (reset) commit = undefined;
    const id = sessionId;
    const result = await commitLoader.run(
      (signal) => panelApi.gitShow(id, sha, signal),
      t('panel.git.couldNotCommit'),
    );
    if (result && id === sessionId) commit = result;
  }

  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const dir = (path: string) => path.split('/').slice(0, -1).join('/');
  const code = (file: GitFile, isStaged: boolean) => (isStaged ? file.index : file.worktree);
  /** What Git says about a file, in the current locale ('' for a letter we do not know). */
  const stateLabel = (file: GitFile, isStaged: boolean) => {
    const key = stateKeys[code(file, isStaged)];
    return key ? t(key) : '';
  };
  const letter = (file: GitFile, isStaged: boolean) => {
    const value = code(file, isStaged);
    return value === '?' ? 'U' : value;
  };
  const isSelectedFile = (file: GitFile, isStaged: boolean) =>
    selectedFile?.file.path === file.path && selectedFile.staged === isStaged;

  /** `+2` and `−4` for the diff on screen, counted from its hunks. */
  function stats(diff: string | undefined): { add: number; del: number } {
    let add = 0;
    let del = 0;
    let inHunk = false;
    for (const line of (diff ?? '').split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
      } else if (inHunk && line.startsWith('+')) add++;
      else if (inHunk && line.startsWith('-')) del++;
    }
    return { add, del };
  }
  const shown = $derived(stats(commit?.diff ?? fileDiff?.diff));
  const subject = (message: string) => message.split('\n')[0] ?? '';
  /** The design's history line says HEAD for the ref the branch is on. */
  const refLabel = (ref: string) => (ref.startsWith('HEAD -> ') ? 'HEAD' : ref);
  const dateOf = (time: number) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(time);

  watch(
    () => sessionId,
    () => {
      for (const loader of [statusLoader, historyLoader, diffLoader, commitLoader]) loader.abort();
      status = undefined;
      commits = [];
      more = false;
      commit = undefined;
      selectedFile = undefined;
      selectedSha = undefined;
      fileDiff = undefined;
      void load();
    },
    { immediate: true },
  );
  // The working tree may have changed.
  onDestroy(
    engine.onPanel((signal) => {
      if (signal.type === 'changed' && !signal.sections.includes('git')) return;
      if (active) void load();
      else stale = true;
    }),
  );
  watch(
    () => active,
    (shownTab) => {
      if (shownTab && stale) void load();
    },
  );
</script>

<div class="tab-body git-pane">
  {#if listError}<p class="panel-error">{listError}</p>{/if}
  {#if status && !status.repo}
    <p class="panel-empty">{t('panel.git.notRepo')}</p>
  {:else if status?.repo || statusLoader.loading}
    <div class="columns">
      <section class="side" aria-label={t('panel.git.branchAndHistory')}>
        {#if status?.repo}
          <div class="branch-card">
            <div class="branch-row">
              <GitBranch size={14} />
              <code class="branch">{status.branch ?? t('panel.git.detached')}</code>
              {#if status.ahead}
                <span class="chip warn">
                  {#if status.upstream}
                    {t('panel.git.ahead', { count: status.ahead })}
                  {:else}
                    {t('panel.git.ahead', { count: status.ahead })} · {t('panel.git.notPushed')}
                  {/if}
                </span>
              {/if}
              {#if status.behind}
                <span class="chip">{t('panel.git.behind', { count: status.behind })}</span>
              {/if}
            </div>
            <span class="tree">
              {files.length
                ? t('panel.git.uncommitted', { count: files.length })
                : t('panel.git.clean')}
            </span>
          </div>
          {#each groups as group (group.title)}
            {#if group.list.length}
              <div class="group-title">
                {t(group.title)}<span>{group.list.length}</span>
              </div>
              <ul class="file-list">
                {#each group.list as file (file.path + group.isStaged)}
                  <li>
                    <button
                      type="button"
                      class="file-row"
                      aria-pressed={isSelectedFile(file, group.isStaged)}
                      onclick={() => void openDiff(file, group.isStaged)}
                    >
                      <span
                        class="status-code s-{letter(file, group.isStaged)}"
                        title={stateLabel(file, group.isStaged)}
                        >{letter(file, group.isStaged)}</span
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
          {#if status.truncated}<p class="panel-empty">{t('panel.git.truncated')}</p>{/if}
          <div class="group-title history-title">
            {t('panel.git.history')}
            <button
              class="icon-button small"
              type="button"
              aria-label={t('common.refresh')}
              title={t('common.refresh')}
              disabled={statusLoader.loading}
              onclick={() => void load()}
              ><RefreshCw class={statusLoader.loading ? 'spin' : ''} size={14} /></button
            >
          </div>
          {#if !commits.length}
            <p class="panel-empty">
              {historyLoader.loading ? t('common.loading') : t('panel.git.noCommits')}
            </p>
          {:else}
            <ul class="commit-list">
              {#each commits as item (item.sha)}
                <li>
                  <button
                    type="button"
                    class="commit-row"
                    aria-pressed={selectedSha === item.sha}
                    onclick={() => void openCommit(item.sha)}
                  >
                    <span class="commit-line">
                      <code class="sha">{item.short}</code>
                      <span class="subject">{item.subject}</span>
                    </span>
                    <span class="commit-sub">
                      {item.author} · {ago(item.time)}{#each item.refs.slice(0, 2) as ref}
                        <span class="chip">{refLabel(ref)}</span>{/each}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
            {#if more}<button
                class="load-more"
                type="button"
                disabled={historyLoader.loading}
                onclick={() => void loadHistory(false)}>{t('panel.git.loadMore')}</button
              >{/if}
          {/if}
        {:else}
          <p class="panel-empty">{t('common.loading')}</p>
        {/if}
      </section>

      <section
        class="main"
        aria-label={commit
          ? t('panel.git.diffOf', { name: commit.sha.slice(0, 7) })
          : selectedFile
            ? t('panel.git.diffOf', { name: selectedFile.file.path })
            : t('panel.git.history')}
      >
        <div class="diff-card">
          <header class="diff-head">
            {#if commit}
              <GitCommitHorizontal size={14} />
              <code class="path">{commit.sha.slice(0, 7)}</code>
              <span class="head-subject">{subject(commit.message)}</span>
            {:else if selectedFile}
              <button
                class="path linkish"
                type="button"
                title={t('panel.git.openFile')}
                onclick={() => selectedFile && onopenfile(selectedFile.file.path)}
                >{selectedFile.file.path}</button
              >
              <span class="chip"
                >{selectedFile.staged
                  ? t('panel.git.staged')
                  : stateLabel(selectedFile.file, false) || t('panel.git.changed')}</span
              >
            {:else}
              <span class="head-subject muted">{t('panel.git.select')}</span>
            {/if}
            {#if shown.add}<span class="count add">+{shown.add}</span>{/if}
            {#if shown.del}<span class="count del">−{shown.del}</span>{/if}
          </header>
          {#if commit}
            <p class="commit-meta">
              {commit.author} · {dateOf(commit.time)}
              {#each commit.refs as ref}<span class="chip">{refLabel(ref)}</span>{/each}
            </p>
            {#if commitLoader.error}<p class="panel-error">{commitLoader.error}</p>
            {:else if commit}<DiffView flush diff={commit.diff} truncated={commit.truncated} />{/if}
          {:else if selectedFile}
            {#if diffLoader.error}<p class="panel-error">{diffLoader.error}</p>
            {:else if fileDiff}<DiffView
                flush
                diff={fileDiff.diff}
                truncated={fileDiff.truncated}
              />{:else}<p class="panel-empty">{t('panel.git.loadingDiff')}</p>{/if}
          {:else if commitLoader.loading || diffLoader.loading}
            <p class="panel-empty">{t('common.loading')}</p>
          {:else}
            <p class="panel-empty">{t('panel.git.select')}</p>
          {/if}
        </div>
      </section>
    </div>
  {:else if statusLoader.loading}
    <p class="panel-empty">{t('common.loading')}</p>
  {/if}
</div>

<style>
  .git-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 100%;
  }
  .columns {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 16px;
  }
  .side {
    flex: 1 1 280px;
    min-width: 0;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .main {
    flex: 999 1 460px;
    min-width: 0;
  }
  .branch-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .branch-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--muted);
  }
  .branch {
    overflow: hidden;
    color: var(--ink);
    font: 500 13px var(--font-mono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tree {
    color: var(--faint);
    font-size: 12px;
  }
  .chip {
    padding: 0 6px;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-2);
    font-size: 11px;
    line-height: 18px;
  }
  .chip.warn {
    background: color-mix(in srgb, var(--warning) 15%, transparent);
    color: color-mix(in srgb, var(--warning) 60%, var(--ink));
    font-weight: 600;
  }
  .group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .group-title > span {
    letter-spacing: 0;
  }
  .group-title.history-title {
    margin-top: 4px;
  }
  .group-title.history-title .icon-button {
    margin-left: auto;
  }
  .file-list,
  .commit-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file-row,
  .commit-row {
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 13px;
    text-align: left;
  }
  .file-row:hover,
  .commit-row:hover {
    background: var(--bg-hover);
  }
  .file-row[aria-pressed='true'],
  .commit-row[aria-pressed='true'] {
    background: var(--bg-active);
    color: var(--ink);
  }
  .status-code {
    flex: none;
    width: 16px;
    color: var(--muted);
    font: 600 11.5px var(--font-mono);
    text-align: center;
  }
  .status-code.s-M,
  .status-code.s-T {
    color: var(--warning);
  }
  .status-code.s-A,
  .status-code.s-U {
    color: var(--success);
  }
  .status-code.s-D {
    color: var(--danger);
  }
  .status-code.s-R,
  .status-code.s-C {
    color: var(--accent);
  }
  .file-name {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .file-dir {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--faint);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .commit-row {
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 8px 10px;
  }
  .commit-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .sha {
    flex: none;
    color: var(--ink);
    font: 12px var(--font-mono);
  }
  .subject {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--ink);
  }
  .commit-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    color: var(--faint);
    font-size: 12px;
  }
  .load-more {
    justify-self: center;
    align-self: flex-start;
    padding: 6px 12px;
    border: 0;
    border-radius: 999px;
    color: var(--accent-ink);
    background: transparent;
    font-size: 12.5px;
  }
  .load-more:hover {
    background: var(--accent-soft);
  }
  .diff-card {
    min-width: 0;
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: var(--code-bg);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .diff-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 14px;
    border-bottom: 1px solid var(--line);
    color: var(--text-2);
    font-size: 12px;
  }
  .path {
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    font: 12px var(--font-mono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  button.path {
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
  }
  button.path:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .head-subject {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--ink);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .head-subject.muted {
    color: var(--muted);
    font-size: 12px;
  }
  .count {
    flex: none;
  }
  .count.add {
    color: color-mix(in srgb, var(--success) 75%, var(--ink));
  }
  .count.del {
    color: color-mix(in srgb, var(--danger) 60%, var(--ink));
  }
  .commit-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line);
    color: var(--faint);
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
</style>
