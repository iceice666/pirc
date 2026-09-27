<script lang="ts">
  /**
   * Model backends: subscription accounts (ProviderLogin), API-key and custom
   * endpoints (ProviderEditor) and the gateway default model.
   */
  import { onMount } from 'svelte';
  import { backendApi, ApiError } from '../api';
  import { watch } from '../watch.svelte';
  import type { BackendProvider, BackendProviderInput, BackendSettingsSnapshot } from '../types';
  import ProviderEditor from './ProviderEditor.svelte';
  import ProviderLogin from './ProviderLogin.svelte';

  interface Props {
    disabled?: boolean;
    onchanged?: () => void | Promise<void>;
  }

  let { disabled = false, onchanged = () => {} }: Props = $props();

  let settings: BackendSettingsSnapshot | undefined = $state();
  let error = $state('');
  let busy = $state(false);
  let loading = $state(true);
  let alive = true;
  /** The open editor; a fresh object per opening so the form remounts. */
  let editor: { provider?: BackendProvider } | undefined = $state();
  let defaultChoice = $state('');
  /** A subscription login is pending (other changes wait) / its request is in flight. */
  let activeLogin = $state(false);
  let loginBusy = $state(false);

  let locked = $derived(disabled || busy || loginBusy);
  // Only a changed saved default resets the picker, so a refresh (e.g. after a
  // login) keeps a selection that has not been saved yet.
  watch(
    () =>
      settings?.defaultModel
        ? JSON.stringify([settings.defaultModel.provider, settings.defaultModel.id])
        : '',
    (saved) => (defaultChoice = saved),
    { immediate: true },
  );

  function safeError(cause: unknown) {
    return cause instanceof ApiError
      ? cause.message
      : 'Unable to update backend settings. Check the connection and try again.';
  }

  async function refresh() {
    const snapshot = await backendApi.settings();
    if (alive) settings = snapshot;
  }

  // Loads once enabled, including when `disabled` turns false after mount.
  watch(
    () => disabled,
    (isDisabled) => {
      if (isDisabled) {
        loading = false;
        return;
      }
      if (settings) return;
      loading = true;
      void refresh()
        .catch((cause) => {
          if (alive) error = safeError(cause);
        })
        .finally(() => {
          loading = false;
        });
    },
    { immediate: true },
  );

  onMount(() => () => {
    alive = false;
  });

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

  async function loginSucceeded() {
    await refresh();
    if (alive) await onchanged();
  }

  function editProvider(provider?: BackendProvider) {
    if (locked || activeLogin || provider?.readOnly) return;
    editor = { provider };
  }

  function closeEditor() {
    editor = undefined;
  }

  async function saveProvider(id: string, input: BackendProviderInput, editingId?: string) {
    await mutate(async () => {
      const snapshot = editingId
        ? await backendApi.update(editingId, input)
        : await backendApi.create(id, input);
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
      <ProviderLogin
        providers={settings.oauthProviders}
        {locked}
        bind:active={activeLogin}
        bind:busy={loginBusy}
        onlogout={(providerId) => mutate(() => backendApi.remove(providerId))}
        onsucceeded={loginSucceeded}
      />

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
                onclick={() => editProvider(provider)}>Edit {provider.id}</button
              ><button
                class="button ghost"
                type="button"
                disabled={locked || activeLogin}
                onclick={() => mutate(() => backendApi.remove(provider.id))}
                >Remove {provider.id}</button
              >
            </div>{/if}
        </div>
      {/each}
      <button
        class="button ghost"
        type="button"
        disabled={locked || activeLogin}
        onclick={() => editProvider()}>Add backend</button
      >

      {#if editor}
        {#key editor}
          <ProviderEditor
            provider={editor.provider}
            locked={locked || activeLogin}
            onsave={saveProvider}
            oncancel={closeEditor}
          />
        {/key}
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
        onclick={saveDefault}>Save default</button
      >
      <p>Applies to new runs that have no explicit model selection.</p>
    {:else}<button
        class="button ghost"
        type="button"
        onclick={() => refresh().catch((cause) => (error = safeError(cause)))}
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
  .backend-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
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
</style>
