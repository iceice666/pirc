<script lang="ts">
  import { X } from '@lucide/svelte';
  import { app } from '../../app.svelte';
  import Modal from './Modal.svelte';
  import { watch } from '../../watch.svelte';

  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  let workspaceId = $state('');
  let creating = $state(false);

  // Preselect the first workspace whose device is online.
  watch(
    () => open,
    (isOpen) => {
      if (isOpen)
        workspaceId = app.workspaces.find((workspace) => app.workspaceOnline(workspace))?.id ?? '';
    },
    { immediate: true },
  );

  const chosenOnline = $derived(
    app.workspaceOnline(app.workspaces.find((workspace) => workspace.id === workspaceId)),
  );

  async function create() {
    if (!workspaceId || creating) return;
    creating = true;
    try {
      if (await app.createSession(workspaceId)) open = false;
    } finally {
      creating = false;
    }
  }
</script>

<Modal bind:open labelledby="new-session-title">
  <header>
    <div>
      <span class="eyebrow">New work</span>
      <h2 id="new-session-title">Create a session</h2>
    </div>
    <button class="icon-button" type="button" aria-label="Close" onclick={() => (open = false)}
      ><X size={19} /></button
    >
  </header>
  <label
    ><span>Workspace</span><select bind:value={workspaceId}
      >{#each app.workspaces as workspace (workspace.id)}<option
          value={workspace.id}
          disabled={!app.workspaceOnline(workspace)}
          >{workspace.displayName} · {workspace.hostId}{app.workspaceOnline(workspace)
            ? ''
            : ' (offline)'}</option
        >{/each}</select
    ></label
  >
  <p>
    The session is named from your first message and stays active on the host when this browser
    disconnects.
  </p>
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}>Cancel</button><button
      class="button dark"
      type="button"
      onclick={create}
      disabled={creating || !workspaceId || !chosenOnline}>Create session</button
    >
  </footer>
</Modal>
