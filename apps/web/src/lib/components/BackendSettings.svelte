<script lang="ts">
  import { onMount } from 'svelte';
  import { backendApi, ApiError } from '../api';
  import type {
    BackendModel,
    BackendProvider,
    BackendSettingsSnapshot,
    OAuthProviderOption,
    ProviderAuthPrompt,
    ProviderAuthSession,
  } from '../types';

  export let disabled = false;
  export let onchanged: () => void | Promise<void> = () => {};

  let settings: BackendSettingsSnapshot | undefined;
  let error = '';
  let busy = false;
  let loading = true;
  let consent: Record<string, boolean> = {};
  let login: ProviderAuthSession | undefined;
  let answers: Record<string, string> = {};
  let alive = true;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let editor = false;
  let editingId: string | undefined;
  let providerId = '';
  let providerApi = 'openai-completions';
  let baseUrl = '';
  let apiKey = '';
  let clearKey = false;
  let modelRows: BackendModel[] = [];
  let defaultChoice = '';

  $: activeLogin = login?.status === 'pending';
  $: locked = disabled || busy;
  $: defaultChoice = settings?.defaultModel
    ? JSON.stringify([settings.defaultModel.provider, settings.defaultModel.id])
    : '';

  function safeError(cause: unknown) {
    return cause instanceof ApiError
      ? cause.message
      : 'Unable to update backend settings. Check the connection and try again.';
  }

  function clearTimers() {
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
  }

  async function refresh() {
    const snapshot = await backendApi.settings();
    if (alive) settings = snapshot;
  }

  onMount(() => {
    if (disabled) loading = false;
    else
      void refresh()
        .catch((cause) => {
          if (alive) error = safeError(cause);
        })
        .finally(() => {
          loading = false;
        });
    return () => {
      alive = false;
      generation++;
      clearTimers();
      answers = {};
      apiKey = '';
      if (login?.status === 'pending') void backendApi.cancelLogin(login.id).catch(() => {});
    };
  });

  /** Only HTTPS provider authorization links are clickable; callback URLs are input only. */
  function authUrl(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password
        ? parsed.href
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function changed(snapshot: BackendSettingsSnapshot) {
    if (!alive) return;
    settings = snapshot;
    await onchanged();
  }

  async function mutate(action: () => Promise<BackendSettingsSnapshot>) {
    if (locked || activeLogin) return;
    busy = true;
    error = '';
    try {
      await changed(await action());
    } catch (cause) {
      if (alive) error = safeError(cause);
    } finally {
      busy = false;
    }
  }

  async function acceptLogin(snapshot: ProviderAuthSession, version: number) {
    if (!alive || version !== generation) return;
    clearTimers();
    login = snapshot;
    answers = Object.fromEntries(
      snapshot.prompts.map((prompt) => [prompt.id, answers[prompt.id] ?? '']),
    );
    if (snapshot.status === 'succeeded') {
      answers = {};
      await refresh();
      if (alive) await onchanged();
    } else if (snapshot.status === 'pending') {
      const remaining = snapshot.expiresAt - Date.now();
      if (remaining <= 0) {
        await expireLogin();
        return;
      }
      expiryTimer = setTimeout(() => void expireLogin(), remaining);
      pollTimer = setTimeout(
        async () => {
          try {
            await acceptLogin(await backendApi.login(snapshot.id), version);
          } catch {
            if (alive && version === generation) {
              error = 'Login status is unavailable. Start a new login to retry.';
              await cancelLogin();
            }
          }
        },
        Math.min(1000, remaining),
      );
    } else answers = {};
  }

  async function startLogin(provider: OAuthProviderOption) {
    if (locked || activeLogin || (provider.requiresPolicyConsent && !consent[provider.id])) return;
    busy = true;
    error = '';
    login = undefined;
    answers = {};
    const version = ++generation;
    try {
      const snapshot = await backendApi.startLogin(provider.id, consent[provider.id] === true);
      // Closing the dialog while creation is in flight must not leave a live login behind.
      if (!alive || version !== generation) {
        await backendApi.cancelLogin(snapshot.id);
        return;
      }
      await acceptLogin(snapshot, version);
    } catch (cause) {
      if (alive) error = safeError(cause);
    } finally {
      busy = false;
    }
  }

  async function cancelLogin(expired = false) {
    if (!login || login.status !== 'pending') return;
    const id = login.id;
    generation++;
    clearTimers();
    login = { ...login, status: expired ? 'expired' : 'cancelled', prompts: [], auth: undefined };
    answers = {};
    try {
      await backendApi.cancelLogin(id);
    } catch {
      if (alive) error = 'Could not confirm cancellation. This login will expire on the gateway.';
    }
  }

  async function expireLogin() {
    await cancelLogin(true);
  }

  async function answerPrompt(prompt: ProviderAuthPrompt, cancel = false) {
    if (locked || !login || login.status !== 'pending') return;
    const value = answers[prompt.id] ?? '';
    if (!cancel && !prompt.allowEmpty && !value) return;
    busy = true;
    error = '';
    // Invalidate an older polling response so it cannot restore an answered prompt.
    const version = ++generation;
    clearTimers();
    const id = login.id;
    expiryTimer = setTimeout(() => void expireLogin(), Math.max(0, login.expiresAt - Date.now()));
    answers = { ...answers, [prompt.id]: '' };
    try {
      await acceptLogin(
        await backendApi.answer(id, prompt.id, cancel ? undefined : value),
        version,
      );
    } catch (cause) {
      if (alive && version === generation) {
        error = safeError(cause);
        try {
          await acceptLogin(await backendApi.login(id), version);
        } catch {
          await cancelLogin();
        }
      }
    } finally {
      busy = false;
    }
  }

  function editProvider(provider?: BackendProvider) {
    if (locked || activeLogin || provider?.readOnly) return;
    editingId = provider?.id;
    providerId = provider?.id ?? '';
    providerApi = provider?.api ?? 'openai-completions';
    baseUrl = provider?.baseUrl ?? '';
    apiKey = '';
    clearKey = false;
    modelRows = provider?.models.map(
      ({ id, name, contextWindow, maxTokens, reasoning, input }) => ({
        id,
        name,
        contextWindow,
        maxTokens,
        reasoning,
        input,
      }),
    ) ?? [{ id: '', name: '' }];
    editor = true;
  }

  function closeEditor() {
    editor = false;
    apiKey = '';
    modelRows = [];
  }

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
    await mutate(async () => {
      const snapshot = editingId
        ? await backendApi.update(editingId, input)
        : await backendApi.create(providerId.trim(), input);
      closeEditor();
      return snapshot;
    });
  }

  function saveDefault() {
    const selection = defaultChoice ? (JSON.parse(defaultChoice) as [string, string]) : undefined;
    void mutate(() =>
      backendApi.setDefault(selection ? { provider: selection[0], id: selection[1] } : null),
    );
  }
