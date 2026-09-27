<script lang="ts">
  /**
   * Subscription (OAuth) accounts: log in, answer the provider's prompts, poll
   * until the login completes or expires, log out. A pending login is
   * cancelled on the gateway when this unmounts (closing settings).
   */
  import { onMount } from 'svelte';
  import { backendApi, ApiError } from '../api';
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

  let error = $state('');
  let consent: Record<string, boolean> = $state({});
  let login: ProviderAuthSession | undefined = $state();
  let answers: Record<string, string> = $state({});
  let alive = true;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const activeLogin = $derived(login?.status === 'pending');
  const locked = $derived(parentLocked || busy);
  $effect.pre(() => {
    active = activeLogin;
  });

  function safeError(cause: unknown) {
    return cause instanceof ApiError
      ? cause.message
      : 'Unable to update backend settings. Check the connection and try again.';
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

  async function acceptLogin(snapshot: ProviderAuthSession, version: number) {
    if (!alive || version !== generation) return;
    clearTimers();
    login = snapshot;
    answers = Object.fromEntries(
      snapshot.prompts.map((prompt) => [prompt.id, answers[prompt.id] ?? '']),
    );
    if (snapshot.status === 'succeeded') {
      answers = {};
      if (alive) await onsucceeded();
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
</script>

{#if error}<p class="backend-error" role="alert">{error}</p>{/if}
<h4>Subscription accounts</h4>
<p>
  pi-ai's built-in model catalog is not a verification of your account's model access or service
  policy.
</p>
{#each providers as provider (provider.id)}
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
        onclick={() => startLogin(provider)}>{provider.connected ? 'Reconnect' : 'Log in'}</button
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
        onclick={() => onlogout(provider.providerId)}>Log out {provider.name}</button
      >{/if}
  </div>
{/each}
<p>
  Log out removes this gateway's saved credentials and prevents new requests. It does not revoke
  your account upstream or recall content already sent.
</p>

{#if login}
  <div class="backend-card login-card" role="region" aria-label="Provider login" aria-live="polite">
    <strong>Login: {login.status}</strong>
    {#if login.status === 'pending'}
      <p>
        Expires at {new Date(login.expiresAt).toLocaleTimeString()}. Closing settings cancels this
        login.
      </p>
      {#if login.auth}
        {@const url = authUrl(login.auth.url)}
        {#if url}<a
            class="button ghost"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer">Open authorization page</a
          >{:else}<p role="alert">The provider returned an unsupported authorization URL.</p>{/if}
        {#if login.auth.instructions}<p class="instructions">
            {login.auth.instructions}
          </p>{/if}
      {/if}
      {#if login.progress}<p>{login.progress}</p>{/if}
      {#each login.prompts as prompt (prompt.id)}
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
                onclick={() => answerPrompt(prompt, true)}>Skip selection</button
              >{/if}
          </div>
        </form>
      {/each}
      <button class="button ghost" type="button" onclick={() => cancelLogin()}>Cancel login</button>
    {:else if login.status === 'succeeded'}<p>
        Login complete. The model catalog has been refreshed.
      </p>
    {:else if login.status === 'failed'}<p role="alert">
        Login failed. Please start a new login and try again.
      </p>
    {:else if login.status === 'expired'}<p>Login expired. Please start a new login.</p>{/if}
  </div>
{/if}

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
  .backend-error {
    color: var(--danger, #d54444);
  }
</style>
