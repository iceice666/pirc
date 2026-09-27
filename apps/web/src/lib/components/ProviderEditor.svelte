<script lang="ts">
  /**
   * Add or edit an API-key / custom-endpoint backend. A saved API key is never
   * shown; the key field is cleared whenever the form is submitted.
   */
  import { onDestroy, untrack } from 'svelte';
  import type { BackendModel, BackendProvider, BackendProviderInput } from '../types';

  interface Props {
    /** The backend to edit; a new one when absent. */
    provider?: BackendProvider;
    locked?: boolean;
    /** Create (`editingId` undefined) or update the backend. */
    onsave: (id: string, input: BackendProviderInput, editingId?: string) => Promise<void>;
    oncancel: () => void;
  }

  let { provider, locked = false, onsave, oncancel }: Props = $props();

  // The form starts from the backend being edited; the parent remounts it for another one.
  const initial = untrack(() => provider);
  const editingId = initial?.id;
  let providerId = $state(initial?.id ?? '');
  let providerApi = $state(initial?.api ?? 'openai-completions');
  let baseUrl = $state(initial?.baseUrl ?? '');
  let apiKey = $state('');
  let clearKey = $state(false);
  // Only editable fields: gateway-derived metadata is never sent back.
  let modelRows: BackendModel[] = $state(
    initial?.models.map(({ id, name, contextWindow, maxTokens, reasoning, input }) => ({
      id,
      name,
      contextWindow,
      maxTokens,
      reasoning,
      input,
    })) ?? [{ id: '', name: '' }],
  );

  onDestroy(() => {
    apiKey = '';
  });

  async function saveProvider() {
    if (
      !providerId.trim() ||
      !baseUrl.trim() ||
      !modelRows.length ||
      modelRows.some((model) => !model.id.trim())
    )
      return;
    const input = {
      api: providerApi,
      baseUrl: baseUrl.trim(),
      ...(clearKey ? { apiKey: '' } : apiKey ? { apiKey } : !editingId ? { apiKey: '' } : {}),
      models: modelRows.map((model) => ({ ...model, id: model.id.trim() })),
    };
    // Do not retain credentials in the form after submission, including failures.
    apiKey = '';
    await onsave(providerId.trim(), input, editingId);
  }
</script>

<form
  class="backend-card"
  onsubmit={(event) => {
    event.preventDefault();
    void saveProvider();
  }}
  autocomplete="off"
>
  <h4>{editingId ? 'Edit backend' : 'New backend'}</h4>
  <label
    ><span>Backend ID</span><input
      bind:value={providerId}
      required
      disabled={!!editingId || locked}
    /></label
  >
  <label
    ><span>API</span><select bind:value={providerApi} disabled={locked}
      ><option value="openai-completions">OpenAI-compatible chat</option><option value="openai-chat"
        >OpenAI chat (legacy)</option
      ><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages"
        >Anthropic Messages</option
      ></select
    ></label
  >
  <label
    ><span>Base URL</span><input
      type="url"
      bind:value={baseUrl}
      placeholder="http://localhost:11434/v1"
      required
      disabled={locked}
    /></label
  >
  <label
    ><span>API key (optional)</span><input
      type="password"
      bind:value={apiKey}
      autocomplete="new-password"
      disabled={locked || clearKey}
      placeholder={editingId
        ? 'Leave blank to keep saved key'
        : 'Leave blank for a no-key endpoint'}
    /></label
  >
  {#if editingId}<label class="backend-checkbox"
      ><input type="checkbox" bind:checked={clearKey} disabled={locked} /><span
        >Remove the saved API key</span
      ></label
    >{/if}
  {#each modelRows as model, index}
    <fieldset disabled={locked}>
      <legend>Model {index + 1}</legend>
      <label><span>Model ID</span><input bind:value={model.id} required /></label>
      <label><span>Display name</span><input bind:value={model.name} /></label>
      <label
        ><span>Context window (tokens)</span><input
          type="number"
          min="1"
          step="1"
          bind:value={model.contextWindow}
        /></label
      >
      <label
        ><span>Maximum output tokens</span><input
          type="number"
          min="1"
          step="1"
          bind:value={model.maxTokens}
        /></label
      >
      <label class="backend-checkbox"
        ><input type="checkbox" bind:checked={model.reasoning} /><span>Supports reasoning</span
        ></label
      >
      <label class="backend-checkbox"
        ><input
          type="checkbox"
          checked={model.input?.includes('image') ?? false}
          onchange={(event) => {
            model.input = event.currentTarget.checked ? ['text', 'image'] : ['text'];
          }}
        /><span>Supports image input</span></label
      >
      <button
        class="button ghost"
        type="button"
        onclick={() => (modelRows = modelRows.filter((_, i) => i !== index))}>Remove model</button
      >
    </fieldset>
  {/each}
  <div class="backend-actions">
    <button
      class="button ghost"
      type="button"
      disabled={locked}
      onclick={() => (modelRows = [...modelRows, { id: '', name: '' }])}>Add model</button
    ><button class="button primary" type="submit" disabled={locked || !modelRows.length}
      >Save backend</button
    ><button class="button ghost" type="button" disabled={locked} onclick={oncancel}
      >Cancel editing</button
    >
  </div>
</form>

<style>
  h4 {
    margin: 20px 0 10px;
    font-size: 14px;
  }
  .backend-card {
    margin: 12px 0;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .backend-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .backend-checkbox {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .backend-checkbox input {
    width: 16px;
    height: 16px;
    flex: none;
    margin: 2px 0;
  }
  fieldset {
    min-width: 0;
    margin: 12px 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  legend {
    font-size: 13px;
  }
</style>
