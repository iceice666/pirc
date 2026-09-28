<script lang="ts">
  import { X } from '@lucide/svelte';
  import { app } from '../../app.svelte';
  import { errorMessage } from '../../errors';
  import Modal from './Modal.svelte';
  import { watch } from '../../watch.svelte';

  interface Props {
    open: boolean;
    /** The chat node that hosts the project. */
    nodeId: string;
    /** Called with the new project's id once it exists. */
    oncreated: (workspaceId: string) => void;
  }

  let { open = $bindable(), nodeId, oncreated }: Props = $props();

  let name = $state('');
  let busy = $state(false);
  let error = $state('');

  watch(
    () => open,
    (isOpen) => {
      if (!isOpen) return;
      name = '';
      error = '';
    },
    { immediate: true },
  );

  async function create() {
    if (!nodeId || !name.trim() || busy) return;
    busy = true;
    error = '';
    try {
      const workspace = await app.createWorkspace({
        nodeId,
        kind: 'chat',
        displayName: name.trim(),
      });
      open = false;
      oncreated(workspace.id);
    } catch (cause) {
      error = errorMessage(cause, 'Could not create the project.');
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="new-project-title">
  <header>
    <div>
      <span class="eyebrow">Chats</span>
      <h2 id="new-project-title">New project</h2>
    </div>
    <button class="icon-button" type="button" aria-label="Close" onclick={() => (open = false)}
      ><X size={19} /></button
    >
  </header>
  <label
    ><span>Project name</span><input
      bind:value={name}
      placeholder="Trip to Japan"
      onkeydown={(event) => event.key === 'Enter' && create()}
    /></label
  >
  <p>A project groups related chats. The assistant keeps its files for you; no folder to pick.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}>Cancel</button>
    <button class="button dark" type="button" disabled={busy || !name.trim()} onclick={create}
      >{busy ? 'Creating…' : 'Create project'}</button
    >
  </footer>
</Modal>
