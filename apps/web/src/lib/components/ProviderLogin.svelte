<script lang="ts">
  /**
   * Subscription (OAuth) accounts: log in, answer the provider's prompts, poll
   * until the login completes or expires, log out. Each login is shown inside
   * its provider's card. A pending login is cancelled on the gateway when this
   * unmounts (closing settings).
   */
  import { onMount } from 'svelte';
  import { backendApi, ApiError } from '../api';
  import { t } from '../i18n';
  import type { OAuthProviderOption, ProviderAuthPrompt, ProviderAuthSession } from '../types';

  interface Props {
    providers: OAuthProviderOption[];
    /** Another settings action is running (or the dialog is disabled). */
    locked?: boolean;
    /** A login is pending; other settings changes wait for it. */
    active?: boolean;
    /** A login request is in flight. */
    busy?: boolean;
    onlogout: (providerId: string) => void;
    /** A login succeeded: refresh settings and the model list. */
    onsucceeded: () => Promise<void>;
  }

  let {
    providers,
    locked: parentLocked = false,
    active = $bindable(false),
    busy = $bindable(false),
    onlogout,
    onsucceeded,
  }: Props = $props();

  /** An error, shown in the card of the provider it belongs to. */
  let error: { providerId: string; text: string } | undefined = $state();
  /** The provider whose policy-consent confirmation is open. */
  let consenting: string | undefined = $state();
  let login: ProviderAuthSession | undefined = $state();
  let answers: Record<string, string> = $state({});
  let copied: string | undefined = $state();
  let alive = true;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const activeLogin = $derived(login?.status === 'pending');
  const locked = $derived(parentLocked || busy);
  $effect.pre(() => {
    active = activeLogin;
  });

  function safeError(cause: unknown) {
    return cause instanceof ApiError ? cause.message : t('settings.backends.updateFailed');
  }

  function clearTimers() {
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
  }

  onMount(() => {
    return () => {
      alive = false;
      generation++;
      clearTimers();
      clearTimeout(dismissTimer);
      clearTimeout(copiedTimer);
      answers = {};
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

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    if (!alive) return;
    copied = what;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = undefined), 2000);
  }

  function remaining(expiresAt: number) {
    const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
    return minutes === 1
      ? t('settings.login.minutesOne')
      : t('settings.login.minutesMany', { count: minutes });
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
      // The card shows "Connected"; the confirmation fades after a moment.
      dismissTimer = setTimeout(() => {
        if (login?.id === snapshot.id) login = undefined;
      }, 6000);
      if (alive) await onsucceeded();
    } else if (snapshot.status === 'pending') {
      const left = snapshot.expiresAt - Date.now();
      if (left <= 0) {
        await expireLogin();
        return;
      }
      expiryTimer = setTimeout(() => void expireLogin(), left);
      pollTimer = setTimeout(
        async () => {
          try {
            await acceptLogin(await backendApi.login(snapshot.id), version);
          } catch {
            if (alive && version === generation) {
              error = {
                providerId: snapshot.providerId,
                text: t('settings.login.statusUnavailable'),
              };
              await cancelLogin();
            }
          }
        },
        Math.min(1000, left),
      );
    } else {
      answers = {};
      // Cancelled elsewhere (e.g. a logout): nothing to report.
      if (snapshot.status === 'cancelled') login = undefined;
    }
  }

  function requestLogin(provider: OAuthProviderOption) {
    if (locked || activeLogin) return;
    if (provider.requiresPolicyConsent) consenting = provider.id;
    else void startLogin(provider, false);
  }

  async function startLogin(provider: OAuthProviderOption, policyConsent: boolean) {
    if (locked || activeLogin) return;
    busy = true;
    error = undefined;
    consenting = undefined;
    clearTimeout(dismissTimer);
    login = undefined;
    answers = {};
    const version = ++generation;
    try {
      const snapshot = await backendApi.startLogin(provider.id, policyConsent);
      // Closing the dialog while creation is in flight must not leave a live login behind.
      if (!alive || version !== generation) {
        await backendApi.cancelLogin(snapshot.id);
        return;
      }
      await acceptLogin(snapshot, version);
    } catch (cause) {
      if (alive) error = { providerId: provider.id, text: safeError(cause) };
    } finally {
      busy = false;
    }
  }

  async function cancelLogin(expired = false) {
    if (!login || login.status !== 'pending') return;
    const { id, providerId } = login;
    generation++;
    clearTimers();
    // A user cancellation simply closes the panel; an expiry stays visible.
    login = expired
      ? { ...login, status: 'expired', prompts: [], auth: undefined, progress: undefined }
      : undefined;
    answers = {};
    try {
      await backendApi.cancelLogin(id);
    } catch {
      if (alive)
        error = {
          providerId,
          text: t('settings.login.cancelUnconfirmed'),
        };
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
    error = undefined;
    // Invalidate an older polling response so it cannot restore an answered prompt.
    const version = ++generation;
    clearTimers();
    const { id, providerId } = login;
    expiryTimer = setTimeout(() => void expireLogin(), Math.max(0, login.expiresAt - Date.now()));
    answers = { ...answers, [prompt.id]: '' };
    try {
      await acceptLogin(
        await backendApi.answer(id, prompt.id, cancel ? undefined : value),
        version,
      );
    } catch (cause) {
      if (alive && version === generation) {
        error = { providerId, text: safeError(cause) };
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
</script>

<h4>{t('settings.login.title')}</h4>
<p class="note">{t('settings.login.intro')}</p>
{#each providers as provider (provider.id)}
  {@const current = login?.providerId === provider.id ? login : undefined}
  <div class="backend-card">
    <div class="backend-row">
      <div>
        <strong>{provider.name}</strong><small
          ><span class="badge" class:connected={provider.connected}
            >{provider.connected
              ? t('settings.login.connected')
              : t('settings.login.notConnected')}</span
          >
          · {t('settings.login.knownModels', { count: provider.modelCount })}</small
        >
      </div>
      <div class="backend-actions">
        {#if current?.status !== 'pending' && consenting !== provider.id}<button
            class="button ghost"
            type="button"
            disabled={locked || activeLogin}
            onclick={() => requestLogin(provider)}
            >{provider.connected
              ? t('settings.login.reconnect')
              : t('settings.login.logIn')}</button
          >{/if}
        {#if provider.connected && current?.status !== 'pending'}<button
            class="button ghost"
            type="button"
            title={t('settings.login.logoutTitle')}
            disabled={locked || activeLogin}
            onclick={() => onlogout(provider.providerId)}
            >{t('settings.login.logOut', { name: provider.name })}</button
          >{/if}
      </div>
    </div>

    {#if error?.providerId === provider.id}<p class="backend-error" role="alert">
        {error.text}
      </p>{/if}

    {#if consenting === provider.id}
      <div class="login-panel" role="region" aria-label={t('settings.login.consentAria')}>
        <p>{t('settings.login.consentText')}</p>
        <div class="backend-actions">
          <button
            class="button primary"
            type="button"
            disabled={locked || activeLogin}
            onclick={() => startLogin(provider, true)}>{t('settings.login.agree')}</button
          ><button class="button ghost" type="button" onclick={() => (consenting = undefined)}
            >{t('settings.login.notNow')}</button
          >
        </div>
      </div>
    {/if}

    {#if current}
      <div
        class="login-panel"
        role="region"
        aria-label={t('settings.login.loginAria')}
        aria-live="polite"
      >
        {#if current.status === 'pending'}
          {#if current.auth}
            {@const url = authUrl(current.auth.url)}
            {#if current.auth.userCode}
              <div class="step">
                <span>{t('settings.login.step1')}</span>
                <div class="backend-actions">
                  <code class="user-code">{current.auth.userCode}</code><button
                    class="button ghost"
                    type="button"
                    onclick={() => copy(current.auth!.userCode!, 'code')}
                    >{copied === 'code' ? t('common.copied') : t('settings.login.copyCode')}</button
                  >
                </div>
              </div>
            {/if}
            <div class="step">
              {#if current.auth.userCode}<span>{t('settings.login.step2')}</span>{/if}
              {#if url}<div class="backend-actions">
                  <a
                    class="button primary"
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerpolicy="no-referrer">{t('settings.login.openAuthPage')}</a
                  ><button class="button ghost" type="button" onclick={() => copy(url, 'link')}
                    >{copied === 'link' ? t('common.copied') : t('settings.copyLink')}</button
                  >
                </div>
              {:else}<p role="alert">{t('settings.login.unsupportedUrl')}</p>{/if}
            </div>
            {#if provider.usesCallbackServer}<p class="instructions">
                {t('settings.login.instructions')}
              </p>
            {:else if current.auth.instructions && !current.auth.userCode}<p class="instructions">
                {current.auth.instructions}
              </p>{/if}
          {:else}<p>{t('settings.login.preparing')}</p>{/if}
          {#if current.progress}<p class="note">{current.progress}</p>{/if}
          {#each current.prompts as prompt (prompt.id)}
            <form
              onsubmit={(event) => {
                event.preventDefault();
                void answerPrompt(prompt);
              }}
              autocomplete="off"
            >
              <label
                ><span>{prompt.message}</span>
                {#if prompt.kind === 'select'}
                  <select
                    bind:value={answers[prompt.id]}
                    disabled={locked}
                    required={!prompt.allowEmpty}
                    ><option value="">{t('settings.login.chooseOption')}</option
                    >{#each prompt.options ?? [] as option}<option value={option.id}
                        >{option.label}</option
                      >{/each}</select
                  >
                {:else}
                  <input
                    type={prompt.kind === 'manual' ? 'password' : 'text'}
                    bind:value={answers[prompt.id]}
                    placeholder={prompt.placeholder ??
                      (prompt.kind === 'manual' ? 'http://localhost:…/callback?code=…' : '')}
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
                  >{prompt.kind === 'manual'
                    ? t('settings.login.finish')
                    : t('settings.login.continue')}</button
                >{#if prompt.kind === 'select'}<button
                    class="button ghost"
                    type="button"
                    disabled={locked}
                    onclick={() => answerPrompt(prompt, true)}
                    >{t('settings.login.skipSelection')}</button
                  >{/if}
              </div>
            </form>
          {/each}
          <div class="backend-actions footer">
            <small>{t('settings.login.waiting', { left: remaining(current.expiresAt) })}</small
            ><button class="button ghost" type="button" onclick={() => cancelLogin()}
              >{t('settings.login.cancel')}</button
            >
          </div>
        {:else if current.status === 'succeeded'}<p class="backend-ok">
            {t('settings.login.succeeded', { count: provider.modelCount })}
          </p>
        {:else}
          <p role="alert">
            {current.status === 'expired'
              ? t('settings.login.expired')
              : t('settings.login.failed')}
          </p>
          <div class="backend-actions">
            <button
              class="button ghost"
              type="button"
              disabled={locked || activeLogin}
              onclick={() => requestLogin(provider)}>{t('settings.login.tryAgain')}</button
            ><button class="button ghost" type="button" onclick={() => (login = undefined)}
              >{t('common.dismiss')}</button
            >
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/each}
<p class="note">{t('settings.login.logoutNote')}</p>

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
  .login-panel {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .login-panel .backend-actions {
    margin-top: 8px;
  }
  .step {
    margin-bottom: 12px;
  }
  .step > span {
    font-size: 13px;
  }
  .user-code {
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    font-size: 18px;
    letter-spacing: 0.08em;
    user-select: all;
  }
  .footer {
    justify-content: space-between;
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
  .note {
    color: var(--muted);
    font-size: 12px;
  }
  .badge.connected {
    color: var(--success, #2f9e5b);
  }
  .instructions {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .backend-error {
    color: var(--danger, #d54444);
  }
  .backend-ok {
    color: var(--success, #2f9e5b);
  }
</style>
