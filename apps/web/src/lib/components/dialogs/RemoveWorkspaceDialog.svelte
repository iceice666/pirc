<script lang="ts">
  import { tr } from '../../i18n.svelte';

  import { app } from '../../app.svelte';
  import { errorMessage } from '../../errors';
  import type { Workspace } from '../../types';
  import Modal from './Modal.svelte';

  let { workspace = $bindable() }: { workspace?: Workspace } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  $effect(() => {
    if (workspace) {
      open = true;
      error = '';
    }
  });
  $effect(() => {
    if (!open && !busy) workspace = undefined;
  });

  async function remove() {
    if (!workspace || busy) return;
    busy = true;
    error = '';
    try {
      await app.removeWorkspace(workspace.id);
      open = false;
      workspace = undefined;
    } catch (cause) {
      error = errorMessage(cause, tr('Could not remove this workspace. Try again.'));
      open = true;
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="remove-workspace-title">
  <header><h2 id="remove-workspace-title">{tr('Remove workspace?')}</h2></header>
  <p>{tr('Remove “{0}” from pirc?', [workspace?.displayName])}</p>
  <p>
    {tr(
      'Hides this workspace and its sessions from pirc and pauses its schedules. Your files and history are kept.',
    )}
  </p>
  <p>
    {tr(
      'Repository files, session transcripts, uploads and memories are not deleted. Project links remain, marked as removed.',
    )}
  </p>
  <p>
    {tr(
      'Stop running sessions before removing it. Workspaces with another user’s sessions or schedules cannot be removed.',
    )}
  </p>
  <p>
    {tr(
      'To restore a directory workspace and its history, add the same directory on the same device again. Paused schedules stay paused.',
    )}
  </p>
  <p>
    {tr(
      'Only directories eligible for Add workspace can be restored there. Configured paths outside the device’s home directory have no UI restore.',
    )}
  </p>
  <p>
    {tr('Removal does not stop existing background jobs or terminals. Stop them first if needed.')}
  </p>
  {#if workspace && app.modeOf(workspace).workdir === 'per-session'}
    <p>
      {tr(
        'This workspace uses a separate directory per session. Adding another creates a new workspace; it does not restore this one.',
      )}
    </p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" disabled={busy} onclick={() => (open = false)}
      >{tr('Cancel')}</button
    >
    <button class="button dark" type="button" disabled={busy} onclick={remove}
      >{busy ? tr('Removing…') : tr('Remove workspace')}</button
    >
  </footer>
</Modal>

<style>
  h2 {
    margin: 0;
    font-size: 20px;
  }
  p {
    color: var(--text-2);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  p[role='alert'] {
    color: var(--danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 24px;
  }
</style>
