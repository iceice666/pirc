<script lang="ts">
  import { X } from '@lucide/svelte';
  import { rovingFocus } from '../../a11y';
  import { app } from '../../app.svelte';
  import Modal from './Modal.svelte';
  import BackendSettings from '../BackendSettings.svelte';

  interface Props {
    open: boolean;
    /** Sidebar shows settled sessions. */
    showSettled: boolean;
    onresetlayout: () => void;
  }

  let { open = $bindable(), showSettled = $bindable(), onresetlayout }: Props = $props();

  const SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    { id: 'models', label: 'Models' },
    { id: 'devices', label: 'Devices' },
    { id: 'about', label: 'About' },
  ] as const;
  let settingsTab: (typeof SETTINGS_TABS)[number]['id'] = $state('general');
</script>

<Modal bind:open labelledby="settings-title" class="settings">
  <header>
    <div>
      <span class="eyebrow">pirc</span>
      <h2 id="settings-title">Settings</h2>
    </div>
    <button class="icon-button" type="button" aria-label="Close" onclick={() => (open = false)}
      ><X size={19} /></button
    >
  </header>

  <div class="settings-layout">
    <div
      class="settings-nav"
      role="tablist"
      aria-label="Settings categories"
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
          onclick={() => (settingsTab = tab.id)}>{tab.label}</button
        >
      {/each}
    </div>

    <div class="settings-panels">
      <!-- Panels stay mounted so switching tabs never cancels an in-flight provider login. -->
      <div
        role="tabpanel"
        id="settings-panel-general"
        aria-labelledby="settings-tab-general"
        hidden={settingsTab !== 'general'}
      >
        <section class="settings-section">
          <h3>Sidebar</h3>
          <label class="settings-toggle">
            <span>Show settled sessions</span>
            <input type="checkbox" bind:checked={showSettled} />
          </label>
          <p>Settled sessions are hidden from the sidebar unless this is on.</p>
        </section>

        <section class="settings-section">
          <h3>Layout</h3>
          <div class="settings-row">
            <span>Restore the sidebar and side panel to their default size and visibility.</span>
            <button class="button ghost" type="button" onclick={onresetlayout}>Reset</button>
          </div>
        </section>
      </div>

      <div
        role="tabpanel"
        id="settings-panel-models"
        aria-labelledby="settings-tab-models"
        hidden={settingsTab !== 'models'}
      >
        <BackendSettings disabled={app.usingDemo} onchanged={() => app.loadModels()} />
      </div>

      <div
        role="tabpanel"
        id="settings-panel-devices"
        aria-labelledby="settings-tab-devices"
        hidden={settingsTab !== 'devices'}
      >
        <section class="settings-section">
          <h3>Devices</h3>
          {#if app.nodes.length}
            <ul class="settings-devices">
              {#each app.nodes as node (node.id)}
                <li>
                  <span class="online-dot"></span>
                  <strong>{node.id}</strong>
                  <small
                    >{node.workspaces.length} workspace{node.workspaces.length === 1
                      ? ''
                      : 's'}</small
                  >
                </li>
              {/each}
            </ul>
          {:else}
            <p>No devices online.</p>
          {/if}
          <p>{app.nodes.length} online</p>
        </section>
      </div>

      <div
        role="tabpanel"
        id="settings-panel-about"
        aria-labelledby="settings-tab-about"
        hidden={settingsTab !== 'about'}
      >
        <section class="settings-section">
          <h3>This browser</h3>
          <div class="settings-row">
            <span>Client ID</span>
            <code>{app.clientId}</code>
          </div>
        </section>
      </div>
    </div>
  </div>
</Modal>
