<script lang="ts">
  import { ArrowLeft, ChevronRight, Code, Eye, File, Folder, RefreshCw } from '@lucide/svelte';
  import { onDestroy, tick } from 'svelte';
  import { app } from '../../app.svelte';
  import type { FileTarget } from '../../file-links';
  import { Loader } from '../../loader.svelte';
  import { highlightCode, highlighterReady, languageForPath, rendererTick } from '../../markdown';
  import { panelApi, type DirEntry, type FileContent } from '../../panel-api';
  import { watch } from '../../watch.svelte';
  import Markdown from '../Markdown.svelte';

  interface Props {
    sessionId: string;
    /** Set by the parent (e.g. a Git or chat file link) to open a file directly. */
    openRequest?: (FileTarget & { seq: number }) | undefined;
    /** Shown in the panel; refreshes wait until then. */
    active?: boolean;
  }

  let { sessionId, openRequest = undefined, active = true }: Props = $props();

  let dir = $state('');
  let entries: DirEntry[] = $state.raw([]);
  let truncated = $state(false);
  let file: FileContent | undefined = $state.raw();
  let rendered = $state(true);
  /** Line range a link pointed at (1-based, inclusive), highlighted in the source view. */
  let focus: { line: number; endLine: number } | undefined = $state();
  let codeView: HTMLDivElement | undefined = $state();
  /** A change arrived while the tab was hidden; reload when it is shown. */
  let stale = false;
  const dirLoader = new Loader();
  const fileLoader = new Loader();
  const error = $derived(fileLoader.error || dirLoader.error);

  const MAX_HIGHLIGHT = 200_000;
  /** `.code-view pre`: 12px font × 1.55 line height, 8px top padding (app.css). */
  const LINE_HEIGHT = 12 * 1.55;
  const CODE_PAD = 8;

  async function listDir(path: string) {
    const id = sessionId;
    // A failed file open is reported in the folder view until the next navigation.
    if (!file) fileLoader.error = '';
    const result = await dirLoader.run(
      (signal) => panelApi.files(id, path, signal),
      'Unable to list directory.',
    );
    if (!result || id !== sessionId) return;
    dir = result.path;
    entries = result.entries;
    truncated = result.truncated;
  }

  /**
   * `refresh` re-reads the open file in place (keeping view mode and focus);
   * otherwise `lines` sets the focused range and a Markdown file with one
   * opens in source view so the lines can be shown.
   */
  async function openFile(path: string, lines: Omit<FileTarget, 'path'> = {}, refresh = false) {
    const id = sessionId;
    const result = await fileLoader.run(
      (signal) => panelApi.file(id, path, signal),
      (cause) => `${path}: ${cause instanceof Error ? cause.message : 'Unable to open file.'}`,
    );
    if (id !== sessionId) return;
    if (!result) {
      // Back to the folder view, where the error is shown.
      if (fileLoader.error) file = undefined;
      return;
    }
    file = result;
    if (!refresh) {
      const count = (result.content ?? '').replace(/\n$/, '').split('\n').length;
      const line = lines.line && Math.min(lines.line, count);
      focus = line
        ? { line, endLine: Math.min(Math.max(lines.endLine ?? line, line), count) }
        : undefined;
      rendered = !focus;
      if (focus) void scrollToFocus();
    }
    // The server answers with the workspace-relative path, even for absolute requests.
    const parent = result.path.split('/').slice(0, -1).join('/');
    if (parent !== dir) void listDir(parent);
  }

  function reload() {
    stale = false;
    void listDir(dir);
    if (file) void openFile(file.path, {}, true);
  }

  function closeFile() {
    fileLoader.abort();
    file = undefined;
    focus = undefined;
  }

  async function scrollToFocus() {
    await tick();
    if (!focus || !codeView) return;
    codeView.scrollIntoView({ block: 'nearest' });
    const top = CODE_PAD + (focus.line - 1) * LINE_HEIGHT;
    codeView.scrollTop = Math.max(0, top - codeView.clientHeight / 3);
  }

  function open(entry: DirEntry) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.kind === 'dir') void listDir(path);
    else void openFile(path);
  }

  function size(bytes?: number) {
    if (bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  /**
   * Highlighting a large file is slow and synchronous; keep the last few results
   * per file version so toggling views or reopening a file does not redo it.
   */
  const highlightCache = new Map<string, string>();
  function highlightFile(content: FileContent, language: string): string {
    const key = `${content.path}\n${content.modifiedAt}\n${content.size}`;
    const cached = highlightCache.get(key);
    if (cached !== undefined) return cached;
    const html = highlightCode(content.content ?? '', language);
    // Plain text until highlight.js loads; don't cache that.
    if (highlighterReady()) {
      highlightCache.set(key, html);
      if (highlightCache.size > 8) highlightCache.delete(highlightCache.keys().next().value!);
    }
    return html;
  }

  let crumbs = $derived(dir ? dir.split('/') : []);
  let language = $derived(file ? languageForPath(file.path) : undefined);
  let isMarkdown = $derived(!!file && /\.(md|markdown|mdx)$/i.test(file.path));
  let showSource = $derived(!!file && !file.binary && !(isMarkdown && rendered));
  let lineNumbers = $derived(
    showSource
      ? Array.from(
          { length: (file?.content ?? '').replace(/\n$/, '').split('\n').length },
          (_, index) => index + 1,
        ).join('\n')
      : '',
  );
  // Re-runs once the lazily loaded highlighter arrives (`$rendererTick`). A
  // rendered Markdown document is not highlighted at all.
  let highlighted = $derived.by(() => {
    void $rendererTick;
    return showSource &&
      file?.content !== undefined &&
      file.content.length <= MAX_HIGHLIGHT &&
      language
      ? highlightFile(file, language)
      : undefined;
  });

  watch(
    () => sessionId,
    () => {
      dirLoader.abort();
      fileLoader.abort();
      file = undefined;
      focus = undefined;
      entries = [];
      dir = '';
      stale = false;
      void listDir('');
    },
    { immediate: true },
  );
  watch(
    () => openRequest?.seq,
    () => {
      if (openRequest) void openFile(openRequest.path, openRequest);
    },
    { immediate: true },
  );
  // A finished run may have changed the working tree.
  onDestroy(
    app.onPanel((signal) => {
      if (signal.type !== 'run-finished') return;
      if (active) reload();
      else stale = true;
    }),
  );
  watch(
    () => active,
    (shown) => {
      if (shown && stale) reload();
    },
  );
</script>

<div class="tab-body">
  {#if file}
    <div class="drill-head">
      <button
        class="icon-button small"
        type="button"
        aria-label="Back to folder"
        onclick={closeFile}><ArrowLeft size={16} /></button
      >
      <span class="drill-title" title={file.path}
        >{file.path}{#if focus}<span class="drill-lines"
            >:{focus.line}{#if focus.endLine > focus.line}-{focus.endLine}{/if}</span
          >{/if}</span
      >
      {#if isMarkdown && !file.binary}
        <button
          class="icon-button small"
          type="button"
          aria-label={rendered ? 'Show source' : 'Show rendered'}
          onclick={() => (rendered = !rendered)}
        >
          {#if rendered}<Code size={15} />{:else}<Eye size={15} />{/if}
        </button>
      {/if}
    </div>
    <p class="file-meta">
      {size(file.size)} · modified {new Date(file.modifiedAt).toLocaleString()}
    </p>
    {#if file.binary}
      <p class="panel-empty">Binary file — not shown.</p>
    {:else if isMarkdown && rendered}
      <div class="doc">
        <Markdown
          source={file.content ?? ''}
          linkBase={file.path.split('/').slice(0, -1).join('/')}
        />
      </div>
    {:else}
      <div
        class="code-view"
        class:focused={!!focus}
        bind:this={codeView}
        style:--focus-top={focus ? `${CODE_PAD + (focus.line - 1) * LINE_HEIGHT}px` : undefined}
        style:--focus-height={focus
          ? `${(focus.endLine - focus.line + 1) * LINE_HEIGHT}px`
          : undefined}
      >
        <pre class="gutter" aria-hidden="true">{lineNumbers}</pre>
        <!-- highlightCode output is sanitized (see markdown.ts). -->
        {#if highlighted !== undefined}<pre class="hljs"><code>{@html highlighted}</code
            ></pre>{:else}<pre><code>{file.content ?? ''}</code></pre>{/if}
      </div>
    {/if}
    {#if file.truncated}<p class="panel-empty">Showing the first 1 MB.</p>{/if}
  {:else}
    <div class="toolbar">
      <nav class="crumbs" aria-label="Folder">
        <button type="button" onclick={() => listDir('')}>workspace</button>
        {#each crumbs as crumb, index}
          <ChevronRight size={12} />
          <button type="button" onclick={() => listDir(crumbs.slice(0, index + 1).join('/'))}
            >{crumb}</button
          >
        {/each}
      </nav>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh"
        onclick={reload}
        disabled={dirLoader.loading}
        ><RefreshCw class={dirLoader.loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    {#if error}<p class="panel-error">{error}</p>{/if}
    <ul class="file-list">
      {#if dir}
        <li>
          <button
            type="button"
            class="file-row"
            onclick={() => listDir(crumbs.slice(0, -1).join('/'))}
          >
            <Folder size={15} /><span class="file-name">..</span>
          </button>
        </li>
      {/if}
      {#each entries as entry (entry.name)}
        <li>
          <button
            type="button"
            class="file-row"
            onclick={() => open(entry)}
            disabled={entry.kind === 'other'}
          >
            {#if entry.kind === 'dir'}<Folder size={15} />{:else}<File size={15} />{/if}
            <span class="file-name">{entry.name}</span>
            <span class="file-dir">{size(entry.size)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if !dirLoader.loading && !entries.length && !error}<p class="panel-empty">
        Empty folder.
      </p>{/if}
    {#if truncated}<p class="panel-empty">Showing the first 2,000 entries.</p>{/if}
  {/if}
</div>
