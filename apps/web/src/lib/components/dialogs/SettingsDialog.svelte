<script lang="ts">
  import { X } from '@lucide/svelte';
  import { rovingFocus } from '../../a11y';
  import { app } from '../../app.svelte';
  import Modal from './Modal.svelte';
  import BackendSettings from '../BackendSettings.svelte';
  import PairedDevices from '../PairedDevices.svelte';

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
          <h3>Nodes</h3>
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
            <p>No nodes online.</p>
          {/if}
          <p>{app.nodes.length} online</p>
        </section>

        <PairedDevices disabled={app.usingDemo} />
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

<style>
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
    letter-spacing: 0.02em;
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
    .settings-nav {
      flex-direction: row;
      overflow-x: auto;
    }
    .settings-nav button {
      flex: none;
    }
  }
  :global(.modal) label.settings-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    color: var(--muted);
    font-weight: 400;
  }
  :global(.modal) .settings-toggle input {
    width: 16px;
    height: 16px;
    flex: none;
    padding: 0;
    accent-color: var(--accent);
  }
  .settings-devices {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .settings-devices li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .settings-devices strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .settings-devices small {
    color: var(--muted);
    font-size: 11px;
  }
  .online-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
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
