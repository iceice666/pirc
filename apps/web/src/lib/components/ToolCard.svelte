<script lang="ts">
  import { untrack } from 'svelte';
  import {
    Check,
    ChevronDown,
    CircleAlert,
    FilePen,
    FilePlus,
    FileText,
    FolderTree,
    LoaderCircle,
    Search,
    Terminal,
    Wrench,
  } from '@lucide/svelte';
  import { app } from '../app.svelte';
  import { clipText, highlightCode, languageForPath, rendererTick } from '../markdown';
  import { panelApi } from '../panel-api';
  import { elapsed } from '../time';
  import type { ToolCall } from '../types';

  interface Props {
    tool: ToolCall;
  }

  let { tool }: Props = $props();
  let open = $state(false);
  let userToggled = $state(false);

  /** Primary argument shown next to the tool name, like a terminal prompt. */
  function describe(name: string, input: Record<string, any>): string {
    const first = (value: unknown) => (typeof value === 'string' ? value : '');
    switch (name) {
      case 'bash':
        return first(input.command);
      case 'read': {
        const range =
          typeof input.offset === 'number'
            ? `:${input.offset}${typeof input.limit === 'number' ? `–${input.offset + input.limit - 1}` : ''}`
            : '';
        return `${first(input.path)}${range}`;
      }
      case 'edit':
      case 'write':
      case 'ls':
        return first(input.path);
      case 'grep':
      case 'find':
        return [first(input.pattern), input.path ? `in ${input.path}` : '']
          .filter(Boolean)
          .join(' ');
      default: {
        const value = Object.values(input).find((item) => typeof item === 'string');
        return typeof value === 'string' ? value : '';
      }
    }
  }

  /** Input keys that the summary line or a dedicated view already show. */
  function residualInput(
    name: string,
    input: Record<string, any>,
  ): Record<string, any> | undefined {
    const hidden: Record<string, string[]> = {
      bash: ['command'],
      read: ['path', 'offset', 'limit'],
      edit: ['path', 'edits'],
      write: ['path', 'content'],
      ls: ['path'],
    };
    const skip = hidden[name];
    if (!skip) return Object.keys(input).length ? input : undefined;
    const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !skip.includes(key)));
    return Object.keys(rest).length ? rest : undefined;
  }

  function toggle() {
    userToggled = true;
    open = !open;
  }

  // Highlighting only runs for an expanded card, and re-runs once the lazily
  // loaded highlighter arrives (`$rendererTick`).
  // Failures open by default so errors are never hidden behind a click.
  $effect.pre(() => {
    const failed = tool.status === 'failed';
    if (!untrack(() => userToggled)) open = failed;
  });
  let args = $derived(
    (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, any>,
  );
  let statusLabel = $derived(
    tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Done',
  );
  let Icon = $derived(
    tool.name === 'bash'
      ? Terminal
      : tool.name === 'read'
        ? FileText
        : tool.name === 'edit'
          ? FilePen
          : tool.name === 'write'
            ? FilePlus
            : tool.name === 'grep' || tool.name === 'find'
              ? Search
              : tool.name === 'ls'
                ? FolderTree
                : Wrench,
  );
  let summary = $derived(describe(tool.name, args));
  const recordingSession = $derived(app.usingDemo ? '' : (app.sessionState?.session.id ?? ''));
  let fileLanguage = $derived(languageForPath(args.path));
  let duration = $derived(elapsed(tool.startedAt, tool.endedAt));
  let extraInput = $derived(
    tool.input !== undefined && typeof tool.input !== 'object'
      ? String(tool.input)
      : residualInput(tool.name, args),
  );
  // Only an expanded card shows the diff; a collapsed one skips splitting it.
  let diffLines = $derived(open && tool.diff ? tool.diff.split('\n') : []);
  let pendingEdits = $derived(
    open && !tool.diff && tool.name === 'edit' && Array.isArray(args.edits) ? args.edits : [],
  );
  const commandHtml = $derived.by(() => {
    void $rendererTick;
    return open && tool.name === 'bash' && typeof args.command === 'string'
      ? highlightCode(args.command, 'bash')
      : '';
  });
  const contentHtml = $derived.by(() => {
    void $rendererTick;
    return open && tool.name === 'write' && typeof args.content === 'string'
      ? highlightCode(clipText(args.content), fileLanguage)
      : '';
  });
  const inputHtml = $derived.by(() => {
    void $rendererTick;
    if (!open || extraInput === undefined) return '';
    return typeof extraInput === 'string'
      ? highlightCode(extraInput)
      : highlightCode(JSON.stringify(extraInput, null, 2), 'json');
  });
  const outputHtml = $derived.by(() => {
    void $rendererTick;
    if (!open || !tool.output) return '';
    const output = clipText(tool.output);
    return tool.name === 'read' && tool.status !== 'failed'
      ? highlightCode(output, fileLanguage)
      : highlightCode(output);
  });
</script>

<div
  class:failed={tool.status === 'failed'}
  class:running={tool.status === 'running'}
  class="tool-card"
  data-tool={tool.name}
>
  <button class="tool-summary" type="button" onclick={toggle} aria-expanded={open}>
    <span class="tool-icon" aria-hidden="true"><Icon size={14} strokeWidth={1.8} /></span>
    <span class="tool-name">
      <strong>{tool.title ?? tool.name}</strong>
      {#if summary}<code title={summary}>{summary}</code>{:else}<span>{statusLabel}</span>{/if}
    </span>
    {#if duration}<span class="tool-duration">{duration}</span>{/if}
    <span class="tool-status" role="img" aria-label={statusLabel} title={statusLabel}>
      {#if tool.status === 'running'}
        <LoaderCircle class="spin" size={15} />
      {:else if tool.status === 'failed'}
        <CircleAlert size={15} />
      {:else}
        <Check size={15} />
      {/if}
    </span>
    <ChevronDown class={open ? 'rotated' : ''} size={16} aria-hidden="true" />
  </button>
  {#if tool.recording && recordingSession}
    <!-- A browser recording (browser_record), always visible so it can be reviewed. -->
    <div class="tool-recording">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        controls
        preload="metadata"
        src={panelApi.recordingUrl(recordingSession, tool.recording)}
      ></video>
    </div>
  {/if}
  {#if open}
    <div class="tool-content">
      {#if tool.name === 'bash' && typeof args.command === 'string'}
        <section class="tool-section">
          <span class="tool-label">Command</span>
          <pre class="tool-command"><code class="hljs">{@html commandHtml}</code></pre>
        </section>
      {/if}
      {#if tool.name === 'write' && typeof args.content === 'string'}
        <section class="tool-section">
          <span class="tool-label">Content</span>
          <pre><code class="hljs">{@html contentHtml}</code></pre>
        </section>
      {/if}
      {#if tool.diff}
        <section class="tool-section">
          <span class="tool-label">Diff</span>
          <pre class="tool-diff">{#each diffLines as line}<span
                class:add={line.startsWith('+')}
                class:del={line.startsWith('-')}
                class:hunk={line.startsWith('@@')}>{line}{'\n'}</span
              >{/each}</pre>
        </section>
      {:else if pendingEdits.length}
        <section class="tool-section">
          <span class="tool-label">Edits</span>
          <pre
            class="tool-diff">{#each pendingEdits as edit}{#each String(edit.oldText ?? '').split('\n') as line}<span
                  class="del">-{line}{'\n'}</span
                >{/each}{#each String(edit.newText ?? '').split('\n') as line}<span class="add"
                  >+{line}{'\n'}</span
                >{/each}<span class="hunk">{'\n'}</span>{/each}</pre>
        </section>
      {/if}
      {#if extraInput !== undefined}
        <section class="tool-section">
          <span class="tool-label">Input</span>
          <pre><code class="hljs">{@html inputHtml}</code></pre>
        </section>
      {/if}
      {#if tool.output}
        <section class="tool-section">
          <span class="tool-label">{tool.status === 'failed' ? 'Error' : 'Output'}</span>
          <pre class:error={tool.status === 'failed'}><code class="hljs">{@html outputHtml}</code
            ></pre>
        </section>
      {/if}
      {#if tool.images?.length}
        <section class="tool-section tool-images">
          {#each tool.images as image}<img
              src={image.url}
              alt="Tool output"
              loading="lazy"
            />{/each}
        </section>
      {/if}
      {#if !tool.output && !tool.diff && !tool.images?.length}
        <p class="tool-empty">
          {tool.status === 'running' ? 'Waiting for output…' : 'No output returned.'}
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-recording {
    padding: 0 10px 10px;
  }
  .tool-recording video {
    display: block;
    width: 100%;
    max-height: 420px;
    border-radius: var(--radius-sm);
    background: #000;
  }
  .tool-images img {
    max-width: min(100%, 360px);
    max-height: 280px;
    border-radius: var(--radius-md);
    object-fit: contain;
    background: var(--bg-subtle);
  }
  .tool-card {
    min-width: 0;
    border-radius: var(--radius-sm);
  }
  .tool-summary {
    width: 100%;
    min-height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 4px;
    margin-left: -4px;
    width: calc(100% + 4px);
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    text-align: left;
    font-size: 14px;
  }
  @media (hover: none) {
    .tool-summary {
      min-height: 40px;
    }
  }
  .tool-summary:hover {
    background: var(--bg-hover);
  }
  .tool-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--muted);
  }
  .tool-name {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .tool-name strong {
    flex: none;
    color: var(--text-2);
    font-weight: 400;
    white-space: nowrap;
  }
  .tool-name span,
  .tool-name code {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tool-name code {
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .tool-duration {
    flex: none;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .tool-status {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--success);
  }
  .tool-card.running .tool-status {
    color: var(--accent);
  }
  .tool-card.failed .tool-status,
  .tool-card.failed .tool-name strong {
    color: var(--danger);
  }
  .tool-summary > :global(svg) {
    flex: none;
    color: var(--faint);
    transition: transform 0.18s var(--ease);
  }
  .tool-summary:not(:hover):not([aria-expanded='true']) > :global(svg:last-child) {
    opacity: 0;
  }
  .tool-summary > :global(svg.rotated) {
    transform: rotate(180deg);
  }
  .tool-content {
    max-height: 420px;
    overflow: auto;
    display: grid;
    gap: 10px;
    margin: 4px 0 8px 22px;
    padding: 12px;
    border-radius: var(--radius-md);
    color: var(--code-ink);
    background: var(--code-bg);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .tool-section {
    min-width: 0;
    display: grid;
    gap: 4px;
  }
  .tool-label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
  }
  .tool-content pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-content pre code {
    font: inherit;
    background: none;
    padding: 0;
  }
  .tool-content pre.error {
    color: var(--danger);
  }
  .tool-diff .add {
    display: block;
    color: var(--success);
    background: rgb(34 160 107 / 10%);
  }
  .tool-diff .del {
    display: block;
    color: var(--danger);
    background: rgb(220 50 50 / 9%);
  }
  .tool-diff .hunk {
    color: var(--muted);
  }
  .tool-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tool-empty {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
