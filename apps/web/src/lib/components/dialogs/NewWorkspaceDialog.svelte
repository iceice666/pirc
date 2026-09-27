<script lang="ts">
  import { X } from '@lucide/svelte';
  import { app } from '../../app.svelte';
  import Modal from './Modal.svelte';
  import { watch } from '../../watch.svelte';

  interface Props {
    open: boolean;
    /** Device preselected when the dialog opens. */
    nodeId: string;
    /** Called with the new workspace's id once it is added. */
    oncreated: (workspaceId: string) => void;
  }

  let { open = $bindable(), nodeId, oncreated }: Props = $props();

  let chosenNode = $state('');
  let path = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state('');

  // Every opening starts from a blank form on the requested device.
  watch(
    () => open,
    (isOpen) => {
      if (!isOpen) return;
      chosenNode = nodeId;
      path = '';
      name = '';
      error = '';
    },
    { immediate: true },
  );

  async function create() {
    if (!chosenNode || !path.trim() || !name.trim() || busy) return;
    busy = true;
    error = '';
    try {
      const workspace = await app.createWorkspace({
        nodeId: chosenNode,
        path: path.trim(),
        displayName: name.trim(),
      });
      open = false;
      oncreated(workspace.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add workspace.';
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="new-workspace-title">
  <header>
    <div>
      <span class="eyebrow">On a device</span>
      <h2 id="new-workspace-title">Add workspace</h2>
    </div>
    <button class="icon-button" type="button" aria-label="Close" onclick={() => (open = false)}
      ><X size={19} /></button
    >
  </header>
  <label
    ><span>Device</span><select bind:value={chosenNode}
      >{#each app.nodes as node (node.id)}<option value={node.id}>{node.id}</option>{/each}</select
    ></label
  >
  <label><span>Workspace name</span><input bind:value={name} placeholder="My project" /></label>
  <label
    ><span>Existing directory on that device</span><input
      bind:value={path}
      placeholder="~/projects/my-project"
      onkeydown={(event) => event.key === 'Enter' && create()}
    /></label
  >
  <p>
    Choose an existing folder inside that device's home directory. No files or folders will be
    created.
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}>Cancel</button>
    <button
      class="button dark"
      type="button"
      disabled={busy || !chosenNode || !name.trim() || !path.trim()}
      onclick={create}>{busy ? 'Adding…' : 'Add workspace'}</button
    >
  </footer>
</Modal>
