<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { enhanceMarkdown, renderMarkdownChecked, rendererTick } from '../markdown';
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
   * Coalesce deltas into at most one render per interval. A finished message
   * (or a non-streaming one) renders synchronously so the final HTML is exact.
   */
  const STREAM_INTERVAL = 80;

  let html = $state('');
  /** The last render showed math or code as plain text while its renderer loads. */
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let lastRender = 0;

  function render() {
    timer = undefined;
    lastRender = Date.now();
    ({ html, pending } = renderMarkdownChecked(source, { streaming }));
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
        if (pending) schedule();
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
  {@html html}
</div>
