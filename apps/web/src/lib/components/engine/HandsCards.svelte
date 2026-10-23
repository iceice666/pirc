<script lang="ts">
  /**
   * The dashboard's Nodes section (design screen 5, "Hands"): one card per
   * connected node — its id, what it runs on, whether it is busy, how full it
   * is, what it can do and which workspaces live there. Every value is the
   * node's own report: the comp's "[GPU MODEL]", "connected 3 d ago" and the
   * load counts are real fields here, and a missing one is left out instead of
   * invented. The full per-node detail is the Nodes section below.
   */
  import { Cpu, Monitor, Server } from '@lucide/svelte';
  import { t } from '../../i18n';
  import { ago } from '../../time';
  import type { NodeSummary } from '../../types';
  import StatusGlyph from '../StatusGlyph.svelte';

  interface Props {
    nodes: NodeSummary[];
    /** The "All nodes" link: the Nodes section's anchor, handled by the page. */
    onall: (event: MouseEvent) => void;
  }

  let { nodes, onall }: Props = $props();

  const running = (node: NodeSummary) => node.load?.running ?? 0;
  const maxRunning = (node: NodeSummary) =>
    node.load?.max ?? node.capabilities?.maxRunning ?? node.load?.running ?? 0;
  const busy = (node: NodeSummary) => running(node) > 0;
  const gpus = (node: NodeSummary) => node.capabilities?.gpus ?? [];
  const gpuLabel = (gpu: { count: number; vendor: string; model?: string }) =>
    [
      t('engine.nodes.gpu'),
      '·',
      `${gpu.count}× ${gpu.vendor}${gpu.model ? ` ${gpu.model}` : ''}`,
    ].join(' ');
  const icon = (node: NodeSummary) => (node.capabilities?.os === 'darwin' ? Monitor : Server);
  const workspaces = (node: NodeSummary) =>
    node.workspaces.map((workspace) => workspace.displayName).join(', ') || t('common.none');
</script>

<section class="hands" aria-labelledby="hands-title">
  <div class="block-head">
    <h2 id="hands-title" class="section-label">
      {t('engine.section.nodes')} · {t('engine.nodes.online', { count: nodes.length })}
    </h2>
    <a class="all" href="#nodes" onclick={onall}>{t('engine.nodes.all')}</a>
  </div>
  {#if !nodes.length}
    <p class="muted">{t('engine.nodes.empty')}</p>
  {:else}
    <ul class="cards">
      {#each nodes as node (node.id)}
        {@const can = node.capabilities}
        {@const Icon = icon(node)}
        <li class="card" aria-label={t('engine.nodes.cardLabel', { name: node.id })}>
          <header class="card-head">
            <span class="tile" aria-hidden="true"><Icon size={18} /></span>
            <span class="ident">
              <strong class="mono">{node.id}</strong>
              <span class="meta">
                {can ? `${can.os} · ${can.arch} · ` : ''}{t('engine.nodes.connected', {
                  when: ago(node.connectedAt),
                })}
              </span>
            </span>
            <span class:busy={busy(node)} class="state">
              <StatusGlyph state={busy(node) ? 'working' : 'idle'} />
              {busy(node) ? t('engine.nodes.busy') : t('engine.nodes.free')}
            </span>
          </header>
          {#if maxRunning(node) > 0}
            <div class="load">
              <div class="load-row">
                <span>{t('engine.nodes.running')}</span>
                <span class="value"
                  >{t('engine.nodes.of', {
                    count: running(node),
                    max: maxRunning(node),
                  })}</span
                >
              </div>
              <!-- Decorative: the same count is in the line above, for screen readers. -->
              <div class="meter" aria-hidden="true">
                {#each Array(Math.min(maxRunning(node), 12)) as _, index (index)}
                  <span class:on={index < running(node)}></span>
                {/each}
              </div>
            </div>
          {/if}
          {#if can}
            <div class="chips">
              {#each gpus(node) as gpu, index (index)}
                <span class="chip">{gpuLabel(gpu)}</span>
              {:else}
                <span class="chip dim">{t('engine.nodes.noGpu')}</span>
              {/each}
              {#if can.browser}<span class="chip">{t('engine.nodes.browse')}</span>{/if}
              {#if can.terminals}<span class="chip">{t('engine.nodes.terminals')}</span>{/if}
              <span class:ready={can.sandbox.status === 'ready'} class="chip">
                {can.sandbox.backend} · {can.sandbox.status}
              </span>
            </div>
          {/if}
          <p class="workspaces">
            {t('engine.nodes.workspaces')} · <span class="mono">{workspaces(node)}</span>
          </p>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .hands {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .block-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .block-head h2 {
    margin: 0;
  }
  .all {
    margin-left: auto;
    font-size: 13px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tile {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    color: var(--text-2);
    background: var(--bg-subtle);
  }
  .ident {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .ident strong {
    overflow: hidden;
    color: var(--ink);
    font-weight: 500;
    font-size: 14px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .meta {
    color: var(--faint);
    font-size: 12px;
  }
  .state {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
  .state.busy {
    color: var(--success);
  }
  .load {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .load-row {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font-size: 12px;
  }
  .load-row .value {
    color: var(--text-2);
  }
  .meter {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .meter span {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
  }
  .meter span.on {
    background: var(--success);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 2px 8px;
    border-radius: 12px;
    color: var(--text-2);
    background: var(--bg-hover);
    font-size: 12px;
  }
  .chip.dim {
    color: var(--muted);
  }
  .chip.ready {
    color: color-mix(in srgb, var(--success) 70%, var(--ink));
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .workspaces {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .workspaces .mono {
    color: var(--text-2);
  }
  .muted {
    color: var(--muted);
  }
</style>
