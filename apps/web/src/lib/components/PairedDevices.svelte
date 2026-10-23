<script lang="ts">
  /**
   * Phones paired through device tokens. Pairing shows the token once, as a
   * QR code, an app link and copyable text; it cannot be shown again.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { locale, t } from '../i18n';
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
    cause instanceof ApiError ? cause.message : t('settings.gateway.unreachable');
  const until = (time: number) =>
    new Date(time).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });

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
  <h3 id="phones-title">{t('settings.devices.title')}</h3>
  <p>{t('settings.devices.intro')}</p>

  {#if disabled}
    <p role="status">{t('settings.devices.demo')}</p>
  {:else}
    {#if error}<p class="device-error" role="alert">{error}</p>{/if}

    {#if paired && qr}
      <div
        class="pairing"
        role="group"
        aria-label={t('settings.devices.pairNamed', { name: paired.device.name })}
      >
        <svg
          class="qr"
          viewBox="0 0 {qr.size} {qr.size}"
          role="img"
          aria-label={t('settings.devices.qr')}
          shape-rendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <div class="pairing-text">
          <strong>{t('settings.devices.scan')}</strong>
          <small>{t('settings.devices.once')}</small>
          <code>{paired.uri}</code>
          <div class="device-actions">
            <a class="button ghost" href={paired.uri}>{t('settings.devices.openInApp')}</a>
            <button class="button ghost" type="button" onclick={copy}
              >{copied ? t('common.copied') : t('settings.copyLink')}</button
            >
            <button class="button ghost" type="button" onclick={() => (paired = undefined)}
              >{t('common.done')}</button
            >
          </div>
        </div>
      </div>
    {/if}

    <form class="pair-form" onsubmit={pair}>
      <label>
        <span>{t('settings.devices.nameLabel')}</span>
        <input
          bind:value={name}
          maxlength="100"
          placeholder={t('settings.devices.namePlaceholder')}
          disabled={busy}
        />
      </label>
      <button class="button ghost" type="submit" disabled={busy || !name.trim()}
        >{t('settings.devices.pair')}</button
      >
    </form>

    {#if loading}
      <p role="status">{t('settings.devices.loading')}</p>
    {:else if devices.length}
      <ul class="device-list">
        {#each devices as device (device.id)}
          <li>
            <div>
              <strong>{device.name}</strong>
              <small
                >{t('settings.devices.usedExpires', {
                  used: ago(device.lastUsedAt),
                  expires: until(device.expiresAt),
                })}</small
              >
            </div>
            <button
              class="button ghost"
              type="button"
              disabled={busy}
              aria-label={t('settings.devices.revokeNamed', { name: device.name })}
              onclick={() => revoke(device)}>{t('settings.devices.revoke')}</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p>{t('settings.devices.empty')}</p>
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
