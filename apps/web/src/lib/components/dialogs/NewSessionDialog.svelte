<script lang="ts">
  import { tr } from '../../i18n.svelte';

  import { X } from '@lucide/svelte';
  import { app } from '../../app.svelte';
  import { isReadOnly } from '../../modes';
  import Modal from './Modal.svelte';
  import { watch } from '../../watch.svelte';

  interface Props {
    open: boolean;
    oncreated?: () => void;
  }

  let { open = $bindable(), oncreated }: Props = $props();

  let workspaceId = $state('');
  let creating = $state(false);

  // Preselect the first workspace that takes new sessions (online, mode available).
  watch(
    () => open,
    (isOpen) => {
      if (isOpen)
        workspaceId = app.workspaces.find((workspace) => app.acceptsSessions(workspace))?.id ?? '';
    },
    { immediate: true },
  );

  const chosenOnline = $derived(
    app.acceptsSessions(app.workspaces.find((workspace) => workspace.id === workspaceId)),
  );

  async function create() {
    if (!workspaceId || creating) return;
    creating = true;
    try {
      if (await app.createSession(workspaceId)) {
        open = false;
        oncreated?.();
      }
    } finally {
      creating = false;
    }
  }
</script>

<Modal bind:open labelledby="new-session-title">
  <header>
    <div>
      <span class="eyebrow">{tr('New work')}</span>
      <h2 id="new-session-title">{tr('Create a session')}</h2>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label={tr('Close')}
      onclick={() => (open = false)}><X size={19} /></button
    >
  </header>
  <label
    ><span>{tr('Workspace')}</span><select bind:value={workspaceId}
      >{#each app.workspaces as workspace (workspace.id)}<option
          value={workspace.id}
          disabled={!app.acceptsSessions(workspace)}
          >{workspace.displayName} · {workspace.hostId}{!app.workspaceOnline(workspace)
            ? tr(' (offline)')
            : isReadOnly(workspace)
              ? tr(' (read-only)')
              : ''}</option
        >{/each}</select
    ></label
  >
  <p>
    {tr(
      'The session is named from your first message and stays active on the host when this browser disconnects.',
    )}
  </p>
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}>{tr('Cancel')}</button
    ><button
      class="button dark"
      type="button"
      onclick={create}
      disabled={creating || !workspaceId || !chosenOnline}>{tr('Create session')}</button
    >
  </footer>
</Modal>
