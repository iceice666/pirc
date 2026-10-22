<script lang="ts">
  /**
   * The top level (plans/rewrite/01-rooms.md): the rooms at `/`, and the
   * engine (workspaces, sessions, the work behind the rooms) at `/engine`.
   * Moving between them loads a new page, so each is its own chunk: the
   * rooms do not download the engine's panels, terminal and markdown.
   */
  import { isEnginePath } from './lib/routes';

  const page = isEnginePath(location.pathname)
    ? import('./Engine.svelte')
    : import('./lib/components/rooms/Rooms.svelte');
</script>

{#await page then { default: Page }}
  <Page />
{:catch}
  <!-- A chunk of an older build was removed by a deploy since this page loaded. -->
  <p class="load-failed" role="alert">
    pirc could not load. <button type="button" onclick={() => location.reload()}>Reload</button>
  </p>
{/await}

<style>
  .load-failed {
    margin: 2rem auto;
    max-width: 30rem;
    padding: 0 1rem;
    text-align: center;
  }
</style>
