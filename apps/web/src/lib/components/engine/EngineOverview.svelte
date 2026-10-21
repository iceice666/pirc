<script lang="ts">
  /**
   * The engine's front page (plans/rewrite/11-web.md): what runs behind the
   * rooms. The nodes and what they can do, the brain's turns, the open loops,
   * the wakes, the memory and the sources, each a tab `?open=` can name.
   */
  import { onMount } from 'svelte';
  import { rovingFocus } from '../../a11y';
  import { OVERVIEW_SECTIONS, type OverviewSection } from '../../routes';
  import { roomsApi } from '../../rooms';
  import type { NodeSummary } from '../../types';
  import LoopsSettings from '../LoopsSettings.svelte';
  import MemorySettings from '../MemorySettings.svelte';
  import WakesSettings from '../WakesSettings.svelte';
  import BrainTurns from './BrainTurns.svelte';
  import NodeCards from './NodeCards.svelte';
  import SourcesStatus from './SourcesStatus.svelte';

  interface Props {
    section: OverviewSection;
    onsection: (section: OverviewSection) => void;
    nodes: NodeSummary[];
    /** Bumped when the gateway says memory changed. */
    memoryRevision?: number;
    /** Demo mode: nothing to ask the gateway. */
    disabled?: boolean;
  }

  let { section, onsection, nodes, memoryRevision = 0, disabled = false }: Props = $props();

  /** Room names by id, for lists that name rooms. */
  let roomNames = $state<Record<string, string>>({});
  let roomIds = $state<string[]>([]);
  onMount(() => {
    if (disabled) return;
    roomsApi
      .list(true)
      .then(({ rooms }) => {
        roomNames = Object.fromEntries(rooms.map((room) => [room.id, room.name]));
        roomIds = rooms.filter((room) => !room.archivedAt).map((room) => room.id);
      })
      .catch(() => {});
  });
</script>

<div class="overview">
  <header>
    <h1>Engine</h1>
    <p class="muted">What runs behind the rooms.</p>
  </header>
  <div
    class="tabs"
    role="tablist"
    aria-label="Engine sections"
    use:rovingFocus={{ selector: '[role="tab"]', activate: true }}
  >
    {#each OVERVIEW_SECTIONS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        id="overview-tab-{tab.id}"
        aria-controls="overview-panel"
        aria-selected={section === tab.id}
        tabindex={section === tab.id ? 0 : -1}
        class:chosen={section === tab.id}
        onclick={() => onsection(tab.id)}>{tab.label}</button
      >
    {/each}
  </div>
  <div
    class="panel"
    id="overview-panel"
    role="tabpanel"
    aria-labelledby="overview-tab-{section}"
    tabindex="-1"
  >
    {#if section === 'nodes'}
      <NodeCards {nodes} />
    {:else if section === 'brain'}
      <BrainTurns {roomNames} {roomIds} {disabled} />
    {:else if section === 'loops'}
      <LoopsSettings {disabled} />
    {:else if section === 'wakes'}
      <WakesSettings {disabled} {roomNames} />
    {:else if section === 'memory'}
      <MemorySettings {disabled} revision={memoryRevision} />
    {:else if section === 'sources'}
      <SourcesStatus {roomNames} {disabled} />
    {/if}
  </div>
</div>

<style>
  .overview {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px clamp(16px, 4vw, 40px) 40px;
  }
  header h1 {
    margin: 0;
    font-size: 22px;
  }
  header p {
    margin: 4px 0 16px;
  }
  .muted {
    color: var(--muted);
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    margin-bottom: -1px;
    padding: 8px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }
  .tabs button.chosen {
    border-bottom-color: var(--ink);
    color: var(--ink);
    font-weight: 500;
  }
  .panel {
    max-width: 880px;
  }
  .panel:focus {
    outline: none;
  }
</style>
