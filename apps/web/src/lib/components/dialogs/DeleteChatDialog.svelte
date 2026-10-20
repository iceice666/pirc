<script lang="ts">
  import { tr } from '../../i18n.svelte';

  import { app } from '../../app.svelte';
  import { errorMessage } from '../../errors';
  import type { SessionSummary } from '../../types';
  import Modal from './Modal.svelte';

  let { session = $bindable() }: { session?: SessionSummary } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  $effect(() => {
    if (session) {
      open = true;
      error = '';
    }
  });
  $effect(() => {
    if (!open && !busy) session = undefined;
  });

  async function remove() {
    if (!session || busy) return;
    busy = true;
    error = '';
    try {
      await app.deleteSession(session.id);
      open = false;
      session = undefined;
    } catch (cause) {
      error = errorMessage(
        cause,
        tr('Could not delete this chat. Reconnect the chat node and retry.'),
      );
      open = true;
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="delete-chat-title">
  <header><h2 id="delete-chat-title">{tr('Delete chat?')}</h2></header>
  <p>
    {tr('“{0}” will be permanently deleted, including its messages and chat files.', [
      session?.name,
    ])}
  </p>
  <p>
    <strong
      >{tr(
        'This also deletes USER memories and MEMORY notes created by this chat, and its pending memory proposals.',
      )}</strong
    >
    {tr('Memories created by other chats are kept.')}
  </p>
  <p>
    {tr(
      'Copies already present in other chats are not erased. Any running reply will stop. This cannot be undone.',
    )}
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="button ghost" type="button" disabled={busy} onclick={() => (open = false)}
      >{tr('Cancel')}</button
    >
    <button class="button dark" type="button" disabled={busy} onclick={remove}
      >{busy ? tr('Deleting…') : tr('Delete chat and memories')}</button
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
