<script lang="ts">
  /** Unified diff renderer: file headers, hunk headers, and +/- lines with gutters. */
  export let diff: string;
  export let truncated = false;

  type Line = {
    kind: 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
    text: string;
    old?: number;
    new?: number;
  };

  function parse(text: string): Line[] {
    const lines: Line[] = [];
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;
    for (const raw of text.split('\n')) {
      if (raw.startsWith('diff --git ')) {
        inHunk = false;
        const match = / b\/(.*)$/.exec(raw);
        lines.push({ kind: 'file', text: match?.[1] ?? raw.slice(11) });
      } else if (raw.startsWith('@@')) {
        inHunk = true;
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
        oldNo = Number(match?.[1] ?? 0);
        newNo = Number(match?.[2] ?? 0);
        lines.push({ kind: 'hunk', text: raw });
      } else if (!inHunk) {
        if (raw && !raw.startsWith('index ') && !raw.startsWith('--- ') && !raw.startsWith('+++ '))
          lines.push({ kind: 'meta', text: raw });
      } else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), new: newNo++ });
      else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), old: oldNo++ });
      else if (raw.startsWith('\\')) lines.push({ kind: 'meta', text: raw });
      else lines.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
    }
    // Trailing empty context line from the final newline.
    const last = () => lines[lines.length - 1];
    while (last()?.kind === 'ctx' && last()?.text === '') lines.pop();
    return lines;
  }

  $: lines = parse(diff);
</script>

{#if !diff.trim()}
  <p class="panel-empty">No changes.</p>
{:else}
  <div class="diff" role="table" aria-label="Diff">
    {#each lines as line}
      {#if line.kind === 'file'}
        <div class="diff-file">{line.text}</div>
      {:else if line.kind === 'meta'}
        <div class="diff-meta">{line.text}</div>
      {:else if line.kind === 'hunk'}
        <div class="diff-hunk">{line.text}</div>
      {:else}
        <div class="diff-line {line.kind}" role="row">
          <span class="gutter">{line.old ?? ''}</span><span class="gutter">{line.new ?? ''}</span
          ><span class="sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span
          ><code>{line.text}</code>
        </div>
      {/if}
    {/each}
    {#if truncated}<div class="diff-meta">Diff truncated at 1 MB.</div>{/if}
  </div>
{/if}

<style>
  .diff {
    overflow: auto;
    border-radius: var(--radius-md);
    background: var(--code-bg);
    box-shadow: 0 0 0 1px var(--line);
    font: 12px/1.55 var(--font-mono);
  }
  .diff-file {
    position: sticky;
    left: 0;
    padding: 6px 10px;
    border-top: 1px solid var(--line);
    color: var(--ink);
    background: var(--bg-subtle);
    font-weight: 600;
  }
  .diff-file:first-child {
    border-top: 0;
  }
  .diff-meta {
    padding: 2px 10px;
    color: var(--muted);
  }
  .diff-hunk {
    padding: 2px 10px;
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
  .diff-line {
    display: grid;
    grid-template-columns: 3.2em 3.2em 1.2em max-content;
    min-width: 100%;
    width: max-content;
  }
  .gutter {
    padding-right: 6px;
    color: var(--faint);
    text-align: right;
    user-select: none;
  }
  .sign {
    color: var(--muted);
    user-select: none;
  }
  code {
    padding-right: 12px;
    color: var(--code-ink);
    font: inherit;
    white-space: pre;
  }
  .add {
    background: color-mix(in srgb, var(--success) 13%, transparent);
  }
  .add .sign {
    color: var(--success);
  }
  .del {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .del .sign {
    color: var(--danger);
  }
</style>
