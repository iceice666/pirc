<script lang="ts">
  /**
   * Phones paired through device tokens. Pairing shows the token once, as a
   * QR code, an app link and copyable text; it cannot be shown again.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { deviceApi, pairingUri, qrPath, type PairedDevice } from '../devices';
  import { ago } from '../time';

  interface Props {
    disabled?: boolean;
  }

  let { disabled = false }: Props = $props();

  let devices: PairedDevice[] = $state([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let name = $state('');
  /** The freshly paired device and its one-time token. */
  let paired: { device: PairedDevice; uri: string; token: string } | undefined = $state();
  let copied = $state(false);
  let alive = true;

  let qr = $derived(paired ? qrPath(paired.uri) : undefined);

  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';
  const until = (time: number) =>
    new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  async function refresh() {
    try {
      const listed = await deviceApi.list();
      if (alive) devices = listed;
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  onMount(() => {
    if (disabled) loading = false;
    else void refresh();
    return () => {
      alive = false;
    };
  });

  async function pair(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    busy = true;
    error = '';
    copied = false;
    try {
      const result = await deviceApi.pair(name.trim());
      if (!alive) return;
      paired = { ...result, uri: pairingUri(location.origin, result.token) };
      name = '';
      await refresh();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = false;
    }
  }

  async function revoke(device: PairedDevice) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await deviceApi.revoke(device.id);
      if (paired?.device.id === device.id) paired = undefined;
      await refresh();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (!paired) return;
    await navigator.clipboard?.writeText(paired.uri);
    copied = true;
  }
</script>

<section class="settings-section" aria-labelledby="phones-title">
  <h3 id="phones-title">Phones</h3>
  <p>
    Pair the pirc Android app. A phone gets the same access as this browser, including files and
    shells on your nodes, but cannot manage devices or model backends. Its token stops working after
    a stretch without use, at a fixed age after pairing, or when revoked here.
  </p>

  {#if disabled}
    <p role="status">Pairing is unavailable in demo mode.</p>
  {:else}
    {#if error}<p class="device-error" role="alert">{error}</p>{/if}

    {#if paired && qr}
      <div class="pairing" role="group" aria-label="Pair {paired.device.name}">
        <svg
          class="qr"
          viewBox="0 0 {qr.size} {qr.size}"
          role="img"
          aria-label="Pairing QR code"
          shape-rendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <div class="pairing-text">
          <strong>Scan with the pirc app</strong>
          <small
            >Shown only once. Anyone with this code can use your nodes until you revoke it.</small
          >
          <code>{paired.uri}</code>
          <div class="device-actions">
            <a class="button ghost" href={paired.uri}>Open in app</a>
            <button class="button ghost" type="button" onclick={copy}
              >{copied ? 'Copied' : 'Copy link'}</button
            >
            <button class="button ghost" type="button" onclick={() => (paired = undefined)}
              >Done</button
            >
          </div>
        </div>
      </div>
    {/if}

    <form class="pair-form" onsubmit={pair}>
      <label>
        <span>Device name</span>
        <input bind:value={name} maxlength="100" placeholder="Pixel 9" disabled={busy} />
      </label>
      <button class="button ghost" type="submit" disabled={busy || !name.trim()}>Pair device</button
      >
    </form>

    {#if loading}
      <p role="status">Loading devices…</p>
    {:else if devices.length}
      <ul class="device-list">
        {#each devices as device (device.id)}
          <li>
            <div>
              <strong>{device.name}</strong>
              <small>Used {ago(device.lastUsedAt)} · Expires {until(device.expiresAt)}</small>
            </div>
            <button
              class="button ghost"
              type="button"
              disabled={busy}
              aria-label="Revoke {device.name}"
              onclick={() => revoke(device)}>Revoke</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p>No phones paired.</p>
    {/if}
  {/if}
</section>

<style>
  .device-error {
    color: var(--danger, #d54444);
  }
  .pairing {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin: 12px 0;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .qr {
    width: 200px;
    height: 200px;
    flex: none;
    border-radius: var(--radius-sm);
  }
  .pairing-text {
    display: flex;
    flex: 1 1 220px;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .pairing-text code {
    overflow-wrap: anywhere;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 11px;
    user-select: all;
  }
  strong {
    font-size: 13px;
  }
  small {
    display: block;
    color: var(--muted);
    font-size: 12px;
  }
  .device-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }
  .pair-form {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .pair-form label {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .device-list {
    display: grid;
    gap: 6px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }
  .device-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .device-list li > div {
    min-width: 0;
  }
</style>
