<script lang="ts">
  /**
   * The engine's front page (plans/rewrite/11-web.md, design screen 5): what
   * runs behind the rooms, as one scrolling dashboard. The Overview section
   * stacks the Hands cards, the newest brain turns across every room and the
   * open loops, wakes and sources cards; the six sections below it hold the
   * full lists and the editors, and the tab strip links to each of them by
   * anchor (`#nodes`, `#brain`, …) as well as by `?open=`.
   */
  import { onMount } from 'svelte';
  import { t } from '../../i18n';
  import { OVERVIEW_SECTIONS, type OverviewSection } from '../../routes';
  import { roomsApi } from '../../rooms';
  import type { NodeSummary } from '../../types';
  import LoopsSettings from '../LoopsSettings.svelte';
  import MemorySettings from '../MemorySettings.svelte';
  import WakesSettings from '../WakesSettings.svelte';
  import BrainTurns from './BrainTurns.svelte';
  import HandsCards from './HandsCards.svelte';
  import LoopCard from './LoopCard.svelte';
  import NodeCards from './NodeCards.svelte';
  import RecentTurns from './RecentTurns.svelte';
  import SourceCard from './SourceCard.svelte';
  import SourcesStatus from './SourcesStatus.svelte';
  import WakeCard from './WakeCard.svelte';

  interface Props {
    section: OverviewSection;
    onsection: (section: OverviewSection) => void;
    nodes: NodeSummary[];
    /** Bumped when the gateway says memory changed. */
    memoryRevision?: number;
    /** Demo mode: nothing to ask the gateway. */
    disabled?: boolean;
    /** Open Settings on Models & sources (the sources card's link). */
    onsettings?: () => void;
  }

  let {
    section,
    onsection,
    nodes,
    memoryRevision = 0,
    disabled = false,
    onsettings = () => {},
  }: Props = $props();

  /** Room names by id, for the lists that name rooms. */
  let roomNames = $state<Record<string, string>>({});
  let roomIds = $state<string[]>([]);
  /** Bumped when a card changed a loop or a wake, so the section below reloads. */
  let revision = $state(0);
  let scroller: HTMLElement | undefined = $state();

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

  /** The tab strip and every "All …" link land on a section of this page. */
  function follow(event: MouseEvent, id: OverviewSection) {
    event.preventDefault();
    onsection(id);
    scrollTo(id);
  }

  function scrollTo(id: OverviewSection) {
    if (id === 'overview') {
      scroller?.scrollTo?.({ top: 0 });
      return;
    }
    // A browser scrolls the column; a test environment has no scrolling.
    document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
  }

  // A deep link (`?open=loops` from a face page or a notification) opens here.
  $effect(() => {
    scrollTo(section);
  });
</script>

<div class="overview" bind:this={scroller}>
  <div class="column">
    <header id="overview" class="page-head">
      <h1>{t('engine.title')}</h1>
      <p class="muted">{t('engine.tagline')}</p>
    </header>
    <nav class="anchors" aria-label={t('engine.sections')}>
      {#each OVERVIEW_SECTIONS as item (item.id)}
        <a
          href="#{item.id}"
          class:chosen={section === item.id}
          aria-current={section === item.id ? 'location' : undefined}
          onclick={(event) => follow(event, item.id)}>{t(item.key)}</a
        >
      {/each}
    </nav>

    <!-- The dashboard: each section at a glance. -->
    <HandsCards {nodes} onall={(event) => follow(event, 'nodes')} />
    <RecentTurns {roomNames} {roomIds} {disabled} onall={(event) => follow(event, 'brain')} />
    <div class="cards">
      <LoopCard {roomNames} {disabled} {revision} onall={(event) => follow(event, 'loops')} />
      <WakeCard {roomNames} {disabled} {revision} onchanged={() => revision++} />
      <SourceCard {roomNames} {disabled} {onsettings} />
    </div>

    <!-- The sections the anchors and the cards' links open. -->
    <section id="nodes" class="section" aria-label={t('engine.section.nodes')}>
      <NodeCards {nodes} />
    </section>
    <section id="brain" class="section" aria-label={t('engine.section.brain')}>
      <BrainTurns {roomNames} {roomIds} {disabled} />
    </section>
    <section id="loops" class="section" aria-label={t('engine.section.loops')}>
      <LoopsSettings {disabled} {revision} onchanged={() => revision++} />
    </section>
    <section id="wakes" class="section" aria-label={t('engine.section.wakes')}>
      <WakesSettings {disabled} {roomNames} {revision} onchanged={() => revision++} />
    </section>
    <section id="memory" class="section" aria-label={t('engine.section.memory')}>
      <MemorySettings {disabled} revision={memoryRevision} />
    </section>
    <section id="sources" class="section" aria-label={t('engine.section.sources')}>
      <SourcesStatus {roomNames} {disabled} />
    </section>
  </div>
</div>

<style>
  .overview {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg-room);
    scroll-behavior: smooth;
  }
  .column {
    width: 100%;
    max-width: 1040px;
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px clamp(16px, 3vw, 32px) 40px;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    scroll-margin-top: 8px;
  }
  .page-head h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }
  .page-head p {
    margin: 0;
    font-size: 14px;
  }
  .muted {
    color: var(--muted);
  }
  /* The design's anchors: the same strip the tabs were, as links to sections. */
  .anchors {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: -8px;
    border-bottom: 1px solid var(--line);
  }
  .anchors a {
    margin-bottom: -1px;
    padding: 8px 12px;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    font-size: 14px;
    text-decoration: none;
  }
  .anchors a:hover {
    color: var(--ink);
  }
  .anchors a.chosen {
    border-bottom-color: var(--accent);
    color: var(--ink);
    font-weight: 600;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
    gap: 12px;
    align-items: stretch;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 4px;
    scroll-margin-top: 8px;
  }
  .section:not(:first-of-type) {
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
  .section :global(h3) {
    margin: 0 0 4px;
    color: var(--ink);
    font-size: 16px;
    font-weight: 600;
  }
</style>
