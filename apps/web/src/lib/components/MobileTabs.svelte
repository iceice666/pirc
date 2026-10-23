<script lang="ts" module>
  import { House, Settings, SquareTerminal, Users } from '@lucide/svelte';
  import type { MessageKey } from '../i18n/messages';

  export type MobileTabId = 'rooms' | 'members' | 'engine' | 'settings';

  export interface MobileTab {
    id: MobileTabId;
    /** A tab of another page is a link to it. */
    href?: string;
    /** Things waiting for you there. */
    badge?: number;
  }

  const LABELS: Record<MobileTabId, MessageKey> = {
    rooms: 'common.tab.rooms',
    members: 'common.tab.members',
    engine: 'common.tab.engine',
    settings: 'common.tab.settings',
  };
  const ICONS = { rooms: House, members: Users, engine: SquareTerminal, settings: Settings };
</script>

<script lang="ts">
  import { t } from '../i18n';

  interface Props {
    tabs: MobileTab[];
    current: MobileTabId;
    onpick: (tab: MobileTabId) => void;
  }

  let { tabs, current, onpick }: Props = $props();
</script>

<!-- The phone's bottom navigation (desktop has the room list's footer instead). -->
<nav class="mobile-tabs" aria-label={t('common.sections')}>
  {#each tabs as tab (tab.id)}
    {@const Icon = ICONS[tab.id]}
    {#snippet inner()}
      <span class="icon-wrap"
        ><Icon size={20} />{#if tab.badge}<span
            class="tab-badge"
            aria-label={t('common.waitingCount', { count: tab.badge })}>{tab.badge}</span
          >{/if}</span
      ><span>{t(LABELS[tab.id])}</span>
    {/snippet}
    {#if tab.href}
      <a class="tab" href={tab.href}>{@render inner()}</a>
    {:else}
      <button
        type="button"
        class="tab"
        aria-current={current === tab.id ? 'page' : undefined}
        class:chosen={current === tab.id}
        onclick={() => onpick(tab.id)}>{@render inner()}</button
      >
    {/if}
  {/each}
</nav>

<style>
  .mobile-tabs {
    display: none;
  }
  @media (max-width: 650px) {
    .mobile-tabs {
      position: fixed;
      z-index: 31;
      right: 0;
      bottom: 0;
      left: 0;
      height: calc(56px + env(safe-area-inset-bottom));
      display: flex;
      padding-bottom: env(safe-area-inset-bottom);
      border-top: 1px solid var(--line);
      background: var(--bg);
    }
    .mobile-tabs .tab {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 0;
      border: 0;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
      text-decoration: none;
    }
    .mobile-tabs .tab.chosen {
      color: var(--ink);
      font-weight: 500;
    }
    .icon-wrap {
      position: relative;
      display: grid;
    }
    .tab-badge {
      position: absolute;
      top: -5px;
      right: -9px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 999px;
      color: #fff;
      background: var(--warning);
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
      text-align: center;
    }
  }
</style>
