// node apps/android/tool/parity/capture_mermaid_flow_parser.mjs
// Capture syntax-level decisions from the pinned Mermaid flowchart parser.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const webRoot = resolve(root, 'apps/web');
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const pinnedWebRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const expectedVersions = { mermaid: '11.17.2', jsdom: '27.4.0' };

execFileSync('git', ['diff', '--exit-code', pinnedWebRevision, '--', 'apps/web'], {
  cwd: root,
  stdio: 'ignore',
});

const mermaidPackage = JSON.parse(
  await readFile(resolve(webRoot, 'node_modules/mermaid/package.json'), 'utf8'),
);
const jsdomPackage = JSON.parse(
  await readFile(resolve(webRoot, 'node_modules/jsdom/package.json'), 'utf8'),
);
const dependencyVersions = {
  mermaid: mermaidPackage.version,
  jsdom: jsdomPackage.version,
};
for (const [name, expected] of Object.entries(expectedVersions)) {
  if (dependencyVersions[name] !== expected) {
    throw new Error(`Expected ${name} ${expected}, found ${dependencyVersions[name]}`);
  }
}

// Mermaid's parser sanitizes some labels through DOMPurify. Initialize the
// installed jsdom window before importing Mermaid so the capture remains a
// parser-only run with the same pinned dependencies.
const { JSDOM } = webRequire('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const mermaidEntry = webRequire.resolve('mermaid');
const { default: mermaid } = await import(pathToFileURL(mermaidEntry).href);
mermaid.initialize({ startOnLoad: false });

const operators = [
  ['bidirectional-arrow', '<-->'],
  ['circle-both', 'o--o'],
  ['cross-both', 'x--x'],
  ['circle-to-arrow', 'o-->'],
  ['cross-to-arrow', 'x-->'],
  ['circle-to-cross', 'o--x'],
  ['cross-to-circle', 'x--o'],
  ['arrow-circle', '--o'],
  ['arrow-cross', '--x'],
  ['arrow', '-->'],
  ['reverse-arrow', '<--'],
  ['open-line', '---'],
  ['two-dash', '--'],
  ['dotted-arrow', '-.->'],
  ['dotted-open-line', '-.-'],
  ['dot-only', '-.'],
  ['thick-arrow', '==>'],
  ['thick-open-line', '==='],
  ['two-equals', '=='],
  ['circle-open-line', 'o--'],
  ['cross-open-line', 'x--'],
];
const cases = operators.map(([id, operator]) => ({
  id: `operator-${id}`,
  source: `flowchart LR\nA ${operator} B`,
}));
cases.push(
  {
    id: 'chain',
    source: 'flowchart LR\nA[One]-->B[Two]-->C[Three]',
  },
  {
    id: 'legacy-arrow-label',
    source: 'flowchart LR\nA -- text --> B',
  },
  {
    id: 'legacy-open-line-label',
    source: 'flowchart LR\nA -- text --- B',
  },
  {
    id: 'quoted-pipe-label',
    source: 'flowchart LR\nA -->|"yes | no"| B',
  },
  {
    id: 'entity-labels',
    source: 'flowchart LR\nA["Rock &amp; Roll"] --> B["#quot;quoted#quot;"]',
  },
  {
    id: 'class-like-node-ids',
    source: 'flowchart LR\nclassNode[Class node] --> classDefNode[ClassDef node]',
  },
  {
    id: 'quoted-directive-marker',
    source: 'flowchart LR\nA["literal %%{"] --> B',
  },
);

function captureError(error) {
  const message = String(error?.str ?? error?.message ?? error);
  return message.split('\n')[0];
}

const captured = [];
for (const item of cases) {
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(item.source);
    captured.push({
      ...item,
      status: 'accepted',
      vertices: [...diagram.db.vertices.values()]
        .map((vertex) => ({
          id: vertex.id,
          label: vertex.text,
          type: vertex.type ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: diagram.db.getEdges().map((edge) => ({
        start: edge.start,
        end: edge.end,
        text: edge.text,
        type: edge.type,
        stroke: edge.stroke,
      })),
    });
  } catch (error) {
    captured.push({
      ...item,
      status: 'error',
      error: captureError(error),
      vertices: [],
      edges: [],
    });
  }
}

const fixture = {
  id: 'mermaid-flow-parser-v1',
  webRevision: pinnedWebRevision,
  dependencyVersions,
  nodeVersion: process.version,
  cases: captured,
};
const output = resolve(root, 'fixtures/mobile-parity/mermaid-flow-parser-expected.json');
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
const accepted = captured.filter((item) => item.status === 'accepted').length;
console.log(`Wrote ${output} (${accepted} accepted, ${captured.length - accepted} errors)`);
