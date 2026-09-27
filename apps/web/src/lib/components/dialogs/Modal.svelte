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
