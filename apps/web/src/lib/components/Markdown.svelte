<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import {
    enhanceMarkdown,
    renderMarkdownChecked,
    rendererTick,
    stableBlockEnd,
  } from '../markdown';
  import { watch } from '../watch.svelte';

  interface Props {
    source: string;
    streaming?: boolean;
    compact?: boolean;
    /** Directory relative file links resolve against (workspace root by default). */
    linkBase?: string;
  }

  let { source, streaming = false, compact = false, linkBase = '' }: Props = $props();

  /**
   * While streaming, every delta would otherwise re-parse the whole message and
   * swap its innerHTML; on a long reply that is quadratic and visibly janky.
   * Coalesce deltas into at most one render per interval, and render each
   * completed top-level block once: only the last block, the one still being
   * written, is re-parsed and replaced. A finished message (or a non-streaming
   * one) renders whole and synchronously so the final HTML is exact.
   */
  const STREAM_INTERVAL = 80;

  /** Streaming: HTML of the completed blocks, one entry per render that added some. */
  let stableChunks: string[] = $state([]);
  /** Source length covered by `stableChunks`. */
  let stableEnd = 0;
  let stableSource = '';
  let stablePending = false;
  /** The last (or, when not streaming, the only) part. */
  let html = $state('');
  /** The last render showed math or code as plain text while its renderer loads. */
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let lastRender = 0;

  function resetStable() {
    if (stableChunks.length) stableChunks = [];
    stableEnd = 0;
    stableSource = '';
    stablePending = false;
  }

  function render() {
    timer = undefined;
    lastRender = Date.now();
    if (!streaming) {
      resetStable();
      ({ html, pending } = renderMarkdownChecked(source));
      return;
    }
    // The text was replaced rather than extended: start over.
    if (!source.startsWith(stableSource)) resetStable();
    const end = stableBlockEnd(source, stableEnd);
    if (end > stableEnd) {
      const blocks = renderMarkdownChecked(source.slice(stableEnd, end));
      stableChunks.push(blocks.html);
      stablePending ||= blocks.pending;
      stableEnd = end;
      stableSource = source.slice(0, end);
    }
    const tail = renderMarkdownChecked(source.slice(stableEnd), { streaming: true });
    html = tail.html;
    pending = stablePending || tail.pending;
  }

  function schedule() {
    if (!streaming) {
      if (timer) clearTimeout(timer);
      render();
      return;
    }
    if (timer) return;
    const wait = Math.max(0, STREAM_INTERVAL - (Date.now() - lastRender));
    if (wait === 0) render();
    else timer = setTimeout(render, wait);
  }

  $effect.pre(() => {
    void source;
    void streaming;
    untrack(schedule);
  });

  /**
   * A lazily loaded KaTeX / highlight.js landed (`$rendererTick`). Only output
   * that fell back to plain text re-renders, in idle time, so dozens of mounted
   * messages don't all re-parse in the same frame.
   */
  watch(
    () => $rendererTick,
    () => {
      if (!pending || idle !== undefined) return;
      const run = () => {
        idle = undefined;
        if (!pending) return;
        // Completed blocks that fell back render again too.
        if (stablePending) resetStable();
        schedule();
      };
      idle =
        typeof requestIdleCallback === 'function'
          ? requestIdleCallback(run, { timeout: 500 })
          : window.setTimeout(run, 0);
    },
  );

  onDestroy(() => {
    if (timer) clearTimeout(timer);
    if (idle !== undefined)
      typeof cancelIdleCallback === 'function' ? cancelIdleCallback(idle) : clearTimeout(idle);
  });
</script>

<!-- renderMarkdown sanitizes its output with DOMPurify. -->
<div
  class="markdown"
  class:compact
  class:streaming
  use:enhanceMarkdown={{ html, ready: !streaming, linkBase }}
>
  {#each stableChunks as chunk, index (index)}{@html chunk}{/each}{@html html}
</div>
