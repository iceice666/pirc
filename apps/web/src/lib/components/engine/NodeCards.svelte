<script lang="ts">
  /** The connected nodes: what each machine can do and how busy it is (plan 08). */
  import { ago } from '../../time';
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
      ? `${node.load.running} running${node.load.max != null ? ` of ${node.load.max}` : ''}`
      : '';
</script>

<section class="settings-section" aria-labelledby="nodes-title">
  <h3 id="nodes-title">Nodes</h3>
  {#if !nodes.length}
    <p class="muted">No node is connected. Start pirc-node on a machine to give pirc hands.</p>
  {:else}
    <ul class="cards">
      {#each nodes as node (node.id)}
        {@const can = node.capabilities}
        <li class="card" aria-label="Node {node.id}">
          <header>
            <span class="dot" aria-hidden="true"></span>
            <strong>{node.id}</strong>
            <span class="muted">connected {ago(node.connectedAt)}</span>
          </header>
          <dl>
            {#if can}
              <dt>Machine</dt>
              <dd>{can.os} · {can.arch}</dd>
              <dt>GPU</dt>
              <dd>{gpus(node) || 'None'}</dd>
              <dt>Can</dt>
              <dd>
                {[can.browser ? 'browse' : '', can.terminals ? 'open terminals' : '']
                  .filter(Boolean)
                  .join(', ') || 'run agents'}
              </dd>
              <dt>Sandbox</dt>
              <dd>{can.sandbox.backend} · {can.sandbox.status}</dd>
            {:else}
              <dt>Machine</dt>
              <dd class="muted">Not reported</dd>
            {/if}
            {#if node.load}
              <dt>Load</dt>
              <dd>{load(node)}</dd>
            {/if}
            <dt>Workspaces</dt>
            <dd>
              {node.workspaces.map((workspace) => workspace.displayName).join(', ') || 'None'}
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
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
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
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
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
