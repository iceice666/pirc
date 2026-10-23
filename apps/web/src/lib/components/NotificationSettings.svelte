<script lang="ts">
  /**
   * Push notifications: turn them on for this browser, see every place that
   * gets them (browsers and paired phones), remove one, and send a test.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import { t } from '../i18n';
  import {
    currentSubscriptionId,
    disablePush,
    enablePush,
    pushApi,
    pushState,
    type PushPlace,
    type PushState,
  } from '../push';
  import { ago } from '../time';

  interface Props {
    disabled?: boolean;
  }

  let { disabled = false }: Props = $props();

  let status: PushState | 'loading' = $state('loading');
  let places: PushPlace[] = $state([]);
  let hereId: string | undefined = $state();
  let busy = $state(false);
  let error = $state('');
  let note = $state('');
  let alive = true;

  const message = (cause: unknown) =>
    cause instanceof ApiError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : t('settings.gateway.unreachable');

  async function load() {
    try {
      const [next, info] = await Promise.all([pushState(), pushApi.info()]);
      if (!alive) return;
      status = next;
      places = info.subscriptions;
      hereId = next === 'on' ? currentSubscriptionId() : undefined;
    } catch (cause) {
      if (alive) {
        error = message(cause);
        if (status === 'loading') status = 'off';
      }
    }
  }

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    note = '';
    try {
      await run();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = false;
      if (alive) await load();
    }
  }

  onMount(() => {
    if (disabled) status = 'unsupported';
    else void load();
    return () => {
      alive = false;
    };
  });
</script>

<section class="settings-section" aria-labelledby="notifications-title">
  <h3 id="notifications-title">{t('settings.notifications.title')}</h3>
  <p>{t('settings.notifications.intro')}</p>

  {#if status === 'loading'}
    <p role="status">{t('settings.notifications.checking')}</p>
  {:else}
    {#if error}<p class="push-error" role="alert">{error}</p>{/if}
    {#if note}<p role="status">{note}</p>{/if}
    <div class="push-row">
      <span>
        {#if status === 'on'}
          {t('settings.notifications.on')}
        {:else if status === 'off'}
          {t('settings.notifications.off')}
        {:else if status === 'denied'}
          {t('settings.notifications.denied')}
        {:else}
          {t('settings.notifications.unsupported')}
        {/if}
      </span>
      {#if status === 'on'}
        <button
          class="button ghost small"
          type="button"
          disabled={busy}
          onclick={() => act(disablePush)}>{t('settings.notifications.turnOff')}</button
        >
      {:else if status === 'off'}
        <button
          class="button dark small"
          type="button"
          disabled={busy}
          onclick={() => act(enablePush)}>{t('settings.notifications.turnOn')}</button
        >
      {/if}
    </div>

    {#if places.length}
      <ul class="push-places" aria-label={t('settings.notifications.placesAria')}>
        {#each places as place (place.id)}
          <li>
            <span class="push-place">
              <strong
                >{place.name}{place.id === hereId
                  ? ` ${t('settings.notifications.thisBrowser')}`
                  : ''}</strong
              >
              <small
                >{place.kind === 'unifiedpush'
                  ? t('settings.notifications.phone')
                  : t('settings.notifications.browser')} · {place.host}{place.lastSuccessAt
                  ? ` · ${t('settings.notifications.lastDelivered', { ago: ago(place.lastSuccessAt) })}`
                  : ''}{place.failing ? ` · ${t('settings.notifications.failing')}` : ''}</small
              >
            </span>
            <button
              class="button ghost small"
              type="button"
              disabled={busy}
              onclick={() =>
                act(() => (place.id === hereId ? disablePush() : pushApi.remove({ id: place.id })))}
              >{t('common.remove')}</button
            >
          </li>
        {/each}
      </ul>
      <div class="push-row">
        <span>{t('settings.notifications.sendHint')}</span>
        <button
          class="button ghost small"
          type="button"
          disabled={busy}
          onclick={() =>
            act(async () => {
              const { delivered } = await pushApi.test();
              note = t('settings.notifications.sent', {
                delivered,
                places: places.length,
              });
            })}>{t('settings.notifications.sendTest')}</button
        >
      </div>
    {/if}
  {/if}
</section>

<style>
  .push-error {
    color: var(--danger);
  }
  .push-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .push-places {
    display: grid;
    gap: 4px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }
  .push-places li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .push-place {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 13px;
  }
  .push-place strong {
    font-weight: 500;
  }
  small {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
</style>
