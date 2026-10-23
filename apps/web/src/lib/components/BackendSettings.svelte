<script lang="ts">
  /**
   * Model backends: subscription accounts (ProviderLogin), API-key and custom
   * endpoints (ProviderEditor) and the gateway default model.
   */
  import { onMount } from 'svelte';
  import { backendApi, ApiError } from '../api';
  import { watch } from '../watch.svelte';
  import { t } from '../i18n';
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
    return cause instanceof ApiError ? cause.message : t('settings.backends.updateFailed');
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
  <h3 id="backend-title">{t('settings.backends.title')}</h3>
  <p>{t('settings.backends.intro')}</p>
  {#if disabled}
    <p role="status">{t('settings.backends.demo')}</p>
  {:else if loading}
    <p role="status">{t('settings.backends.loading')}</p>
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

      <h4>{t('settings.backends.keysTitle')}</h4>
      {#each settings.providers.filter((provider) => provider.source !== 'oauth') as provider (provider.id)}
        {#if editor?.provider?.id === provider.id}
          {#key editor}
            <ProviderEditor
              provider={editor.provider}
              locked={locked || activeLogin}
              onsave={saveProvider}
              oncancel={closeEditor}
            />
          {/key}
        {:else}<div class="backend-card">
            <strong>{provider.name || provider.id}</strong>
            <small
              >{provider.source === 'file'
                ? t('settings.backends.fileManaged')
                : t('settings.backends.webManaged')} · {provider.api}
              · {provider.hasApiKey
                ? t('settings.backends.keySaved')
                : t('settings.backends.noKey')}{provider.preset
                ? ` · ${t('settings.backends.preset', { preset: provider.preset })}`
                : ''}</small
            >
            {#if provider.baseUrl}<p class="endpoint">{provider.baseUrl}</p>{/if}
            <details>
              <summary>{t('settings.backends.models', { count: provider.models.length })}</summary>
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
                  onclick={() => editProvider(provider)}
                  >{t('settings.backends.edit', { id: provider.id })}</button
                ><button
                  class="button ghost"
                  type="button"
                  disabled={locked || activeLogin}
                  onclick={() => mutate(() => backendApi.remove(provider.id))}
                  >{t('settings.backends.remove', { id: provider.id })}</button
                >
              </div>{/if}
          </div>{/if}
      {/each}
      {#if editor && !editor.provider}
        {#key editor}
          <ProviderEditor
            takenIds={settings.providers.map((provider) => provider.id)}
            locked={locked || activeLogin}
            onsave={saveProvider}
            oncancel={closeEditor}
          />
        {/key}
      {:else}<button
          class="button ghost"
          type="button"
          disabled={locked || activeLogin || !!editor}
          onclick={() => editProvider()}>{t('settings.backends.add')}</button
        >{/if}

      <h4>{t('settings.backends.defaultTitle')}</h4>
      <label
        ><span>{t('settings.backends.gatewayDefault')}</span><select
          bind:value={defaultChoice}
          disabled={locked || activeLogin}
          ><option value="">{t('settings.backends.useFileDefault')}</option
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
        onclick={saveDefault}>{t('settings.backends.saveDefault')}</button
      >
      <p>{t('settings.backends.defaultHint')}</p>
    {:else}<button
        class="button ghost"
        type="button"
        onclick={() => refresh().catch((cause) => (error = safeError(cause)))}
        >{t('settings.backends.retry')}</button
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