</script>

<section class="settings-section backend-settings" aria-labelledby="backend-title">
  <h3 id="backend-title">Model backends</h3>
  <p>
    Global settings for this single-user gateway. All model requests run on the gateway; endpoints
    must be reachable from there.
  </p>
  {#if disabled}
    <p role="status">
      Backend settings are unavailable in demo mode. No real accounts or settings will be changed.
    </p>
  {:else if loading}
    <p role="status">Loading backends…</p>
  {:else}
    {#if error}<p class="backend-error" role="alert">{error}</p>{/if}
    {#if settings}
      <h4>Subscription accounts</h4>
      <p>
        Pi's known model catalog is not a verification of your account's model access or service
        policy.
      </p>
      {#each settings.oauthProviders as provider (provider.id)}
        <div class="backend-card">
          <div class="backend-row">
            <div>
              <strong>{provider.name}</strong><small
                >{provider.connected ? 'Connected' : 'Not connected'} · {provider.modelCount} known models</small
              >
            </div>
            <button
              class="button ghost"
              type="button"
              disabled={locked ||
                activeLogin ||
                (provider.requiresPolicyConsent && !consent[provider.id])}
              on:click={() => startLogin(provider)}
              >{provider.connected ? 'Reconnect' : 'Log in'}</button
            >
          </div>
          {#if provider.requiresPolicyConsent}
            <label class="backend-checkbox"
              ><input
                type="checkbox"
                bind:checked={consent[provider.id]}
                disabled={locked || activeLogin}
              /><span
                >I consent to this login enabling policies for all known GitHub Copilot models in my
                account.</span
              ></label
            >
          {/if}
          {#if provider.usesCallbackServer}<p>
              For a remote gateway, paste the complete final localhost redirect URL below after
              authorizing. You do not need to expose a callback port.
            </p>{/if}
          {#if provider.connected}<button
              class="button ghost"
              type="button"
              disabled={locked || activeLogin}
              on:click={() => mutate(() => backendApi.remove(provider.providerId))}
              >Log out {provider.name}</button
            >{/if}
        </div>
      {/each}
      <p>
        Log out removes this gateway's saved credentials and prevents new requests. It does not
        revoke your account upstream or recall content already sent.
      </p>

      {#if login}
        <div class="backend-card login-card" aria-label="Provider login" aria-live="polite">
          <strong>Login: {login.status}</strong>
          {#if login.status === 'pending'}
            <p>
              Expires at {new Date(login.expiresAt).toLocaleTimeString()}. Closing settings cancels
              this login.
            </p>
            {#if login.auth}
              {@const url = authUrl(login.auth.url)}
              {#if url}<a
                  class="button ghost"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerpolicy="no-referrer">Open authorization page</a
                >{:else}<p role="alert">
                  The provider returned an unsupported authorization URL.
                </p>{/if}
              {#if login.auth.instructions}<p class="instructions">
                  {login.auth.instructions}
                </p>{/if}
            {/if}
            {#if login.progress}<p>{login.progress}</p>{/if}
            {#each login.prompts as prompt (prompt.id)}
              <form on:submit|preventDefault={() => answerPrompt(prompt)} autocomplete="off">
                <label
                  ><span>{prompt.message}</span>
                  {#if prompt.kind === 'select'}
                    <select
                      bind:value={answers[prompt.id]}
                      disabled={locked}
                      required={!prompt.allowEmpty}
                      ><option value="">Choose an option</option
                      >{#each prompt.options ?? [] as option}<option value={option.id}
                          >{option.label}</option
                        >{/each}</select
                    >
                  {:else}
                    <input
                      type={prompt.kind === 'manual' ? 'password' : 'text'}
                      bind:value={answers[prompt.id]}
                      placeholder={prompt.placeholder ??
                        (prompt.kind === 'manual' ? 'Complete localhost redirect URL' : '')}
                      disabled={locked}
                      required={!prompt.allowEmpty}
                      autocomplete="off"
                      spellcheck={false}
                    />
                  {/if}
                </label>
                <div class="backend-actions">
                  <button
                    class="button ghost"
                    type="submit"
                    disabled={locked || (!prompt.allowEmpty && !answers[prompt.id])}
                    >Submit response</button
                  >{#if prompt.kind === 'select'}<button
                      class="button ghost"
                      type="button"
                      disabled={locked}
                      on:click={() => answerPrompt(prompt, true)}>Skip selection</button
                    >{/if}
                </div>
              </form>
            {/each}
            <button class="button ghost" type="button" on:click={() => cancelLogin()}
              >Cancel login</button
            >
          {:else if login.status === 'succeeded'}<p>
              Login complete. The model catalog has been refreshed.
            </p>
          {:else if login.status === 'failed'}<p role="alert">
              Login failed. Please start a new login and try again.
            </p>
          {:else if login.status === 'expired'}<p>Login expired. Please start a new login.</p>{/if}
        </div>
      {/if}

      <h4>API keys and custom endpoints</h4>
      {#each settings.providers.filter((provider) => provider.source !== 'oauth') as provider (provider.id)}
        <div class="backend-card">
          <strong>{provider.name || provider.id}</strong>
          <small
            >{provider.source === 'file' ? 'File-managed · Read only' : 'Web-managed'} · {provider.api}
            · {provider.hasApiKey ? 'API key saved' : 'No API key'}</small
          >
          {#if provider.baseUrl}<p class="endpoint">{provider.baseUrl}</p>{/if}
          <details>
            <summary>{provider.models.length} models</summary>
            <ul>
              {#each provider.models as model}<li>
                  {model.name ?? model.id} <small>{model.id}</small>
                </li>{/each}
            </ul>
          </details>
          {#if !provider.readOnly}<div class="backend-actions">
              <button
                class="button ghost"
                type="button"
                disabled={locked || activeLogin}
                on:click={() => editProvider(provider)}>Edit {provider.id}</button
              ><button
                class="button ghost"
                type="button"
                disabled={locked || activeLogin}
                on:click={() => mutate(() => backendApi.remove(provider.id))}
                >Remove {provider.id}</button
              >
            </div>{/if}
        </div>
      {/each}
      <button
        class="button ghost"
        type="button"
        disabled={locked || activeLogin}
        on:click={() => editProvider()}>Add backend</button
      >

      {#if editor}
        <form class="backend-card" on:submit|preventDefault={saveProvider} autocomplete="off">
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
              ><option value="openai-completions">OpenAI-compatible chat</option><option
                value="openai-chat">OpenAI chat (legacy)</option
              ><option value="openai-responses">OpenAI Responses</option><option
                value="anthropic-messages">Anthropic Messages</option
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
                ><input type="checkbox" bind:checked={model.reasoning} /><span
                  >Supports reasoning</span
                ></label
              >
              <label class="backend-checkbox"
                ><input
                  type="checkbox"
                  checked={model.input?.includes('image') ?? false}
                  on:change={(event) => {
                    model.input = event.currentTarget.checked ? ['text', 'image'] : ['text'];
                    modelRows = modelRows;
                  }}
                /><span>Supports image input</span></label
              >
              <button
                class="button ghost"
                type="button"
                on:click={() => (modelRows = modelRows.filter((_, i) => i !== index))}
                >Remove model</button
              >
            </fieldset>
          {/each}
          <div class="backend-actions">
            <button
              class="button ghost"
              type="button"
              disabled={locked}
              on:click={() => (modelRows = [...modelRows, { id: '', name: '' }])}>Add model</button
            ><button
              class="button primary"
              type="submit"
              disabled={locked || activeLogin || !modelRows.length}>Save backend</button
            ><button class="button ghost" type="button" disabled={locked} on:click={closeEditor}
              >Cancel editing</button
            >
          </div>
        </form>
      {/if}

      <h4>Default model</h4>
      <label
        ><span>Gateway default</span><select
          bind:value={defaultChoice}
          disabled={locked || activeLogin}
          ><option value="">Use file default / automatic</option
          >{#each settings.providers as provider}{#each provider.models as model}<option
                value={JSON.stringify([provider.id, model.id])}
                >{provider.name || provider.id} / {model.name ?? model.id}</option
              >{/each}{/each}</select
        ></label
      >
      <button
        class="button ghost"
        type="button"
        disabled={locked || activeLogin}
        on:click={saveDefault}>Save default</button
      >
      <p>Applies to new runs that have no explicit model selection.</p>
    {:else}<button
        class="button ghost"
        type="button"
        on:click={() => refresh().catch((cause) => (error = safeError(cause)))}
        >Retry settings</button
      >{/if}
  {/if}
</section>

<style>
  .backend-settings {
    min-width: 0;
  }
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
  .backend-row,
  .backend-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .backend-row {
    justify-content: space-between;
  }
  .backend-actions {
    margin-top: 10px;
  }
  strong {
    font-size: 13px;
  }
  small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 12px;
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
  .instructions {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .endpoint {
    overflow-wrap: anywhere;
  }
  .backend-error {
    color: var(--danger, #d54444);
  }
  details {
    margin-top: 8px;
    font-size: 13px;
  }
  details ul {
    max-height: 180px;
    overflow-y: auto;
    padding-left: 20px;
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
