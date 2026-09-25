<script lang="ts">
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
  import { highlightCode, languageForPath } from '../markdown';
  import type { ToolCall } from '../types';

  export let tool: ToolCall;
  let open = false;
  let userToggled = false;

  // Failures open by default so errors are never hidden behind a click.
  $: if (!userToggled) open = tool.status === 'failed';

  $: args = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, any>;
  $: statusLabel =
    tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Done';
  $: icon =
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
                : Wrench;
  $: summary = describe(tool.name, args);
  $: fileLanguage = languageForPath(args.path);
  $: duration = elapsed(tool.startedAt, tool.endedAt);

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

  function elapsed(start?: string, end?: string): string {
    if (!start || !end) return '';
    const ms = Date.parse(end) - Date.parse(start);
    if (!(ms >= 0)) return '';
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
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

  $: extraInput =
    tool.input !== undefined && typeof tool.input !== 'object'
      ? String(tool.input)
      : residualInput(tool.name, args);
  $: diffLines = (tool.diff ?? '').split('\n');
  $: pendingEdits =
    !tool.diff && tool.name === 'edit' && Array.isArray(args.edits) ? args.edits : [];
</script>

<div
  class:failed={tool.status === 'failed'}
  class:running={tool.status === 'running'}
  class="tool-card"
  data-tool={tool.name}
>
  <button class="tool-summary" type="button" on:click={toggle} aria-expanded={open}>
    <span class="tool-icon" aria-hidden="true"
      ><svelte:component this={icon} size={14} strokeWidth={1.8} /></span
    >
    <span class="tool-name">
      <strong>{tool.title ?? tool.name}</strong>
      {#if summary}<code title={summary}>{summary}</code>{:else}<span>{statusLabel}</span>{/if}
    </span>
    {#if duration}<span class="tool-duration">{duration}</span>{/if}
    <span class="tool-status" aria-label={statusLabel} title={statusLabel}>
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
  {#if open}
    <div class="tool-content">
      {#if tool.name === 'bash' && typeof args.command === 'string'}
        <section class="tool-section">
          <span class="tool-label">Command</span>
          <pre class="tool-command"><code class="hljs"
              >{@html highlightCode(args.command, 'bash')}</code
            ></pre>
        </section>
      {/if}
      {#if tool.name === 'write' && typeof args.content === 'string'}
        <section class="tool-section">
          <span class="tool-label">Content</span>
          <pre><code class="hljs">{@html highlightCode(args.content, fileLanguage)}</code></pre>
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
          <pre><code class="hljs"
              >{@html typeof extraInput === 'string'
                ? highlightCode(extraInput)
                : highlightCode(JSON.stringify(extraInput, null, 2), 'json')}</code
            ></pre>
        </section>
      {/if}
      {#if tool.output}
        <section class="tool-section">
          <span class="tool-label">{tool.status === 'failed' ? 'Error' : 'Output'}</span>
          <pre class:error={tool.status === 'failed'}><code class="hljs"
              >{@html tool.name === 'read' && tool.status !== 'failed'
                ? highlightCode(tool.output, fileLanguage)
                : highlightCode(tool.output)}</code
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
