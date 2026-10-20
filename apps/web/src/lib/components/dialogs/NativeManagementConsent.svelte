<script lang="ts">
  import { tr } from '../../i18n.svelte';

  import { CircleAlert, Clock3, RefreshCw, ShieldCheck, ShieldOff, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';
  import {
    nativeManagementApi,
    timestampMillis,
    type NativeManagementRequest,
  } from '../../native-management';

  interface Props {
    requestId: string;
  }

  let { requestId }: Props = $props();
  let open = $state(true);
  let snapshot: NativeManagementRequest | undefined = $state();
  let loading = $state(true);
  let checking = $state(false);
  let busy = $state(false);
  let error = $state('');
  let clockNow = $state(Date.now());
  let serverOffset = 0;
  let alive = true;
  const POLL_MS = 5_000;
  const ACTIVE_STATUSES = new Set(['pending', 'approved', 'claimed']);

  const expiresAt = $derived(snapshot ? timestampMillis(snapshot.expiresAt) : Number.NaN);
  const remainingSeconds = $derived(Math.max(0, Math.ceil((expiresAt - clockNow) / 1000)));
  const expiredLocally = $derived(Number.isFinite(expiresAt) && remainingSeconds === 0);
  const canApprove = $derived(
    snapshot?.status === 'pending' && snapshot.capabilities.length > 0 && !expiredLocally,
  );

  function remainingLabel(): string {
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return minutes ? tr('{0}m {1}s', [minutes, seconds]) : `${seconds}s`;
  }

  async function fetchStatus(): Promise<void> {
    const next = await nativeManagementApi.get(requestId);
    if (!alive) return;
    snapshot = next;
    serverOffset = timestampMillis(next.serverNow) - Date.now();
    clockNow = Date.now() + serverOffset;
  }

  async function refresh(): Promise<void> {
    if (checking || busy) return;
    checking = true;
    error = '';
    try {
      await fetchStatus();
    } catch {
      if (alive) error = tr('Unable to check this request. Check your connection and try again.');
    } finally {
      checking = false;
      loading = false;
    }
  }

  async function update(action: 'approve' | 'deny' | 'revoke'): Promise<void> {
    if (!snapshot || busy || loading) return;
    busy = true;
    error = '';
    try {
      if (action === 'approve') await nativeManagementApi.approve(requestId);
      else if (action === 'deny') await nativeManagementApi.deny(requestId);
      else await nativeManagementApi.revoke(requestId);
    } catch {
      if (alive) error = tr('Could not update this request. Check its status, then try again.');
      try {
        await fetchStatus();
      } catch {
        // Keep the safe action error visible; Retry below performs another status check.
      }
      busy = false;
      return;
    }

    try {
      await fetchStatus();
    } catch {
      if (alive)
        error = tr(
          'The change was sent, but its status could not be confirmed. Retry the status check.',
        );
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    alive = true;
    void refresh();
    const poll = setInterval(() => {
      clockNow = Date.now() + serverOffset;
      if (
        document.visibilityState === 'visible' &&
        snapshot &&
        ACTIVE_STATUSES.has(snapshot.status)
      )
        void refresh();
    }, POLL_MS);
    const clock = setInterval(() => (clockNow = Date.now() + serverOffset), 1_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  });
</script>

<Modal bind:open labelledby="native-management-title" class="native-management-dialog">
  <header>
    <div>
      <span class="eyebrow">{tr('Temporary access')}</span>
      <h2 id="native-management-title">{tr('Review management request')}</h2>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label={tr('Close')}
      onclick={() => (open = false)}><X size={19} /></button
    >
  </header>

  {#if loading && !snapshot}
    <p class="state-line" role="status">
      <RefreshCw class="spin" size={16} />
      {tr('Checking this request…')}
    </p>
  {:else if !snapshot}
    <div class="request-error" role="alert">
      <CircleAlert size={17} />
      <p>{error || tr('Unable to check this request. Check your connection and try again.')}</p>
    </div>
    <footer>
      <button class="button primary" type="button" disabled={checking} onclick={() => refresh()}>
        {#if checking}<RefreshCw class="spin" size={15} />{/if}{tr('Retry')}
      </button>
    </footer>
  {:else}
    <p class="requesting">
      <strong>{snapshot.deviceName}</strong>
      {tr('is requesting management access.')}
    </p>

    <section class="permissions" aria-labelledby="native-management-permissions">
      <h3 id="native-management-permissions">{tr('Requested permissions')}</h3>
      {#if snapshot.capabilities.includes('providers')}
        <div class="permission-row">
          <span class="permission-icon"><ShieldCheck size={17} /></span>
          <p>
            {tr(
              'Manage model providers, including adding, editing, and removing providers, and signing in or out of subscription accounts. This can change saved provider credentials.',
            )}
          </p>
        </div>
      {/if}
      {#if snapshot.capabilities.includes('devices')}
        <div class="permission-row">
          <span class="permission-icon"><ShieldOff size={17} /></span>
          <p>{tr('View, pair, and revoke connected devices.')}</p>
        </div>
      {/if}
      {#if snapshot.capabilities.length === 0}
        <p class="missing-permissions">
          {tr('No supported permissions were listed. This request cannot be approved.')}
        </p>
      {/if}
    </section>

    {#if snapshot.status === 'pending'}
      <p class="expiry">
        <Clock3 size={15} />
        {tr('This request expires in')} <strong>{remainingLabel()}</strong>. If approved, access
        lasts up to 15 minutes after the device claims it.
      </p>
      {#if expiredLocally}<p class="status-note" role="status">
          {tr('The request may have expired. Checking for an updated status…')}
        </p>{/if}
    {:else if snapshot.status === 'approved'}
      <p class="status-note" role="status">
        <ShieldCheck size={16} />
        {tr('Approved. The device can claim temporary access. This approval expires in')}
        <strong>{remainingLabel()}</strong>.
      </p>
    {:else if snapshot.status === 'claimed'}
      <p class="status-note active" role="status">
        <ShieldCheck size={16} />
        {tr('{0} has claimed temporary access. It expires in', [snapshot.deviceName])}
        <strong>{remainingLabel()}</strong>.
      </p>
    {:else if snapshot.status === 'denied'}
      <p class="status-note" role="status">{tr('This request was denied.')}</p>
    {:else if snapshot.status === 'revoked'}
      <p class="status-note" role="status">{tr('Temporary access was revoked.')}</p>
    {:else}
      <p class="status-note" role="status">{tr('This request or temporary access has expired.')}</p>
    {/if}

    {#if error}
      <div class="request-error" role="alert">
        <CircleAlert size={17} />
        <p>{error}</p>
        <button
          class="button ghost retry"
          type="button"
          disabled={checking || busy}
          onclick={() => refresh()}
        >
          {#if checking}<RefreshCw class="spin" size={14} />{/if}{tr('Retry status check')}
        </button>
      </div>
    {/if}

    <footer>
      {#if snapshot.status === 'pending'}
        <button
          class="button ghost"
          type="button"
          disabled={busy || loading || expiredLocally}
          onclick={() => update('deny')}>{busy ? tr('Updating…') : tr('Deny')}</button
        >
        <button
          class="button primary"
          type="button"
          disabled={busy || loading || !canApprove}
          onclick={() => update('approve')}
          >{busy ? tr('Updating…') : tr('Approve for 15 minutes')}</button
        >
      {:else if snapshot.status === 'approved' || snapshot.status === 'claimed'}
        <button
          class="button revoke"
          type="button"
          disabled={busy || loading || expiredLocally}
          onclick={() => update('revoke')}>{busy ? tr('Updating…') : tr('Revoke access')}</button
        >
      {/if}
    </footer>
  {/if}
</Modal>

<style>
  :global(.modal-dialog.native-management-dialog header) {
    margin-bottom: 12px;
  }
  .eyebrow {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  h2 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 600;
  }
  .requesting {
    margin: 12px 0 18px;
    color: var(--text-2);
    font-size: 14px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .requesting strong {
    color: var(--ink);
  }
  .permissions {
    padding: 14px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
  }
  .permissions h3 {
    margin: 0 0 10px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .permission-row {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 9px;
    align-items: start;
  }
  .permission-row + .permission-row {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line-dark);
  }
  .permission-icon {
    display: inline-flex;
    margin-top: 2px;
    color: var(--text-2);
  }
  .permission-row p,
  .missing-permissions {
    margin: 0;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.5;
  }
  .missing-permissions {
    color: var(--danger);
  }
  .expiry,
  .status-note,
  .state-line {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin: 14px 0 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.5;
  }
  .expiry strong,
  .status-note strong {
    color: var(--ink);
  }
  .status-note.active {
    color: var(--success);
  }
  .state-line {
    align-items: center;
  }
  .request-error {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    margin-top: 14px;
    color: var(--danger);
  }
  .request-error p {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
    line-height: 1.5;
  }
  .request-error .retry {
    grid-column: 2;
    justify-self: start;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
  .button.revoke {
    color: white;
    background: var(--danger);
  }
  .button.revoke:hover:not(:disabled) {
    filter: brightness(0.92);
  }

  @media (max-width: 480px) {
    :global(.modal.native-management-dialog) {
      padding: 20px;
    }
    footer > .button {
      flex: 1;
    }
  }
</style>
