<script lang="ts">
  /**
   * The top level (plans/rewrite/01-rooms.md): the rooms at `/`, and the
   * engine (workspaces, sessions, the work behind the rooms) at `/engine`.
   */
  import Engine from './Engine.svelte';
  import Rooms from './lib/components/rooms/Rooms.svelte';
  import { isEnginePath } from './lib/routes';

  const engine = isEnginePath(location.pathname);
</script>

{#if engine}
  <Engine />
{:else}
  <Rooms />
{/if}
