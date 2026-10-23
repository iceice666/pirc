<script lang="ts" module>
  import type { MessageKey } from '../../i18n/messages';

  const SETTINGS_TABS = [
    { id: 'models', label: 'settings.tab.models' },
    { id: 'devices', label: 'settings.tab.devices' },
    { id: 'notifications', label: 'settings.tab.notifications' },
    { id: 'about', label: 'settings.tab.about' },
  ] as const satisfies readonly { id: string; label: MessageKey }[];
  export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
</script>

<script lang="ts">
  /**
   * Settings, the same on the rooms and in the engine (plans/rewrite/11-web.md):
   * the model backends and the sources, the paired devices, notifications
   * (and the rooms muted here), and this browser. What pirc keeps (memory,
   * loops, wakes) is on the engine's front page; preferences on the host's.
   */
  import { Languages, X } from '@lucide/svelte';
  import { rovingFocus } from '../../a11y';
  import { LOCALES, locale, setLocale, t, type Locale } from '../../i18n';
  import { mutedRooms, setMuted } from '../../mute';
  import { engineLink } from '../../routes';
  import { getClientId } from '../../storage';
  import Modal from './Modal.svelte';
  import BackendSettings from '../BackendSettings.svelte';
  import NotificationSettings from '../NotificationSettings.svelte';
  import PairedDevices from '../PairedDevices.svelte';
  import SourceSettings from '../SourceSettings.svelte';

  interface Props {
    open: boolean;
    /** The category shown; the opener may pick one. */
    tab?: SettingsTab;
    /** Demo mode: nothing to ask the gateway. */
    disabled?: boolean;
    /** Room names by id, for the muted rooms. */
    roomNames?: Record<string, string>;
    /** The model backends changed (the engine reloads its model list). */
    onmodelschanged?: () => void;
    /** The engine's layout (its sidebar) back to its defaults. */
    onresetlayout?: () => void;
  }

  let {
    open = $bindable(),
    tab: settingsTab = $bindable('models'),
    disabled = false,
    roomNames = {},
    onmodelschanged,
    onresetlayout,
  }: Props = $props();

  let muted = $state<string[]>([]);
  $effect(() => {
    if (open) muted = mutedRooms();
  });
  const clientId = getClientId();
</script>

