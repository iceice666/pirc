// node apps/android/tool/parity/capture_mermaid_architecture_oracle.mjs
// Captures the actual pinned Mermaid parser and ArchitectureDB before layout.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const webRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--quiet', webRevision, '--', 'apps/web/src/lib/markdown.ts', 'apps/web/package.json'], { cwd: root });

const mermaidRoot = resolve(root, 'apps/web/node_modules/mermaid');
const packageJson = JSON.parse(await readFile(resolve(mermaidRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '11.17.2') {
  throw new Error('Expected pinned Mermaid 11.17.2; found ' + packageJson.version);
}
const architectureChunk = resolve(
  mermaidRoot,
  'dist/chunks/mermaid.core/architectureDiagram-5GKGNRK7.mjs',
);
const { diagram } = await import(pathToFileURL(architectureChunk).href);
const casesFixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/mermaid-important-cases.json'), 'utf8'),
);
if (casesFixture.baselineCommit !== webRevision || casesFixture.mermaidVersion !== packageJson.version) {
  throw new Error('Architecture inputs are not pinned to the expected Mermaid baseline');
}
const cases = casesFixture.cases
  .filter((item) => item.family === 'architecture')
  .map((item) => ({ id: item.id, source: item.source }));
if (cases.length < 3) throw new Error('Expected service, junction and nested-group architecture cases');

const cloneRows = (items) => JSON.parse(JSON.stringify(items));
function captureDb(db) {
  const structures = db.getDataStructures();
  return {
    groups: cloneRows(db.getGroups()),
    services: cloneRows(db.getServices().map(({ edges, ...service }) => service)),
    junctions: cloneRows(db.getJunctions().map(({ edges, ...junction }) => junction)),
    edges: cloneRows(db.getEdges()),
    layoutHints: cloneRows(db.getLayoutHints()),
    adjacency: [...structures.adjList.entries()].map(([id, directions]) => [id, [...directions.entries()]]),
    spatialMaps: structures.spatialMaps.map((map) => [...map.entries()]),
    groupAlignments: [...structures.groupAlignments.entries()],
  };
}

for (const item of cases) {
  // `diagram.db` is a getter, so hold the instance shared by parser.yy and the
  // getters used below. The parser writes through this ArchitectureDB instance.
  const db = diagram.db;
  db.clear();
  diagram.parser.parser.yy = db;
  await diagram.parser.parse(item.source);
  item.db = captureDb(db);
}

const invalidCases = [
  {
    id: 'duplicate-service-id',
    source: ['architecture-beta', 'service api(server)[API]', 'service api(database)[DB]'].join('\n'),
  },
  {
    id: 'missing-edge-endpoint',
    source: ['architecture-beta', 'service api(server)[API]', 'api:R --> L:missing'].join('\n'),
  },
  {
    id: 'missing-parent-group',
    source: ['architecture-beta', 'service api(server)[API] in absent'].join('\n'),
  },
  {
    id: 'invalid-group-parent-kind',
    source: ['architecture-beta', 'service api(server)[API]', 'group region(cloud)[Region] in api'].join('\n'),
  },
];
for (const item of invalidCases) {
  const db = diagram.db;
  db.clear();
  diagram.parser.parser.yy = db;
  try {
    await diagram.parser.parse(item.source);
    throw new Error('Expected pinned Mermaid parser rejection for ' + item.id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Expected pinned Mermaid parser rejection')) throw error;
    item.accepted = false;
    item.errorName = error instanceof Error ? error.name : 'Error';
    item.error = error instanceof Error ? error.message : String(error);
  }
}

const fixture = {
  fixture: 'mermaid-architecture-parser-v1',
  webRevision,
  mermaidVersion: packageJson.version,
  architectureChunk: 'dist/chunks/mermaid.core/architectureDiagram-5GKGNRK7.mjs',
  oracle:
    'Pinned Mermaid architecture parser and ArchitectureDB getters before SVG layout. Source cases are read from mermaid-important-cases.json and include groups, services, junctions, directional ports, arrow flags, nested membership, and {group} boundary traversal.',
  cases,
  invalidCases,
};
const output = resolve(root, 'fixtures/mobile-parity/mermaid-architecture-oracle.json');
await writeFile(output, JSON.stringify(fixture, null, 2) + '\n');
process.stdout.write(
  'Wrote ' + cases.length + ' actual architecture parser/DB cases and ' + invalidCases.length + ' parser errors to ' + output + '\n',
);
