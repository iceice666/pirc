<script lang="ts">
  import { Settings, SquareTerminal } from '@lucide/svelte';
  import { engine } from '../engine.svelte';

  type Tab = 'work' | 'settings';

  interface Props {
    current: Tab;
    onpick: (tab: Tab) => void;
  }

  let { current, onpick }: Props = $props();
  const waiting = $derived(engine.inbox.length);
</script>

<!-- The phone's bottom navigation (desktop has the sidebar's footer instead). -->
<nav class="mobile-tabs" aria-label="Sections">
  <button
    type="button"
    aria-current={current === 'work' ? 'page' : undefined}
    class:chosen={current === 'work'}
    onclick={() => onpick('work')}
    ><span class="icon-wrap"
      ><SquareTerminal size={20} />{#if waiting}<span
          class="tab-badge"
          aria-label="{waiting} waiting for you">{waiting}</span
        >{/if}</span
    ><span>Work</span></button
  >
  <button
    type="button"
    aria-current={current === 'settings' ? 'page' : undefined}
    class:chosen={current === 'settings'}
    onclick={() => onpick('settings')}><Settings size={20} /><span>Settings</span></button
  >
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
    .mobile-tabs button {
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
    }
    .mobile-tabs button.chosen {
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
