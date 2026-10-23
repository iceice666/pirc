<script lang="ts">
  import { X } from '@lucide/svelte';
  import { engine } from '../../engine.svelte';
  import { creatableModes, workNodes } from '../../modes';
  import { errorMessage } from '../../errors';
  import { t } from '../../i18n';
  import type { NewWorkspace } from '../../types';
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

  const catalog = $derived(engine.modeCatalog);
  // Only nodes accepting a mode the catalog knows.
  const deviceNodes = $derived(workNodes(engine.nodes, catalog));

  let chosenNode = $state('');
  let chosenMode = $state('');
  /** The node's modes; none from an older gateway (then a path makes a directory). */
  const modes = $derived(
    creatableModes(
      deviceNodes.find((node) => node.id === chosenNode),
      catalog,
    ),
  );
  /** The picked mode, else a repository mode, else the first. */
  const mode = $derived(
    modes.find((item) => item.id === chosenMode) ??
      modes.find((item) => item.repository) ??
      modes[0],
  );
  /** A `workspace` workdir is an existing directory; `per-session` ones the node makes. */
  const needsPath = $derived(!mode || mode.workdir === 'workspace');
  let path = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state('');

  // Every opening starts from a blank form on the requested device.
  watch(
    () => open,
    (isOpen) => {
      if (!isOpen) return;
      chosenNode = deviceNodes.some((node) => node.id === nodeId)
        ? nodeId
        : (deviceNodes[0]?.id ?? '');
      chosenMode = '';
      path = '';
      name = '';
      error = '';
    },
    { immediate: true },
  );

  async function create() {
    if (!chosenNode || (needsPath && !path.trim()) || !name.trim() || busy) return;
    busy = true;
    error = '';
    const displayName = name.trim();
    const input: NewWorkspace = mode
      ? {
          nodeId: chosenNode,
          mode: mode.id,
          displayName,
          ...(needsPath ? { path: path.trim() } : {}),
        }
      : { nodeId: chosenNode, path: path.trim(), displayName };
    try {
      const workspace = await engine.createWorkspace(input);
      open = false;
      oncreated(workspace.id);
    } catch (cause) {
      error = errorMessage(cause, t('settings.newWorkspace.addFailed'));
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="new-workspace-title">
  <header>
    <div>
      <span class="eyebrow">{t('settings.newWorkspace.eyebrow')}</span>
      <h2 id="new-workspace-title">{t('settings.newWorkspace.title')}</h2>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label={t('common.close')}
      onclick={() => (open = false)}><X size={19} /></button
    >
  </header>
  <label
    ><span>{t('settings.newWorkspace.device')}</span><select bind:value={chosenNode}
      >{#each deviceNodes as node (node.id)}<option value={node.id}>{node.id}</option
        >{/each}</select
    ></label
  >
  {#if modes.length > 1}
    <label
      ><span>{t('settings.newWorkspace.mode')}</span><select
        value={mode?.id}
        onchange={(event) => (chosenMode = event.currentTarget.value)}
        >{#each modes as item (item.id)}<option value={item.id}>{item.label}</option>{/each}</select
      ></label
    >
    {#if mode?.description}<p>{mode.description}</p>{/if}
  {/if}
  <label
    ><span>{t('settings.newWorkspace.name')}</span><input
      bind:value={name}
      placeholder={t('settings.newWorkspace.namePlaceholder')}
      onkeydown={(event) => event.key === 'Enter' && !needsPath && create()}
    /></label
  >
  {#if needsPath}
    <label
      ><span>{t('settings.newWorkspace.path')}</span><input
        bind:value={path}
        placeholder={t('settings.newWorkspace.pathPlaceholder')}
        onkeydown={(event) => event.key === 'Enter' && create()}
      /></label
    >
    <p>{t('settings.newWorkspace.pathHint')}</p>
  {:else}
    <p>{t('settings.newWorkspace.newDir', { noun: mode?.ui.noun ?? 'session' })}</p>
  {/if}
  {#if !deviceNodes.length}<p role="alert">{t('settings.newWorkspace.noDevice')}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" onclick={() => (open = false)}
      >{t('common.cancel')}</button
    >
    <button
      class="button dark"
      type="button"
      disabled={busy || !chosenNode || !name.trim() || (needsPath && !path.trim())}
      onclick={create}
      >{busy ? t('settings.newWorkspace.adding') : t('settings.newWorkspace.add')}</button
    >
  </footer>
</Modal>
