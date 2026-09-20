<script lang="ts">
  import { ArrowRight, CircleHelp, Clock3, X } from '@lucide/svelte';
  import type { InteractionAnswer, PendingInteraction } from '../types';

  export let interaction: PendingInteraction;
  export let disabled = false;
  export let onanswer: (answer: InteractionAnswer) => void;

  let value =
    interaction.kind === 'input' || interaction.kind === 'editor'
      ? (interaction.initialValue ?? '')
      : '';
  let selected: string[] = [];

  function toggle(option: string) {
    if (interaction.kind !== 'select') return;
    if (!interaction.multiple) selected = [option];
    else
      selected = selected.includes(option)
        ? selected.filter((item) => item !== option)
        : [...selected, option];
  }

  function submit() {
    if (interaction.kind === 'confirm') onanswer({ action: 'answer', value: true });
    else if (interaction.kind === 'select')
      onanswer({ action: 'answer', value: interaction.multiple ? selected : (selected[0] ?? '') });
    else onanswer({ action: 'answer', value });
  }
</script>

<section class="interaction-card" aria-labelledby="interaction-{interaction.id}">
  <header>
    <span class="interaction-icon"><CircleHelp size={18} /></span>
    <div>
      <span class="eyebrow">Your input is needed</span>
      <h3 id="interaction-{interaction.id}">{interaction.title}</h3>
      {#if interaction.description}<p>{interaction.description}</p>{/if}
    </div>
  </header>

  {#if interaction.kind === 'select'}
    <div class="option-list" role={interaction.multiple ? 'group' : 'radiogroup'}>
      {#each interaction.options as option}
        <button
          type="button"
          class:selected={selected.includes(option.value)}
          class="option"
          on:click={() => toggle(option.value)}
          {disabled}
          role={interaction.multiple ? 'checkbox' : 'radio'}
          aria-checked={selected.includes(option.value)}
        >
          <span class="option-mark"></span>
          <span
            ><strong>{option.label}</strong>{#if option.description}<small
                >{option.description}</small
              >{/if}</span
          >
        </button>
      {/each}
    </div>
  {:else if interaction.kind === 'input'}
    <label>
      <span class="sr-only">Your answer</span>
      <input bind:value placeholder={interaction.placeholder ?? 'Type your answer…'} {disabled} />
    </label>
  {:else if interaction.kind === 'editor'}
    <label>
      <span class="field-label"
        >Response {interaction.language ? `· ${interaction.language}` : ''}</span
      >
      <textarea class="editor" bind:value rows="8" spellcheck="false" {disabled}></textarea>
    </label>
  {:else}
    <p class="confirm-copy">Choose whether the agent should continue with this action.</p>
  {/if}

  <footer>
    {#if interaction.expiresAt}
      <span class="expires"
        ><Clock3 size={14} /> Expires {new Date(interaction.expiresAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}</span
      >
    {:else}<span></span>{/if}
    <div class="interaction-actions">
      <button
        class="button ghost small"
        type="button"
        on:click={() => onanswer({ action: 'cancel' })}
        {disabled}
      >
        <X size={15} />
        {interaction.kind === 'confirm' ? (interaction.cancelLabel ?? 'No') : 'Cancel'}
      </button>
      <button
        class="button dark small"
        type="button"
        on:click={submit}
        disabled={disabled || (interaction.kind === 'select' && selected.length === 0)}
      >
        {interaction.kind === 'confirm' ? (interaction.confirmLabel ?? 'Yes, continue') : 'Submit'}
        <ArrowRight size={15} />
      </button>
    </div>
  </footer>
</section>
