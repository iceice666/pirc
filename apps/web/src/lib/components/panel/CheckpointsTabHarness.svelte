<script lang="ts">
  import { onMount } from 'svelte';
  import CheckpointsTab from './CheckpointsTab.svelte';

  let sessionId = $state('source');
  let scope = $state('source:workspace:node');
  let online = $state(true);
  let hasControl = $state(true);
  let generation = $state<number | undefined>(7);

  onMount(() => {
    const update = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId?: string;
          scope?: string;
          online?: boolean;
          hasControl?: boolean;
          generation?: number;
        }>
      ).detail;
      if (detail.sessionId !== undefined) sessionId = detail.sessionId;
      if (detail.scope !== undefined) scope = detail.scope;
      if (detail.online !== undefined) online = detail.online;
      if (detail.hasControl !== undefined) hasControl = detail.hasControl;
      if (detail.generation !== undefined) generation = detail.generation;
    };
    window.addEventListener('checkpoints-harness-update', update);
    return () => window.removeEventListener('checkpoints-harness-update', update);
  });
</script>

<CheckpointsTab {sessionId} {scope} {online} {hasControl} {generation} />
