<script lang="ts">
  import { enhanceMarkdown, renderMarkdown } from '../markdown';

  export let source: string;
  export let streaming = false;
  export let compact = false;

  $: html = renderMarkdown(source, { streaming });
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
