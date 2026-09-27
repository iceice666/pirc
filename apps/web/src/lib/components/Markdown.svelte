<script lang="ts">
  import { onDestroy } from 'svelte';
  import { enhanceMarkdown, renderMarkdown, rendererTick } from '../markdown';

  export let source: string;
  export let streaming = false;
  export let compact = false;

  /**
   * While streaming, every delta would otherwise re-parse the whole message and
   * swap its innerHTML; on a long reply that is quadratic and visibly janky.
   * Coalesce deltas into at most one render per interval. A finished message
   * (or a non-streaming one) renders synchronously so the final HTML is exact.
   */
  const STREAM_INTERVAL = 80;

  let html = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRender = 0;

  function render() {
    timer = undefined;
    lastRender = Date.now();
    html = renderMarkdown(source, { streaming });
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

  // `$rendererTick` re-runs this once a lazily loaded KaTeX / highlight.js lands.
  $: (source, streaming, $rendererTick, schedule());

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
</script>

<!-- renderMarkdown sanitizes its output with DOMPurify. -->
<div
  class="markdown"
  class:compact
  class:streaming
  use:enhanceMarkdown={{ html, ready: !streaming }}
>
  {@html html}
</div>
