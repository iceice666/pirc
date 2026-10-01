<script lang="ts">
  import { ArrowRight, CircleHelp, Clock3, X } from '@lucide/svelte';
  import { rovingFocus } from '../a11y';
  import { api } from '../api';
  import {
    modelKey,
    type InteractionAnswer,
    type ModelOption,
    type PendingInteraction,
    type ThinkingLevel,
  } from '../types';

  const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  interface Props {
    interaction: PendingInteraction;
    disabled?: boolean;
    onanswer: (answer: InteractionAnswer) => void;
  }

  let { interaction, disabled = false, onanswer }: Props = $props();

  const initialValue = () =>
    interaction.kind === 'input' || interaction.kind === 'editor'
      ? (interaction.initialValue ?? '')
      : '';
  let value = $state(initialValue());
  let selected: string[] = $state([]);

  /** A delegation's model and thinking level: `modelKey`s, '' for the default. */
  const modelChoice = $derived(
    interaction.kind === 'confirm' ? interaction.modelChoice : undefined,
  );
  let model = $state('');
  let thinking: ThinkingLevel | '' = $state('');
  let models: ModelOption[] = $state([]);
  $effect(() => {
    const choice = modelChoice;
    if (!choice) return;
    model = choice.model ? modelKey(choice.model) : '';
    thinking = choice.thinking ?? '';
    let alive = true;
    api
      .models()
      .then((list) => {
        if (alive) models = list.filter((option) => option.available);
      })
      .catch(() => {
        /* the default and the suggestion still work */
      });
    return () => {
      alive = false;
    };
  });

  /** The gateway rejects answers after `expiresAt`; stop offering them. */
  let expired = $state(false);
  $effect(() => {
    expired = false;
    if (!interaction.expiresAt) return;
    const remaining = Date.parse(interaction.expiresAt) - Date.now();
    if (!(remaining > 0)) {
      expired = true;
      return;
    }
    // setTimeout overflows past ~24.8 days; nothing waits that long.
    const timer = setTimeout(() => (expired = true), Math.min(remaining, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });
  const locked = $derived(disabled || expired);

  function toggle(option: string) {
    if (interaction.kind !== 'select') return;
    if (!interaction.multiple) selected = [option];
    else
      selected = selected.includes(option)
        ? selected.filter((item) => item !== option)
        : [...selected, option];
  }

  function submit() {
    if (interaction.kind === 'confirm')
      onanswer(
        modelChoice
          ? {
              action: 'answer',
              value: true,
              model: model ? (([provider, id]) => ({ provider, id }))(JSON.parse(model)) : null,
              thinking: thinking || null,
            }
          : { action: 'answer', value: true },
      );
    else if (interaction.kind === 'select')
      onanswer({ action: 'answer', value: interaction.multiple ? selected : (selected[0] ?? '') });
    else onanswer({ action: 'answer', value });
  }
</script>

<section class="interaction-card" class:expired aria-labelledby="interaction-{interaction.id}">
  <header>
    <span class="interaction-icon"><CircleHelp size={18} /></span>
    <div>
      <span class="eyebrow">Your input is needed</span>
      <h3 id="interaction-{interaction.id}">{interaction.title}</h3>
      {#if interaction.description}<p>{interaction.description}</p>{/if}
    </div>
  </header>

  {#if interaction.kind === 'select'}
    <!-- A radio group is one tab stop; arrows move and select. Checkboxes each take a stop. -->
    <div
      class="option-list"
      role={interaction.multiple ? 'group' : 'radiogroup'}
      aria-labelledby="interaction-{interaction.id}"
      use:rovingFocus={{
        selector: '[role="radio"]',
        orientation: 'both',
        activate: true,
      }}
    >
      {#each interaction.options as option, index}
        <button
          type="button"
          class:selected={selected.includes(option.value)}
          class="option"
          onclick={() => toggle(option.value)}
          disabled={locked}
          role={interaction.multiple ? 'checkbox' : 'radio'}
          aria-checked={selected.includes(option.value)}
          tabindex={interaction.multiple ||
          (selected.length ? selected[0] === option.value : index === 0)
            ? 0
            : -1}
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
      <input
        bind:value
        placeholder={interaction.placeholder ?? 'Type your answer…'}
        disabled={locked}
      />
    </label>
  {:else if interaction.kind === 'editor'}
    <label>
      <span class="field-label"
        >Response {interaction.language ? `· ${interaction.language}` : ''}</span
      >
      <textarea class="editor" bind:value rows="8" spellcheck="false" disabled={locked}></textarea>
    </label>
  {:else if !modelChoice}
    <p class="confirm-copy">Choose whether the agent should continue with this action.</p>
  {/if}

  <footer>
    {#if interaction.expiresAt}
      <span class="expires"
        ><Clock3 size={14} />
        {expired ? 'Expired' : 'Expires'}
        {new Date(interaction.expiresAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}</span
      >
    {:else}<span></span>{/if}
    <!-- A delegation's model sits between the expiry and the buttons; it moves above them when the card is narrow. -->
    {#if modelChoice}
      <div class="model-choice">
        <select class="model-select" bind:value={model} disabled={locked} aria-label="Model">
          <option value="">Default model</option>
          {#each models as option (modelKey(option))}
            <option value={modelKey(option)}>{option.displayName} · {option.provider}</option>
          {/each}
          {#if model && !models.some((option) => modelKey(option) === model)}
            <option value={model}>{JSON.parse(model).join(' / ')}</option>
          {/if}
        </select>
        <select bind:value={thinking} disabled={locked} aria-label="Thinking">
          <option value="">Default thinking</option>
          {#each THINKING as level (level)}<option value={level}>Thinking: {level}</option>{/each}
        </select>
      </div>
    {/if}
    <div class="interaction-actions">
      <button
        class="button ghost small"
        type="button"
        onclick={() =>
          // A confirm's "No" is a real decline (`confirmed: false`); cancelling
          // would read as "did not answer" to the agent.
          onanswer(
            interaction.kind === 'confirm'
              ? { action: 'answer', value: false }
              : { action: 'cancel' },
          )}
        disabled={locked}
      >
        <X size={15} />
        {interaction.kind === 'confirm' ? (interaction.cancelLabel ?? 'No') : 'Cancel'}
      </button>
      <button
        class="button dark small"
        type="button"
        onclick={submit}
        disabled={locked || (interaction.kind === 'select' && selected.length === 0)}
      >
        {interaction.kind === 'confirm' ? (interaction.confirmLabel ?? 'Yes, continue') : 'Submit'}
        <ArrowRight size={15} />
      </button>
    </div>
  </footer>
</section>

<style>
  /* ───────────── Interaction card ───────────── */
  .interaction-card {
    margin: 4px 0 24px;
    padding: 16px;
    border-radius: var(--radius-lg);
    background: var(--bg-layer);
    box-shadow: var(--shadow-soft);
  }
  .interaction-card {
    /* The footer lays out by the card's own width. */
    container-type: inline-size;
  }
  .interaction-card.expired {
    opacity: 0.65;
  }
  .interaction-card header {
    display: flex;
    gap: 12px;
  }
  .interaction-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .interaction-card h3 {
    margin: 2px 0 4px;
    font-size: 15px;
    font-weight: 600;
  }
  .interaction-card header p,
  .confirm-copy {
    margin: 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.55;
  }
  /* Descriptions can hold paragraphs (a delegated task, a command to confirm). */
  .interaction-card header p {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .confirm-copy {
    margin-top: 12px;
  }
  .option-list {
    display: grid;
    gap: 6px;
    margin: 14px 0 0;
  }
  .option {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--bg-hover);
    text-align: left;
  }
  .option:hover:not(:disabled) {
    background: var(--bg-hover-strong);
  }
  .option.selected {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .option-mark {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1.5px solid var(--line-strong);
    border-radius: 50%;
  }
  .option.selected .option-mark {
    border: 5px solid var(--accent);
  }
  .option span:last-child {
    display: grid;
    gap: 2px;
  }
  .option strong {
    font-size: 14px;
    font-weight: 500;
  }
  .option small {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }
  .interaction-card input,
  .interaction-card textarea {
    width: 100%;
    margin-top: 14px;
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
  }
  .interaction-card input:focus,
  .interaction-card textarea:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .field-label {
    display: block;
    margin-top: 14px;
    color: var(--muted);
    font-size: 12px;
  }
  .interaction-card textarea.editor {
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  /* A delegation's model and thinking level, in the footer row. */
  .model-choice {
    flex: 0 1 auto;
    min-width: 0;
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .model-choice select {
    min-width: 0;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
    font-size: 13px;
    text-overflow: ellipsis;
  }
  .model-choice .model-select {
    flex: 0 1 200px;
  }
  .model-choice + .interaction-actions {
    margin-left: 0;
  }
  /* Too narrow for one row: the picker goes above the expiry and buttons. */
  @container (max-width: 600px) {
    .model-choice {
      order: -1;
      flex-basis: 100%;
      margin-left: 0;
    }
    .model-choice select {
      flex: 1 1 0;
    }
    .model-choice .model-select {
      flex: 2 1 0;
    }
    .model-choice + .interaction-actions {
      margin-left: auto;
    }
  }
  .interaction-card footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }
  .expires {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .interaction-actions {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  @media (max-width: 650px) {
    .interaction-card {
      padding: 14px;
    }
    .interaction-card footer {
      align-items: flex-end;
    }
  }
</style>
