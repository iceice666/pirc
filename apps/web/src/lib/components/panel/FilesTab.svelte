<script lang="ts">
  import { ArrowLeft, ChevronRight, Code, Eye, File, Folder, RefreshCw } from '@lucide/svelte';
  import { highlightCode, languageForPath } from '../../markdown';
  import { panelApi, type DirEntry, type FileContent } from '../../panel-api';
  import Markdown from '../Markdown.svelte';

  export let sessionId: string;
  /** Set by the parent (e.g. a Git file link) to open a file directly. */
  export let openPath: string | undefined = undefined;
  export let refreshKey = 0;

  let dir = '';
  let entries: DirEntry[] = [];
  let truncated = false;
  let file: FileContent | undefined;
  let rendered = true;
  let error = '';
  let loading = false;
  let loadedFor = '';

  const MAX_HIGHLIGHT = 200_000;

  async function listDir(path: string) {
    loading = true;
    error = '';
    const id = sessionId;
    try {
      const result = await panelApi.files(id, path);
      if (id !== sessionId) return;
      dir = result.path;
      entries = result.entries;
      truncated = result.truncated;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to list directory.';
    } finally {
      loading = false;
    }
  }

  async function openFile(path: string) {
    error = '';
    const id = sessionId;
    try {
      const result = await panelApi.file(id, path);
      if (id !== sessionId) return;
      file = result;
      rendered = true;
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent !== dir) void listDir(parent);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to open file.';
    }
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

  $: crumbs = dir ? dir.split('/') : [];
  $: language = file ? languageForPath(file.path) : undefined;
  $: isMarkdown = !!file && /\.(md|markdown|mdx)$/i.test(file.path);
  $: lineNumbers = Array.from(
    { length: (file?.content ?? '').replace(/\n$/, '').split('\n').length },
    (_, index) => index + 1,
  ).join('\n');
  $: highlighted =
    file?.content !== undefined && file.content.length <= MAX_HIGHLIGHT && language
      ? highlightCode(file.content, language)
      : undefined;

  $: if (sessionId !== loadedFor) {
    loadedFor = sessionId;
    file = undefined;
    entries = [];
    void listDir('');
  }
  let lastOpen: string | undefined;
  $: if (openPath && openPath !== lastOpen) {
    lastOpen = openPath;
    void openFile(openPath);
  }
  let lastRefresh = refreshKey;
  $: if (refreshKey !== lastRefresh) {
    lastRefresh = refreshKey;
    void listDir(dir);
    if (file) void openFile(file.path);
  }
</script>

<div class="tab-body">
  {#if file}
    <div class="drill-head">
      <button
        class="icon-button small"
        type="button"
        aria-label="Back to folder"
        on:click={() => (file = undefined)}><ArrowLeft size={16} /></button
      >
      <span class="drill-title" title={file.path}>{file.path}</span>
      {#if isMarkdown && !file.binary}
        <button
          class="icon-button small"
          type="button"
          aria-label={rendered ? 'Show source' : 'Show rendered'}
          on:click={() => (rendered = !rendered)}
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
      <div class="doc"><Markdown source={file.content ?? ''} /></div>
    {:else}
      <div class="code-view">
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
        <button type="button" on:click={() => listDir('')}>workspace</button>
        {#each crumbs as crumb, index}
          <ChevronRight size={12} />
          <button type="button" on:click={() => listDir(crumbs.slice(0, index + 1).join('/'))}
            >{crumb}</button
          >
        {/each}
      </nav>
      <button
        class="icon-button small"
        type="button"
        aria-label="Refresh"
        on:click={() => listDir(dir)}
        disabled={loading}><RefreshCw class={loading ? 'spin' : ''} size={15} /></button
      >
    </div>
    {#if error}<p class="panel-error">{error}</p>{/if}
    <ul class="file-list">
      {#if dir}
        <li>
          <button
            type="button"
            class="file-row"
            on:click={() => listDir(crumbs.slice(0, -1).join('/'))}
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
            on:click={() => open(entry)}
            disabled={entry.kind === 'other'}
          >
            {#if entry.kind === 'dir'}<Folder size={15} />{:else}<File size={15} />{/if}
            <span class="file-name">{entry.name}</span>
            <span class="file-dir">{size(entry.size)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if !loading && !entries.length && !error}<p class="panel-empty">Empty folder.</p>{/if}
    {#if truncated}<p class="panel-empty">Showing the first 2,000 entries.</p>{/if}
  {/if}
</div>
