<script lang="ts">
  import { tr } from '../../i18n.svelte';

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
      // A project takes the mode of the node's top-level chats when the
      // catalog knows it; older gateways get the legacy `kind`.
      const chats = app.workspaces.find((item) => item.id === `${nodeId}:chats`);
      const mode = chats?.mode
        ? app.modeCatalog.find((item) => item.id === chats.mode)?.id
        : undefined;
      const workspace = await app.createWorkspace(
        mode
          ? { nodeId, mode, displayName: name.trim() }
          : { nodeId, kind: 'chat', displayName: name.trim() },
      );
      open = false;
      oncreated(workspace.id);
    } catch (cause) {
      error = errorMessage(cause, tr('Could not create the project.'));
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="new-project-title">
  <header>
    <div>
      <span class="eyebrow">{tr('Chats')}</span>
      <h2 id="new-project-title">{tr('New project')}</h2>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label={tr('Close')}
      onclick={() => (open = false)}><X size={19} /></button
    >
  </header>
  <label
    ><span>{tr('Project name')}</span><input
      bind:value={name}
      placeholder={tr('Trip to Japan')}
      onkeydown={(event) => event.key === 'Enter' && create()}
    /></label
  >
  <p>
    {tr(
      'A project groups related chats. The assistant keeps its files for you; no folder to pick.',
    )}
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}>{tr('Cancel')}</button
    >
    <button class="button dark" type="button" disabled={busy || !name.trim()} onclick={create}
      >{busy ? tr('Creating…') : tr('Create project')}</button
    >
  </footer>
</Modal>
