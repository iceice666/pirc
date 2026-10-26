<script lang="ts">
  import { app } from '../app.svelte';
  import { tr } from '../i18n.svelte';
  import { modeOf } from '../modes';
  import DeleteChatDialog from './dialogs/DeleteChatDialog.svelte';
  import type { SessionSummary } from '../types';
  let deleting = $state<SessionSummary>();
  const record = $derived(app.firstDraft);
  const phase = $derived(record?.preparation?.state);
  const title = $derived(
    phase === 'cancelled' && !record?.preparation?.cleanupPending
      ? tr('Deleted')
      : record?.cancelRequested && phase !== 'cancelled'
        ? tr('Deletion not yet confirmed')
        : phase === 'cancelled'
          ? tr('Deletion pending')
          : phase === 'admitted'
            ? tr('First message admitted')
            : record?.uncertain || phase === 'outcome_unknown'
              ? tr('First message outcome is unknown')
              : phase === 'admission_failed'
                ? tr('First message was not admitted')
                : phase === 'stopped' || phase === 'stopping'
                  ? tr('First message stopped or stopping')
                  : record?.preparation?.accepted
                    ? tr('First message accepted — delivery pending')
                    : tr('First message saved on this device'),
  );
</script>

{#if app.firstRecoveries.length}
  <aside class="first-recovery" aria-label={tr('Saved drafts and pending sends')}>
    {#if record?.frozen}
      <p role="status"><strong>{title}</strong></p>
      {#if record.message}<details>
          <summary>{record.message.slice(0, 120)}</summary>
          <p class="original">{record.message}</p>
        </details>{/if}
      <p>{tr('Check result never resends the message or takes control.')}</p>
      {#if record.error || record.preparation?.cleanupError}<p role="alert">
          {tr(record.error ?? record.preparation!.cleanupError!)}
        </p>{/if}
      <div class="actions">
        <button
          class="button ghost"
          type="button"
          disabled={app.firstControlBusy}
          onclick={() => app.checkFirst()}>{tr('Check result')}</button
        >
        {#if !['admitted', 'sending', 'outcome_unknown', 'stopping', 'stopped', 'cancelled', 'admission_failed'].includes(phase ?? '') && !record.cancelRequested && !record.uncertain}
          <button
            class="button ghost"
            type="button"
            disabled={!app.firstEnabled || app.commandBusy}
            onclick={() => app.continueFirst()}>{tr('Continue sending')}</button
          >
        {/if}
        {#if record.preparation?.accepted && !['accepted', 'cancelled'].includes(phase ?? '')}
          <button
            class="button ghost"
            type="button"
            disabled={app.firstControlBusy}
            onclick={() => app.takeFirstControl()}>{tr('Take control')}</button
          >
        {/if}
        {#if phase === 'admitted' || record.preparation?.messageAdmission?.stopConfirmed}
          <button class="button ghost" type="button" onclick={() => app.openStoppedFirst()}
            >{tr('Open conversation')}</button
          >
        {:else if record.preparation?.accepted && phase !== 'accepted' && phase !== 'cancelled'}
          <button
            class="button ghost"
            type="button"
            disabled={app.firstControlBusy}
            onclick={() => app.stopFirst()}>{tr('Stop pending message')}</button
          >
        {/if}
        {#if record.preparation?.accepted && app.activeWorkspace && modeOf(app.activeWorkspace, app.modeCatalog)?.delete_sessions}
          <button
            class="button ghost"
            type="button"
            onclick={() => (deleting = app.sessionState?.session)}
            >{tr('Delete chat and memories')}</button
          >
        {:else if !record.preparation?.accepted}
          <button
            class="button ghost"
            type="button"
            onclick={() => app.discardFirst().catch((error) => (app.pageError = String(error)))}
            >{tr('Discard draft')}</button
          >
        {/if}
      </div>
    {/if}
    <details>
      <summary>{tr('Saved drafts and pending sends')} ({app.firstRecoveries.length})</summary>
      {#each app.firstRecoveries as draft (draft.operationId)}
        <div class="saved-row">
          <button type="button" class="button ghost" onclick={() => app.resumeFirst(draft)}
            >{draft.message.slice(0, 65) || tr('Pending cleanup')} · {tr(
              draft.preparation?.state ?? 'Local draft',
            )}</button
          >
          {#if !draft.frozen}
            <button
              type="button"
              class="button ghost"
              onclick={() =>
                app.discardFirst(draft).catch((error) => (app.pageError = String(error)))}
              >{tr('Discard draft')}</button
            >
          {/if}
          {#if draft.preparation?.state === 'cancelled' && !draft.preparation.cleanupPending}
            <button type="button" class="button ghost" onclick={() => app.dismissFirst(draft)}
              >{tr('Dismiss')}</button
            >
          {/if}
        </div>
      {/each}
    </details>
  </aside>
{/if}
<DeleteChatDialog bind:session={deleting} />

<style>
  .first-recovery {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text-2);
    font-size: 13px;
    background: var(--surface);
  }
  p {
    margin: 5px 0;
  }
  .actions,
  .saved-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  details {
    margin: 6px 0;
  }
  summary {
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .original {
    white-space: pre-wrap;
    max-height: 200px;
    overflow: auto;
    overflow-wrap: anywhere;
  }
</style>
