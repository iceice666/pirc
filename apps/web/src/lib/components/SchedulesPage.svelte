<script lang="ts">
  import { CalendarClock, PanelLeftOpen } from '@lucide/svelte';
  import { app } from '../app.svelte';
  import ScheduleSettings from './ScheduleSettings.svelte';

  interface Props {
    /** Desktop: the sidebar is hidden, so the page offers the button to show it. */
    sidebarCollapsed?: boolean;
    onexpand?: () => void;
    onopenchat: (sessionId: string) => void;
  }

  let { sidebarCollapsed = false, onexpand, onopenchat }: Props = $props();
</script>

<section class="schedules-page" aria-labelledby="schedules-title">
  <header class="page-bar">
    {#if sidebarCollapsed}
      <button
        class="icon-button"
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar"
        onclick={onexpand}><PanelLeftOpen size={19} /></button
      >
    {/if}
    <CalendarClock size={18} />
    <h1 id="schedules-title">Schedules</h1>
  </header>
  <div class="page-scroll">
    <div class="page-body">
      <ScheduleSettings disabled={app.usingDemo} {onopenchat} />
    </div>
  </div>
</section>

<style>
  .schedules-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .page-bar {
    flex: 0 0 calc(56px + env(safe-area-inset-top));
    display: flex;
    align-items: center;
    gap: 10px;
    padding: env(safe-area-inset-top) 20px 0;
    color: var(--muted);
  }
  .page-bar h1 {
    margin: 0;
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
  }
  .page-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .page-body {
    width: min(780px, 100%);
    margin: 0 auto;
    padding: 8px 32px 48px;
  }
  /* The schedule form was written for a dialog: give it the same controls here. */
  .page-body :global(label) {
    display: grid;
    gap: 6px;
    margin: 12px 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
  }
  .page-body :global(input:not([type='checkbox']):not([type='radio'])),
  .page-body :global(select) {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-md);
    outline: 0;
    background: var(--bg-subtle);
    font-size: 14px;
  }
  .page-body :global(input:focus),
  .page-body :global(select:focus) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .page-body :global(.settings-section h3) {
    margin: 0 0 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .page-body :global(p) {
    color: var(--muted);
    font-size: 13px;
  }
  @media (max-width: 650px) {
    .page-bar {
      padding-left: 16px;
    }
    .page-body {
      padding: 4px 14px calc(72px + env(safe-area-inset-bottom));
    }
  }
</style>
