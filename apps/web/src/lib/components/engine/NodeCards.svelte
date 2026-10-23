<script lang="ts">
  /** The connected nodes: what each machine can do and how busy it is (plan 08). */
  import { ago } from '../../time';
  import { t } from '../../i18n';
  import StatusGlyph from '../StatusGlyph.svelte';
  import type { NodeSummary } from '../../types';

  interface Props {
    nodes: NodeSummary[];
  }

  let { nodes }: Props = $props();

  const gpus = (node: NodeSummary) =>
    (node.capabilities?.gpus ?? [])
      .map((gpu) =>
        [
          `${gpu.count}× ${gpu.vendor}`,
          gpu.model,
          gpu.vramMb ? `${Math.round(gpu.vramMb / 1024)} GB` : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
      .join(', ');
  const load = (node: NodeSummary) =>
    node.load
      ? node.load.max != null
        ? t('engine.runningOf', { count: node.load.running, max: node.load.max })
        : t('engine.running', { count: node.load.running })
      : '';
</script>

<section class="settings-section" aria-labelledby="nodes-title">
  <h3 id="nodes-title">{t('engine.section.nodes')}</h3>
  {#if !nodes.length}
    <p class="muted">{t('engine.nodes.empty')}</p>
  {:else}
    <ul class="cards">
      {#each nodes as node (node.id)}
        {@const can = node.capabilities}
        <li class="card" aria-label={t('engine.nodes.cardLabel', { name: node.id })}>
          <header>
            <StatusGlyph state={node.load?.running ? 'working' : 'idle'} />
            <strong>{node.id}</strong>
            <span class="muted">{t('engine.nodes.connected', { when: ago(node.connectedAt) })}</span
            >
          </header>
          <dl>
            {#if can}
              <dt>{t('engine.nodes.machine')}</dt>
              <dd>{can.os} · {can.arch}</dd>
              <dt>GPU</dt>
              <dd>{gpus(node) || t('common.none')}</dd>
              <dt>{t('engine.nodes.can')}</dt>
              <dd>
                {[
                  can.browser ? t('engine.nodes.browse') : '',
                  can.terminals ? t('engine.nodes.terminals') : '',
                ]
                  .filter(Boolean)
                  .join(', ') || t('engine.nodes.agents')}
              </dd>
              <dt>{t('engine.nodes.sandbox')}</dt>
              <dd>{can.sandbox.backend} · {can.sandbox.status}</dd>
            {:else}
              <dt>{t('engine.nodes.machine')}</dt>
              <dd class="muted">{t('engine.nodes.notReported')}</dd>
            {/if}
            {#if node.load}
              <dt>{t('engine.nodes.load')}</dt>
              <dd>{load(node)}</dd>
            {/if}
            <dt>{t('engine.nodes.workspaces')}</dt>
            <dd>
              {node.workspaces.map((workspace) => workspace.displayName).join(', ') ||
                t('common.none')}
            </dd>
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    padding: 14px 16px;
    border-radius: var(--radius-lg);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  header .muted {
    margin-left: auto;
    font-size: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
  }
</style>