<Modal bind:open labelledby="settings-title" class="settings">
  <header>
    <div>
      <span class="eyebrow">pirc</span>
      <h2 id="settings-title">{t('settings.title')}</h2>
    </div>
    <label class="language">
      <Languages size={15} aria-hidden="true" />
      <span class="sr-only">{t('settings.language')}</span>
      <select
        aria-label={t('settings.language')}
        value={locale()}
        onchange={(event) => setLocale(event.currentTarget.value as Locale)}
      >
        {#each LOCALES as choice (choice.id)}
          <option value={choice.id}>{choice.label}</option>
        {/each}
      </select>
    </label>
    <button
      class="icon-button"
      type="button"
      aria-label={t('common.close')}
      onclick={() => (open = false)}><X size={19} /></button
    >
  </header>

  <div class="settings-layout">
    <div
      class="settings-nav"
      role="tablist"
      aria-label={t('settings.categories')}
      aria-orientation="vertical"
      use:rovingFocus={{ selector: '[role="tab"]', orientation: 'vertical', activate: true }}
    >
      {#each SETTINGS_TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          id="settings-tab-{tab.id}"
          aria-controls="settings-panel-{tab.id}"
          aria-selected={settingsTab === tab.id}
          tabindex={settingsTab === tab.id ? 0 : -1}
          class:chosen={settingsTab === tab.id}
          onclick={() => (settingsTab = tab.id)}>{t(tab.label)}</button
        >
      {/each}
    </div>

    <div class="settings-panels">
      <!-- Panels stay mounted so switching tabs never cancels an in-flight provider login. -->
      <div
        role="tabpanel"
        id="settings-panel-models"
        aria-labelledby="settings-tab-models"
        hidden={settingsTab !== 'models'}
      >
        <BackendSettings {disabled} onchanged={() => onmodelschanged?.()} />
        <!-- The same page and grant as the backends (decision #6). -->
        <SourceSettings {disabled} />
      </div>

      <div
        role="tabpanel"
        id="settings-panel-devices"
        aria-labelledby="settings-tab-devices"
        hidden={settingsTab !== 'devices'}
      >
        <PairedDevices {disabled} />
        <section class="settings-section">
          <h3>{t('settings.devices.nodes.title')}</h3>
          <p>
            {t('settings.devices.nodes.about')}
            <a href={engineLink('nodes')}>{t('settings.devices.nodes.aboutLink')}</a>{t(
              'settings.devices.nodes.aboutEnd',
            )}
          </p>
        </section>
      </div>

      <div
        role="tabpanel"
        id="settings-panel-notifications"
        aria-labelledby="settings-tab-notifications"
        hidden={settingsTab !== 'notifications'}
      >
        <NotificationSettings {disabled} />
        <section class="settings-section">
          <h3>{t('settings.muted.title')}</h3>
          {#if muted.length}
            <ul class="muted-rooms">
              {#each muted as roomId (roomId)}
                <li>
                  <span>#{roomNames[roomId] ?? roomId}</span>
                  <button
                    type="button"
                    class="button ghost small"
                    onclick={() => (muted = setMuted(roomId, false))}
                    >{t('settings.muted.unmute')}</button
                  >
                </li>
              {/each}
            </ul>
          {:else}
            <p>{t('settings.muted.none')}</p>
          {/if}
        </section>
      </div>

      <div
        role="tabpanel"
        id="settings-panel-about"
        aria-labelledby="settings-tab-about"
        hidden={settingsTab !== 'about'}
      >
        <section class="settings-section">
          <h3>{t('settings.about.browser')}</h3>
          <div class="settings-row">
            <span>{t('settings.language')}</span>
            <span>{LOCALES.find((choice) => choice.id === locale())?.label}</span>
          </div>
          <div class="settings-row">
            <span>{t('settings.about.clientId')}</span>
            <code>{clientId}</code>
          </div>
        </section>
        {#if onresetlayout}
          <section class="settings-section">
            <h3>{t('settings.about.layout')}</h3>
            <div class="settings-row">
              <span>{t('settings.about.layoutHint')}</span>
              <button class="button ghost" type="button" onclick={onresetlayout}
                >{t('settings.about.reset')}</button
              >
            </div>
          </section>
        {/if}
      </div>
    </div>
  </div>
</Modal>

<style>
  .language {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    color: var(--muted);
  }
  .language select {
    height: 28px;
    padding: 0 4px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 13px;
  }
  .language select:hover {
    background: var(--bg-hover);
  }
  /* Sections include BackendSettings' own, hence :global. */
  .settings-panels :global(.settings-section + .settings-section) {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
  .settings-panels :global(.settings-section h3) {
    margin: 0 0 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .settings-panels :global(.settings-section p) {
    margin: 8px 0 0;
  }

  .settings-layout {
    display: grid;
    flex: 1;
    grid-template-columns: 148px minmax(0, 1fr);
    gap: 20px;
    min-height: 0;
  }
  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .settings-nav button {
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 13px;
    text-align: left;
  }
  .settings-nav button:hover {
    background: var(--bg-hover);
  }
  .settings-nav button.chosen {
    color: var(--ink);
    background: var(--bg-subtle);
    font-weight: 600;
  }
  .settings-panels {
    min-width: 0;
    overflow-y: auto;
  }
  .settings-panels [hidden] {
    display: none;
  }
  @media (max-width: 640px) {
    .settings-layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      gap: 12px;
    }
    /* Wrap rather than scroll: a scrolled-off tab (About) has no visible cue. */
    .settings-nav {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .settings-nav button {
      flex: none;
    }
  }
  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .muted-rooms {
    display: grid;
    gap: 2px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .muted-rooms li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 34px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
    font-size: 13px;
  }
  .settings-row code {
    overflow: hidden;
    max-width: 60%;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
    user-select: all;
  }
</style>
