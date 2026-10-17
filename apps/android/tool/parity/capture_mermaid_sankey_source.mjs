// node apps/android/tool/parity/capture_mermaid_sankey_source.mjs
// Captures pinned Mermaid Sankey parser data and its exact d3-sankey defaults.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const webRoot = resolve(root, 'apps/web');
const pinnedWebRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync(
  'git',
  ['diff', '--exit-code', pinnedWebRevision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root, stdio: 'ignore' },
);

const webRequire = createRequire(resolve(webRoot, 'package.json'));
const mermaidPackage = JSON.parse(
  await readFile(resolve(webRoot, 'node_modules/mermaid/package.json'), 'utf8'),
);
const mermaidDependency = resolve(root, 'node_modules/.bun/mermaid@11.17.2/node_modules');
const d3Package = JSON.parse(
  await readFile(resolve(mermaidDependency, 'd3-sankey/package.json'), 'utf8'),
);
assert.equal(mermaidPackage.version, '11.17.2');
assert.equal(d3Package.version, '0.12.3');

const { JSDOM } = webRequire('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import(pathToFileURL(webRequire.resolve('mermaid')).href);
mermaid.initialize({ startOnLoad: false });
const resolvedConfig = mermaid.mermaidAPI.getConfig();
const sankeyConfig = resolvedConfig.sankey;
const extentWidth = sankeyConfig.width ?? 600;
const extentHeight = sankeyConfig.height ?? extentWidth;
const nodeWidth = sankeyConfig.nodeWidth ?? 10;
const nodePadding = (sankeyConfig.nodePadding ?? 12) + ((sankeyConfig.showValues ?? true) ? 15 : 0);
const nodeAlignment = sankeyConfig.nodeAlignment ?? 'justify';
assert.equal(nodeAlignment, 'justify', 'fixture uses the pinned default alignment');

const d3Require = createRequire(resolve(mermaidDependency, 'd3-sankey/package.json'));
const { sankey, sankeyJustify } = d3Require('./dist/d3-sankey.js');

const cases = [
  {
    id: 'weighted-branching',
    source: 'sankey-beta\nA,B,5\nA,C,3\nB,D,4\nC,D,4',
  },
  {
    id: 'quoted-commas-escaped-quotes-and-duplicates',
    source:
      'sankey-beta\n"Input, raw","Stage ""one""",4.5\n' +
      '"Input, raw","Stage ""one""",1.5\n' +
      '"Stage ""one""",Output,6',
  },
  {
    id: 'zero-flow-with-positive-flows',
    source: 'sankey\nA,B,0\nA,C,2\nB,D,1\nC,D,1',
  },
  {
    id: 'unbalanced-merge-and-intermediate-layer',
    source:
      'sankey-beta\nNorth,Sorting,7\nNorth,Discard,2\n' +
      'Sorting,Reuse,4\nSorting,Recover,3\n' +
      'Reuse,Output,4\nRecover,Output,3\nDiscard,Output,2',
  },
  {
    id: 'fractional-parallel-and-branching-flows',
    source: 'sankey\nA,B,0.25\nA,B,0.75\nA,C,2.5\n' + 'B,D,1\nC,D,2',
  },
  {
    id: 'all-zero-flow',
    source: 'sankey\nA,B,0',
  },
  {
    id: 'cycle',
    source: 'sankey\nA,B,1\nB,A,1',
  },
  {
    id: 'non-ascii-label',
    source: 'sankey\n台北,A,1',
  },
];

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const captured = [];
for (const item of cases) {
  let diagram;
  try {
    diagram = await mermaid.mermaidAPI.getDiagramFromText(item.source);
  } catch (error) {
    captured.push({
      ...item,
      parserStatus: 'error',
      parserError: String(error?.str ?? error?.message ?? error).split('\n')[0],
    });
    continue;
  }
  const raw = diagram.db.getGraph();
  const graph = {
    nodes: raw.nodes.map((node) => node.id),
    flows: raw.links.map((link, index) => ({
      source: link.source,
      target: link.target,
      value: link.value,
      index,
    })),
  };
  try {
    const laidOut = sankey()
      .nodeId((node) => node.id)
      .nodeWidth(nodeWidth)
      .nodePadding(nodePadding)
      .nodeAlign(sankeyJustify)
      .extent([
        [0, 0],
        [extentWidth, extentHeight],
      ])(raw);
    const nodes = laidOut.nodes.map((node) => ({
      id: node.id,
      value: finiteOrNull(node.value),
      layer: finiteOrNull(node.layer),
      x0: finiteOrNull(node.x0),
      x1: finiteOrNull(node.x1),
      y0: finiteOrNull(node.y0),
      y1: finiteOrNull(node.y1),
    }));
    const flows = laidOut.links.map((link) => ({
      source: link.source.id,
      target: link.target.id,
      value: finiteOrNull(link.value),
      width: finiteOrNull(link.width),
      sourceY: finiteOrNull(link.y0),
      targetY: finiteOrNull(link.y1),
    }));
    const finite = [...nodes, ...flows].every((entry) =>
      Object.values(entry).every(
        (value) => value !== null && (typeof value !== 'number' || Number.isFinite(value)),
      ),
    );
    captured.push({
      ...item,
      parserStatus: 'accepted',
      graph,
      layoutStatus: finite ? 'ok' : 'non-finite',
      nodes,
      flows,
    });
  } catch (error) {
    captured.push({
      ...item,
      parserStatus: 'accepted',
      graph,
      layoutStatus: 'error',
      layoutError: String(error?.message ?? error).split('\n')[0],
    });
  }
}

const fixture = {
  webSha: pinnedWebRevision,
  mermaidVersion: mermaidPackage.version,
  d3SankeyVersion: d3Package.version,
  oracle: 'Mermaid 11.17.2 resolved config plus d3-sankey 0.12.3 Sankey() with renderer defaults',
  resolvedSankeyConfig: {
    width: sankeyConfig.width,
    height: sankeyConfig.height,
    useMaxWidth: sankeyConfig.useMaxWidth,
    nodeAlignment: sankeyConfig.nodeAlignment,
    showValues: sankeyConfig.showValues,
    nodeWidth: sankeyConfig.nodeWidth,
    nodePadding: sankeyConfig.nodePadding,
    labelStyle: sankeyConfig.labelStyle,
    prefix: sankeyConfig.prefix,
    suffix: sankeyConfig.suffix,
  },
  defaults: {
    extent: [
      [0, 0],
      [extentWidth, extentHeight],
    ],
    nodeAlignment,
    nodeWidth,
    nodePadding,
    iterations: 6,
  },
  cases: captured,
};
const output = resolve(root, 'fixtures/mobile-parity/mermaid-sankey.json');
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${output} (${captured.length} source cases)`);
