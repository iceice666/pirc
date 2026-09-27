<script lang="ts">
  /**
   * A modal on the native `<dialog>`: `showModal()` traps focus, makes the page
   * behind it inert and closes on Escape. Focus returns to whatever opened it.
   * Content mounts only while open (e.g. closing settings cancels a login).
   */
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    /** Id of the heading that names the dialog. */
    labelledby: string;
    /** Extra classes for the panel (e.g. `settings`). */
    class?: string;
    children: Snippet;
  }

  let { open = $bindable(), labelledby, class: className = '', children }: Props = $props();

  let dialog: HTMLDialogElement;
  let returnFocus: HTMLElement | null = null;

  $effect(() => {
    if (open && !dialog.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  });

  function onclose() {
    open = false;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
</script>

<!-- The dialog element itself is only hit outside the panel: that click is on the backdrop. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="modal-dialog {className}"
  aria-labelledby={labelledby}
  {onclose}
  onclick={(event) => event.target === dialog && dialog.close()}
>
  {#if open}
    <div class="modal {className}">
      {@render children()}
    </div>
  {/if}
</dialog>

<style>
  /* ───────────── Modal & toast ───────────── */
  /* <dialog> is a transparent frame; clicks on it (not the panel) are backdrop clicks. */
  .modal-dialog {
    width: min(440px, calc(100% - 40px));
    max-width: none;
    max-height: calc(100dvh - 40px);
    padding: 0;
    overflow: visible;
    border: 0;
    background: transparent;
    color: inherit;
  }
  .modal-dialog.settings {
    width: min(760px, calc(100% - 40px));
  }
  .modal-dialog::backdrop {
    background: rgb(0 0 0 / 40%);
  }
  .modal {
    width: 100%;
    padding: 24px;
    border-radius: var(--radius-xl);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
  }
  .modal.settings {
    display: flex;
    flex-direction: column;
    height: min(640px, calc(100dvh - 40px));
  }
  .modal :global(header) {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .modal :global(h2) {
    margin: 2px 0 0;
    font-size: 18px;
    font-weight: 600;
  }
  .modal :global(label) {
    display: grid;
    gap: 6px;
    margin: 12px 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
  }
  .modal :global(input),
  .modal :global(select) {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
  }
  .modal :global(input:focus),
  .modal :global(select:focus) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .modal :global(p) {
    margin: 12px 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }
  .modal :global(footer) {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
