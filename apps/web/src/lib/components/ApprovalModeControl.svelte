<script lang="ts">
  import { tr } from '../i18n.svelte';

  /**
   * The session's approval mode (security audit L14): a picker beside the
   * model, which asks before switching to full access.
   */
  import { Hand, ShieldCheck, ShieldAlert } from '@lucide/svelte';
  import { app } from '../app.svelte';
  import type { ApprovalMode } from '../types';
  import ComposerSelect from './ComposerSelect.svelte';
  import Modal from './dialogs/Modal.svelte';

  const LABELS: Record<ApprovalMode, string> = $derived({
    'read-only': tr('Read-only'),
    auto: tr('Auto'),
    'full-access': tr('Full access'),
  });
  const DETAILS: Record<ApprovalMode, string> = $derived({
    'read-only': tr('asks before any change'),
    auto: tr('asks before risky commands'),
    'full-access': tr('never asks'),
  });
  const mode = $derived(app.approvalMode);
  const options = $derived(
    (Object.keys(LABELS) as ApprovalMode[]).map((value) => ({
      value,
      label: LABELS[value],
      icon: value === 'full-access' ? ShieldAlert : value === 'auto' ? ShieldCheck : Hand,
      warning: value === 'full-access',
      detail: `${DETAILS[value]}${value === app.defaultApprovalMode ? ' · ' + tr('Default') : ''}`,
    })),
  );

  let confirming = $state(false);

  function select(value: string) {
    const chosen = value as ApprovalMode;
    if (chosen === mode) return;
    if (chosen === 'full-access') {
      confirming = true;
      return;
    }
    void app.changeApprovalMode(chosen);
  }

  function allow() {
    confirming = false;
    void app.changeApprovalMode('full-access');
  }
</script>

{#if mode}
  <div class="approval-select" class:full={mode === 'full-access'}>
    <ComposerSelect
      label={tr('Approval mode')}
      value={mode}
      {options}
      disabled={!app.hasControl}
      onselect={select}
    />
  </div>
{/if}

<Modal bind:open={confirming} labelledby="full-access-title">
  <header><h2 id="full-access-title">{tr('Give this session full access?')}</h2></header>
  <p>
    {tr(
      'The agent will run every command, script and file change without asking you, including ones auto mode would stop as dangerous (deleting files, force-pushing, changing the system).',
    )}
  </p>
  <p>
    {tr(
      "Your deny-list still asks, writes still take the workspace's write lease, and the node's OS sandbox stays as it is. Teammates and subagents of this session follow it; delegated sessions do not.",
    )}
  </p>
  <footer>
    <button class="button ghost" type="button" onclick={() => (confirming = false)}
      >{tr('Cancel')}</button
    >
    <button class="button dark" type="button" onclick={allow}>{tr('Allow full access')}</button>
  </footer>
</Modal>

<style>
  .approval-select {
    flex: 0 1 auto;
    min-width: 0;
  }
  .approval-select.full :global(.selector-trigger) {
    color: var(--danger);
  }
</style>
