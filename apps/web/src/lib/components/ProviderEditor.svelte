<script lang="ts">
  /**
   * Add or edit an API-key / custom-endpoint backend: start from a known
   * service preset, pick models from pi-ai's catalog or the endpoint's own
   * list, and test the connection before saving. A saved API key is never
   * shown; the key field is cleared whenever the form is saved.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { backendApi, ApiError } from '../api';
  import { watch } from '../watch.svelte';
  import type {
    BackendModel,
    BackendPreset,
    BackendProbeInput,
    BackendProvider,
    BackendProviderInput,
    ConnectionTestResult,
    DiscoveredModel,
  } from '../types';

  interface Props {
    /** The backend to edit; a new one when absent. */
    provider?: BackendProvider;
    /** Backend IDs already in use, so a preset suggests a free one. */
    takenIds?: string[];
    locked?: boolean;
    /** Create (`editingId` undefined) or update the backend. */
    onsave: (id: string, input: BackendProviderInput, editingId?: string) => Promise<void>;
    oncancel: () => void;
  }

  let { provider, takenIds = [], locked = false, onsave, oncancel }: Props = $props();

  /** Only editable fields: gateway-derived metadata is never sent back. */
  const editable = ({ id, name, contextWindow, maxTokens, reasoning, input }: BackendModel) => ({
    id,
    ...(name?.trim() ? { name: name.trim() } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input ? { input: [...input] } : {}),
  });

  // The form starts from the backend being edited; the parent remounts it for another one.
  const initial = untrack(() => provider);
  const taken = untrack(() => takenIds);
  const editingId = initial?.id;
  let providerId = $state(initial?.id ?? '');
  let providerApi = $state(initial?.api ?? 'openai-completions');
  let baseUrl = $state(initial?.baseUrl ?? '');
  let opencodeGo = $state(initial?.opencodeGo ?? false);
  let apiKey = $state('');
  let clearKey = $state(false);
  let presetId = $state(initial?.preset ?? '');
  /** The backend ID a preset filled in, replaced when another preset is chosen. */
  let suggestedId = '';
  let presets: BackendPreset[] = $state([]);
  let presetsUnavailable = $state(false);
  let models: BackendModel[] = $state(initial?.models.map(editable) ?? []);
  let discovered: DiscoveredModel[] = $state([]);
  let filter = $state('');
  let manualId = $state('');
  let checking: 'discover' | 'test' | undefined = $state();
  let discovery: { ok: boolean; text: string } | undefined = $state();
  let testResult: ConnectionTestResult | undefined = $state();
  let testModel = $state('');
  let alive = true;

  const preset = $derived(presets.find((item) => item.id === presetId));
  /** Saved with the backend: a catalog preset keeps pi-ai's request compatibility. */
  const savedPreset = $derived(
    editingId ? initial?.preset : preset?.catalog ? preset.id : undefined,
  );
  const presetName = $derived(preset?.name ?? savedPreset);
  const choices = $derived.by(() => {
    const listed = new Set(discovered.map((model) => model.id));
    const catalog = preset?.catalog ? preset.models : [];
    return [...discovered, ...catalog.filter((model) => !listed.has(model.id))];
  });
  const shown = $derived.by(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? choices.filter(
          (model) =>
            model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query),
        )
      : choices;
  });
  const selected = $derived(new Set(models.map((model) => model.id)));
  const busy = $derived(locked || !!checking);
  const ready = $derived(!!providerId.trim() && !!baseUrl.trim() && models.length > 0);

  // A result describes the form it tested; any change makes it stale.
  watch(
    () => [providerApi, baseUrl, apiKey, clearKey, opencodeGo, testModel],
    () => (testResult = undefined),
  );

  onMount(() => {
    backendApi
      .presets()
      .then((list) => {
        if (alive) presets = list;
      })
      .catch(() => {
        if (alive) presetsUnavailable = true;
      });
    return () => {
      alive = false;
    };
  });

  onDestroy(() => {
    apiKey = '';
  });

  function safeError(cause: unknown) {
    return cause instanceof ApiError
      ? cause.message
      : 'The gateway could not be reached. Check the connection and try again.';
  }

  function freeId(base: string) {
    if (!taken.includes(base)) return base;
    for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  }

  function choosePreset(id: string) {
    const previous = preset;
    presetId = id;
    const next = presets.find((item) => item.id === id);
    if (next) {
      providerApi = next.api;
      baseUrl = next.baseUrl;
    } else if (previous && baseUrl === previous.baseUrl) baseUrl = '';
    if (!providerId.trim() || providerId === suggestedId) {
      providerId = suggestedId = next ? freeId(next.id) : '';
    }
    // Models of another service do not carry over.
    models = [];
    discovered = [];
    discovery = undefined;
    filter = '';
  }

  function toggle(model: BackendModel, checked: boolean) {
    if (checked && !selected.has(model.id)) models = [...models, editable(model)];
    else if (!checked) models = models.filter((entry) => entry.id !== model.id);
  }

  function selectShown() {
    const missing = shown.filter((model) => !selected.has(model.id)).slice(0, 200 - models.length);
    models = [...models, ...missing.map(editable)];
  }

  function addManual() {
    const id = manualId.trim();
    if (!id || selected.has(id)) return;
    models = [...models, { id }];
    manualId = '';
  }

  function setImage(model: BackendModel, image: boolean) {
    model.input = image ? ['text', 'image'] : ['text'];
  }

  /** The form as the gateway should probe it; no key reuses the edited backend's saved key. */
  function probeInput(): BackendProbeInput {
    return {
      api: providerApi,
      baseUrl: baseUrl.trim(),
      opencodeGo,
      ...(clearKey
        ? { apiKey: '' }
        : apiKey
          ? { apiKey }
          : editingId
            ? { backendId: editingId }
            : { apiKey: '' }),
      ...(savedPreset ? { preset: savedPreset } : {}),
    };
  }

  async function discover() {
    if (busy || !baseUrl.trim()) return;
    checking = 'discover';
    discovery = undefined;
    try {
      const list = await backendApi.discover(probeInput());
      if (!alive) return;
      discovered = list;
      discovery = {
        ok: true,
        text: list.length
          ? `Found ${list.length} model${list.length === 1 ? '' : 's'}. Select the ones to use.`
          : 'The endpoint lists no models. Add model IDs manually.',
      };
    } catch (cause) {
      if (alive) discovery = { ok: false, text: safeError(cause) };
    } finally {
      checking = undefined;
    }
  }

  async function test() {
    const model = models.find((entry) => entry.id === testModel) ?? models[0];
    if (busy || !model || !baseUrl.trim()) return;
    checking = 'test';
    testResult = undefined;
    try {
      const result = await backendApi.testConnection({ ...probeInput(), model: editable(model) });
      if (alive) testResult = result;
    } catch (cause) {
      if (alive) testResult = { ok: false, message: safeError(cause), latencyMs: 0 };
    } finally {
      checking = undefined;
    }
  }

  async function saveProvider() {
    if (!ready || models.some((model) => !model.id.trim())) return;
    const input: BackendProviderInput = {
      api: providerApi,
      baseUrl: baseUrl.trim(),
      opencodeGo,
      ...(clearKey ? { apiKey: '' } : apiKey ? { apiKey } : !editingId ? { apiKey: '' } : {}),
      ...(savedPreset ? { preset: savedPreset } : {}),
      models: models.map((model) => editable({ ...model, id: model.id.trim() })),
    };
    // Do not retain credentials in the form after submission, including failures.
    apiKey = '';
    await onsave(providerId.trim(), input, editingId);
  }

  function tokens(value: number | undefined) {
    if (!value) return undefined;
    if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
    return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
  }

  function summary(model: BackendModel) {
    const context = tokens(model.contextWindow);
    const output = tokens(model.maxTokens);
    return [
      context ? `${context} context` : 'default limits',
      output ? `${output} output` : undefined,
      model.reasoning ? 'reasoning' : undefined,
      model.input?.includes('image') ? 'images' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
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
  <h4>{editingId ? `Edit ${editingId}` : 'New backend'}</h4>
  {#if !editingId}
    <label
      ><span>Service</span><select
        value={presetId}
        disabled={busy}
        onchange={(event) => choosePreset(event.currentTarget.value)}
        ><option value="">Custom endpoint</option>
        {#if presets.some((item) => item.catalog)}<optgroup label="Cloud services"
            >{#each presets.filter((item) => item.catalog) as item (item.id)}<option value={item.id}
                >{item.name}</option
              >{/each}</optgroup
          >{/if}
        {#if presets.some((item) => !item.catalog)}<optgroup label="Local servers"
            >{#each presets.filter((item) => !item.catalog) as item (item.id)}<option
                value={item.id}>{item.name}</option
              >{/each}</optgroup
          >{/if}</select
      ></label
    >
    {#if presetsUnavailable}<small
        >Service presets are unavailable. Enter the endpoint details manually.</small
      >{/if}
  {/if}
  {#if savedPreset}<p class="hint">
      Uses pi-ai's {presetName} catalog. Known models keep their limits and request compatibility.
    </p>{/if}
  <label
    ><span>Backend ID</span><input
      bind:value={providerId}
      required
      disabled={!!editingId || busy}
    /></label
  >
  <label
    ><span>API</span><select bind:value={providerApi} disabled={busy || !!savedPreset}
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
      disabled={busy}
    /></label
  >
  <label
    ><span>API key (optional)</span><input
      type="password"
      bind:value={apiKey}
      autocomplete="new-password"
      disabled={busy || clearKey}
      placeholder={editingId
        ? 'Leave blank to keep saved key'
        : preset?.keyless
          ? 'Not needed for a local server'
          : 'Leave blank for a no-key endpoint'}
    /></label
  >
  {#if editingId}<label class="backend-checkbox"
      ><input type="checkbox" bind:checked={clearKey} disabled={busy} /><span
        >Remove the saved API key</span
      ></label
    >{/if}
  {#if !savedPreset}<label class="backend-checkbox"
      ><input type="checkbox" bind:checked={opencodeGo} disabled={busy} /><span
        >OpenCode Go compatibility (session routing + pirc User-Agent; automatic for
        opencode.ai/zen/go)</span
      ></label
    >{/if}

  <h5>Models</h5>
  <div class="backend-actions">
    <button class="button ghost" type="button" disabled={busy || !baseUrl.trim()} onclick={discover}
      >{checking === 'discover' ? 'Fetching models…' : 'Fetch models from endpoint'}</button
    >
  </div>
  {#if discovery}<p class:backend-error={!discovery.ok} role="status">{discovery.text}</p>{/if}

  {#if choices.length}
    <div class="picker">
      <div class="backend-actions">
        <input
          class="filter"
          type="search"
          bind:value={filter}
          placeholder={`Filter ${choices.length} models`}
          aria-label="Filter models"
        />
        <button class="button ghost" type="button" disabled={busy} onclick={selectShown}
          >Select shown</button
        >
      </div>
      <ul class="choices" aria-label="Available models">
        {#each shown as model (model.id)}
          <li>
            <label class="backend-checkbox"
              ><input
                type="checkbox"
                checked={selected.has(model.id)}
                disabled={busy}
                onchange={(event) => toggle(model, event.currentTarget.checked)}
              /><span>{model.name ?? model.id}</span><small>{model.id} · {summary(model)}</small
              ></label
            >
          </li>
        {:else}<li><small>No models match the filter.</small></li>{/each}
      </ul>
    </div>
  {/if}

  {#if models.length}
    <ul class="selected" aria-label="Selected models">
      {#each models as model (model.id)}
        <li>
          <div class="model-head">
            <div>
              <strong>{model.name || model.id}</strong><small>{model.id} · {summary(model)}</small>
            </div>
            <button
              class="button ghost"
              type="button"
              disabled={busy}
              onclick={() => toggle(model, false)}>Remove {model.id}</button
            >
          </div>
          <details>
            <summary>Details</summary>
            <fieldset disabled={busy}>
              <label><span>Display name</span><input bind:value={model.name} /></label>
              <label
                ><span>Context window (tokens)</span><input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="200000"
                  bind:value={model.contextWindow}
                /></label
              >
              <label
                ><span>Maximum output tokens</span><input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="32000"
                  bind:value={model.maxTokens}
                /></label
              >
              <label class="backend-checkbox"
                ><input
                  type="checkbox"
                  checked={model.reasoning ?? false}
                  onchange={(event) => (model.reasoning = event.currentTarget.checked)}
                /><span>Supports reasoning</span></label
              >
              <label class="backend-checkbox"
                ><input
                  type="checkbox"
                  checked={model.input?.includes('image') ?? false}
                  onchange={(event) => setImage(model, event.currentTarget.checked)}
                /><span>Supports image input</span></label
              >
            </fieldset>
          </details>
        </li>
      {/each}
    </ul>
  {:else}<p class="hint">
      {choices.length
        ? 'Select at least one model above, or add a model ID.'
        : 'Fetch the endpoint’s models, or add a model ID.'}
    </p>{/if}

  <div class="backend-actions manual">
    <label
      ><span>Model ID</span><input
        bind:value={manualId}
        disabled={busy}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            addManual();
          }
        }}
      /></label
    ><button
      class="button ghost"
      type="button"
      disabled={busy || !manualId.trim() || selected.has(manualId.trim())}
      onclick={addManual}>Add model</button
    >
  </div>

  <div class="backend-actions">
    {#if models.length > 1}<label class="inline"
        ><span>Test with</span><select bind:value={testModel} disabled={busy}
          >{#each models as model (model.id)}<option value={model.id}
              >{model.name || model.id}</option
            >{/each}</select
        ></label
      >{/if}
    <button
      class="button ghost"
      type="button"
      disabled={busy || !models.length || !baseUrl.trim()}
      onclick={test}>{checking === 'test' ? 'Testing…' : 'Test connection'}</button
    >
  </div>
  {#if testResult}<p
      class:backend-error={!testResult.ok}
      class:backend-ok={testResult.ok}
      role="status"
    >
      {testResult.ok ? `Connected. ${testResult.message}` : testResult.message}
    </p>{/if}

  <div class="backend-actions">
    <button class="button primary" type="submit" disabled={busy || !ready}>Save backend</button
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
  h5 {
    margin: 16px 0 6px;
    font-size: 13px;
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
  .hint,
  small {
    color: var(--muted);
    font-size: 12px;
  }
  .backend-error {
    color: var(--danger, #d54444);
  }
  .backend-ok {
    color: var(--success, #2f9e5b);
  }
  .picker {
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .filter {
    flex: 1 1 160px;
    min-width: 0;
  }
  ul {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .choices {
    max-height: 240px;
    overflow-y: auto;
  }
  .choices li {
    padding: 4px 0;
  }
  .choices label {
    flex-wrap: wrap;
    align-items: baseline;
  }
  .choices small {
    flex-basis: 100%;
    padding-left: 24px;
    overflow-wrap: anywhere;
  }
  .selected li {
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }
  .model-head {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .model-head > div {
    min-width: 0;
  }
  .model-head strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .model-head small {
    display: block;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 6px;
    font-size: 13px;
  }
  fieldset {
    min-width: 0;
    margin: 8px 0 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .manual label {
    flex: 1 1 180px;
  }
  .inline {
    display: flex;
    gap: 8px;
    align-items: center;
  }
</style>
