<script lang="ts">
  /**
   * A session's page: its panes (plan 12 decision 4, no conversation). A tab
   * strip over Files, Git, Memory, Context, Tasks, Terminal and Browser. A tab
   * mounts on first visit and then stays mounted (hidden) so its folder, open
   * file, diff and scroll position survive tab switches; each tab loads and
   * refreshes its own data while it is shown.
   */
  import {
    Brain,
    FolderTree,
    GitBranch,
    Globe,
    ListChecks,
    SquareTerminal,
    ScanText,
  } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { rovingFocus } from '../../a11y';
  import { engine } from '../../engine.svelte';
  import { onFilePreviewRequest, type FileTarget } from '../../file-links';
  import { t } from '../../i18n';
  import type { MessageKey } from '../../i18n/messages';
  import type { PanelTab } from '../../panel-api';
  import FilesTab from './FilesTab.svelte';
  import GitTab from './GitTab.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import ContextTab from './ContextTab.svelte';
  import TasksTab from './TasksTab.svelte';
  import TerminalTab from './TerminalTab.svelte';
  import BrowserTab from './BrowserTab.svelte';
  import './panel.css';

  interface Props {
    tab?: PanelTab;
  }

  let { tab = $bindable('files') }: Props = $props();

  let openRequest: (FileTarget & { seq: number }) | undefined = $state();
  let openSeq = 0;
  /** Tabs visited so far; they stay mounted. */
  const mounted = new SvelteSet<PanelTab>();

  /** Tab labels live here as message keys; the markup translates them. */
  const tabs: Array<{ id: PanelTab; label: MessageKey; icon: typeof FolderTree }> = [
    { id: 'files', label: 'panel.tab.files', icon: FolderTree },
    { id: 'git', label: 'panel.tab.git', icon: GitBranch },
    { id: 'memory', label: 'panel.tab.memory', icon: Brain },
    { id: 'context', label: 'panel.tab.context', icon: ScanText },
    { id: 'tasks', label: 'panel.tab.tasks', icon: ListChecks },
    { id: 'terminal', label: 'panel.tab.terminal', icon: SquareTerminal },
    { id: 'browser', label: 'panel.tab.browser', icon: Globe },
  ];

  const sessionId = $derived(engine.sessionState?.session.id ?? '');
  /**
   * Every session keeps Files (its directory, where uploads and outputs land);
   * Git needs a repository, the terminal a workspace directory (not one per session).
   */
  const mode = $derived(
    engine.modeOf(
      engine.workspaces.find(
        (workspace) => workspace.id === engine.sessionState?.session.workspaceId,
      ),
    ),
  );
  const shownTabs = $derived(
    mode
      ? tabs.filter(
          (item) =>
            (item.id !== 'git' || mode.repository) &&
            (item.id !== 'terminal' || mode.workdir === 'workspace'),
        )
      : tabs,
  );
  $effect.pre(() => {
    if (!shownTabs.some((item) => item.id === tab)) tab = 'files';
  });
  $effect.pre(() => {
    mounted.add(tab);
  });

  function openFile(target: string | FileTarget) {
    // A fresh sequence number so the same path can be reopened.
    openRequest = { ...(typeof target === 'string' ? { path: target } : target), seq: ++openSeq };
    tab = 'files';
  }
  // File links in previewed documents (and Git, Context) open here.
  onDestroy(onFilePreviewRequest(openFile));

  const badge = $derived({
    tasks: (engine.panel.value?.backgroundTasks ?? []).filter((task) => task.status === 'running')
      .length,
    memory: engine.panel.value?.memoryRuntime?.phase ? 1 : 0,
  } as Record<string, number>);
</script>

<section class="session-panes" aria-label={t('panel.session')}>
  <div
    class="panel-tabs"
    role="tablist"
    aria-label={t('panel.panes')}
    use:rovingFocus={{ selector: '[role="tab"]', activate: true }}
  >
    {#each shownTabs as item (item.id)}
      <button
        type="button"
        role="tab"
        id="panel-tab-{item.id}"
        aria-controls={mounted.has(item.id) ? `panel-${item.id}` : undefined}
        class:active={tab === item.id}
        aria-selected={tab === item.id}
        tabindex={tab === item.id ? 0 : -1}
        title={t(item.label)}
        onclick={() => (tab = item.id)}
      >
        <item.icon size={16} />
        <span class="tab-label">{t(item.label)}</span>
        {#if badge[item.id]}<span class="tab-dot" aria-hidden="true"></span><span class="sr-only"
            >{t('panel.tab.activity')}</span
          >{/if}
      </button>
    {/each}
  </div>

  <div class="panel-body">
    {#if engine.usingDemo}
      <p class="panel-empty">{t('panel.demo')}</p>
    {:else if sessionId}
      {#each shownTabs as item (item.id)}
        {#if mounted.has(item.id)}
          <div
            class="tab-slot"
            class:hidden={tab !== item.id}
            role="tabpanel"
            id="panel-{item.id}"
            aria-labelledby="panel-tab-{item.id}"
          >
            {#if item.id === 'files'}
              <FilesTab {sessionId} {openRequest} active={tab === 'files'} />
            {:else if item.id === 'git'}
              <GitTab {sessionId} active={tab === 'git'} onopenfile={openFile} />
            {:else if item.id === 'memory'}
              <MemoryTab active={tab === 'memory'} />
            {:else if item.id === 'context'}
              <ContextTab {sessionId} active={tab === 'context'} onopenfile={openFile} />
            {:else if item.id === 'tasks'}
              <TasksTab {sessionId} active={tab === 'tasks'} />
            {:else if item.id === 'browser'}
              <BrowserTab
                {sessionId}
                generation={engine.generation}
                hasControl={engine.hasControl}
                active={tab === 'browser'}
              />
            {:else}
              <TerminalTab
                {sessionId}
                generation={engine.generation}
                hasControl={engine.hasControl}
                active={tab === 'terminal'}
              />
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</section>

<style>
  .session-panes {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    container: session-panes / inline-size;
  }
  .panel-tabs {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 16px 6px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .panel-tabs > button[role='tab'] {
    position: relative;
    flex: none;
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 9px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--muted);
    background: transparent;
    font-size: 12.5px;
    font-weight: 500;
  }
  @media (hover: none) {
    .panel-tabs > button[role='tab'] {
      height: 40px;
      padding: 0 12px;
    }
  }
  .panel-tabs > button[role='tab']:hover {
    color: var(--ink);
    background: var(--bg-hover);
  }
  .panel-tabs > button[role='tab'].active {
    color: var(--ink);
    background: var(--bg-active);
  }
  @container session-panes (max-width: 459px) {
    .panel-tabs > button[role='tab']:not(.active) .tab-label {
      display: none;
    }
  }
  .tab-dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .panel-body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
  .panel-body > .panel-empty {
    padding: 4px 12px;
  }
  /* Each tab scrolls on its own, so a hidden tab keeps its scroll position. */
  .tab-slot {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    padding: 8px 20px 16px;
  }
  /* Not display:none, which would lose the scroll offset; skips rendering instead. */
  .tab-slot.hidden {
    visibility: hidden;
    content-visibility: hidden;
  }
  @media (max-width: 650px) {
    .panel-tabs {
      padding-inline: 8px;
    }
    .tab-slot {
      padding: 4px 12px calc(16px + env(safe-area-inset-bottom));
    }
  }
  .tab-slot:has(> :global(.terminal-tab)) {
    overflow: hidden;
    padding: 0;
  }
</style>
