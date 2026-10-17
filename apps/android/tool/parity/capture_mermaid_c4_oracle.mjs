// node apps/android/tool/parity/capture_mermaid_c4_oracle.mjs
// Captures the pinned Mermaid C4 Jison parser and c4Db values before SVG layout.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const webRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--quiet', webRevision, '--', 'apps/web/src', 'apps/web/package.json'], { cwd: root });

const mermaidRoot = resolve(root, 'apps/web/node_modules/mermaid');
const packageJson = JSON.parse(await readFile(resolve(mermaidRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '11.17.2') {
  throw new Error('Expected pinned Mermaid 11.17.2; found ' + packageJson.version);
}
const c4Chunk = resolve(mermaidRoot, 'dist/chunks/mermaid.core/c4Diagram-7LVT6UL2.mjs');
const purifyPath = resolve(
  root,
  'node_modules/.bun/dompurify@3.4.16/node_modules/dompurify/dist/purify.es.mjs',
);
const purify = (await import(pathToFileURL(purifyPath).href)).default;
// This Node oracle passes plain C4 source to the real parser and DB. DOMPurify
// has no browser DOM here, so its identity stub is parser-only evidence.
purify.addHook = () => {};
purify.sanitize = (value) => value;

const mermaid = (await import(pathToFileURL(resolve(mermaidRoot, 'dist/mermaid.core.mjs')).href))
  .default;
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  themeVariables: {
    background: '#ffffff',
    primaryColor: '#edf3fe',
    primaryBorderColor: '#4176e6',
    primaryTextColor: '#0f1115',
    lineColor: '#81858c',
    secondaryColor: '#f1f3f5',
    tertiaryColor: '#f9fafb',
    fontSize: '13px',
  },
});
const { diagram } = await import(pathToFileURL(c4Chunk).href);

const cases = [
  {
    id: 'context-title-person-system-external',
    header: 'C4Context',
    source: [
      'C4Context',
      'title Account access',
      'Person(user, "User", "People who use the portal")',
      'Person_Ext(support, "Support", "External operator")',
      'System(portal, "Customer Portal", "Account access")',
      'System_Ext(identity, "Identity Provider", "External authentication")',
      'Rel(user, portal, "Signs in", "HTTPS")',
      'Rel(support, identity, "Administers", "OIDC")',
    ].join('\n'),
  },
  {
    id: 'container-db-queue-nested-boundaries',
    header: 'C4Container',
    source: [
      'C4Container',
      'title Commerce containers',
      'Enterprise_Boundary(enterprise, "Commerce, Inc.") {',
      ' System_Boundary(checkout, "Checkout system") {',
      '  Container_Boundary(webTier, "Web tier") {',
      '   Container(web, "Web app", "TypeScript", "Serves checkout pages")',
      '   ContainerQueue(events, "Events", "Kafka", "Checkout notifications")',
      '  }',
      '  ContainerDb(ledger, "Ledger", "PostgreSQL", "Stores settled payments")',
      ' }',
      ' System_Ext(provider, "Payment provider", "External processor")',
      '}',
    ].join('\n'),
  },
  {
    id: 'component-long-label-description-commas',
    header: 'C4Component',
    source: [
      'C4Component',
      'title Catalog API',
      'Component(api, "A long API component label that should wrap across several lines", "Go, gRPC, PostgreSQL", "Accepts comma-separated options, product filters, and sort keys from clients.")',
      'ComponentDb(catalog, "Catalog store", "PostgreSQL", "Stores product metadata")',
      'ComponentQueue(index, "Search index updates", "Kafka", "Publishes product, price, and stock changes")',
    ].join('\n'),
  },
  {
    id: 'dynamic-relindex-source-order',
    header: 'C4Dynamic',
    source: [
      'C4Dynamic',
      'title Checkout request order',
      'Person(user, "User")',
      'System(api, "Checkout API")',
      'SystemDb(db, "Payment database")',
      'RelIndex(2, api, db, "Writes payment", "SQL")',
      'RelIndex(1, user, api, "Submits checkout", "HTTPS")',
      'RelIndex(3, db, user, "Returns receipt", "JSON")',
    ].join('\n'),
  },
  {
    id: 'deployment-nested-node-instances',
    header: 'C4Deployment',
    source: [
      'C4Deployment',
      'title Production deployment',
      'Deployment_Node(cloud, "Cloud account", "AWS") {',
      ' Deployment_Node(region, "Region", "us-east-1") {',
      '  Node_L(cluster, "Kubernetes cluster", "Kubernetes") {',
      '   Container(api, "API instance", "v2", "Handles checkout")',
      '   ContainerDb(cache, "Cache instance", "Redis", "Stores short-lived session data")',
      '  }',
      '  Node_R(worker, "Worker host", "Linux") {',
      '   ContainerQueue(queue, "Queue consumer", "Kafka client", "Processes checkout events")',
      '  }',
      ' }',
      '}',
    ].join('\n'),
  },
  {
    id: 'wrap-layout-update',
    header: 'C4Container',
    config: { wrap: true },
    source: [
      '%%{init: {"c4": {"wrap": true}}}%%',
      'C4Container',
      'title Wrapped layout',
      'UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")',
      'System_Boundary(system, "A very long boundary label for the wrapping case") {',
      ' Container(api, "Checkout API with a deliberately long label", "Go, gRPC", "This description contains enough words to wrap across multiple measured lines in the actual rendered diagram.")',
      ' ContainerDb(db, "Payment database", "PostgreSQL", "Stores payment and audit records.")',
      ' ContainerQueue(events, "Checkout events", "Kafka", "Carries payment lifecycle messages.")',
      '}',
      'System_Ext(provider, "External Payment Service")',
    ].join('\n'),
  },
  {
    id: 'element-and-relation-style-offsets',
    header: 'C4Container',
    source: [
      'C4Container',
      'title Styled relationships',
      'Person(user, "User")',
      'System(api, "Checkout API")',
      'System_Boundary(backend, "Backend") {',
      ' ContainerDb(db, "Ledger", "PostgreSQL")',
      '}',
      'Rel(user, api, "Starts checkout", "HTTPS", "Sends checkout details")',
      'Rel(api, db, "Writes payment", "SQL")',
      'UpdateElementStyle(api, $bgColor="#e0f2fe", $fontColor="#164e63", $borderColor="#0284c7", $shadowing="true")',
      'UpdateElementStyle(backend, $bgColor="#ecfccb", $fontColor="#365314", $borderColor="#65a30d")',
      'UpdateRelStyle(user, api, $textColor="#7c3aed", $lineColor="#059669", $offsetX="12", $offsetY="-8")',
    ].join('\n'),
  },
  {
    id: 'duplicate-alias-and-edge-semantics',
    header: 'C4Context',
    source: [
      'C4Context',
      'title Duplicate alias behavior',
      'Person(user, "Original user")',
      'Person(user, "Replacement user", "Updated description")',
      'System(api, "Checkout API")',
      'SystemDb(db, "Ledger")',
      'SystemQueue(events, "Events")',
      'Rel(user, db, "Initial relation", "HTTP")',
      'Rel(user, db, "Replacement relation", "SQL", "Replaces earlier endpoint pair")',
      'BiRel(db, api, "Bidirectional sync")',
      'Rel_Back(api, events, "Acknowledges")',
      'Rel_Left(events, user, "Notifies")',
      'Rel_Up(api, db, "Reads")',
      'Rel_Down(user, api, "Submits")',
      'Rel_Right(db, events, "Publishes")',
    ].join('\n'),
  },
];

const escapedQuote = String.fromCharCode(92) + '"';
const invalidCases = [
  {
    id: 'invalid-component-escaped-quotes',
    header: 'C4Component',
    source: [
      'C4Component',
      'Component(api, "A long component label", "Go, gRPC", "Contains ' +
        escapedQuote +
        'quoted' +
        escapedQuote +
        ', comma-separated description text")',
    ].join('\n'),
  },
  {
    id: 'invalid-unclosed-relation',
    header: 'C4Context',
    source: ['C4Context', 'Person(user, "User")', 'Rel(user, api, "Uses"'].join('\n'),
  },
];

const clone = (value) => JSON.parse(JSON.stringify(value));
function captureDb(db) {
  const itemWrapState = (item, identity) => ({
    ...identity,
    ownsWrapField: Object.hasOwn(item, 'wrap'),
    value: item.wrap === undefined ? 'undefined' : item.wrap,
  });
  const shapes = db.getC4ShapeArray();
  const boundaries = db.getBoundaries();
  const rels = db.getRels();
  return {
    type: db.getC4Type(),
    title: db.getTitle(),
    shapes: clone(shapes),
    boundaries: clone(boundaries),
    rels: clone(rels),
    shapeInRow: db.getC4ShapeInRow(),
    boundaryInRow: db.getC4BoundaryInRow(),
    itemWrapState: {
      shapes: shapes.map((shape) => itemWrapState(shape, { alias: shape.alias })),
      boundaries: boundaries.map((boundary) => itemWrapState(boundary, { alias: boundary.alias })),
      rels: rels.map((rel) => itemWrapState(rel, { from: rel.from, to: rel.to })),
    },
  };
}

for (const item of cases) {
  diagram.db.clear();
  // Mermaid C4 init receives a top-level `wrap`, separate from `c4.wrap`.
  // Pirc's C4 setting controls renderer text wrapping and does not populate
  // the DB rows' autoWrap flags. The pinned app leaves top-level wrap unset.
  diagram.db.setWrap(undefined);
  diagram.parser.yy = diagram.db;
  diagram.parser.parse(item.source);
  item.db = captureDb(diagram.db);
}

for (const item of invalidCases) {
  diagram.db.clear();
  diagram.parser.yy = diagram.db;
  try {
    diagram.parser.parse(item.source);
    throw new Error('Expected C4 parser rejection for ' + item.id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Expected C4 parser rejection')) throw error;
    item.accepted = false;
    item.errorName = error instanceof Error ? error.name : 'Error';
    item.error = String(error);
  }
}

const fixture = {
  fixture: 'mermaid-c4-parser-v1',
  webRevision,
  mermaidVersion: packageJson.version,
  c4Chunk: 'dist/chunks/mermaid.core/c4Diagram-7LVT6UL2.mjs',
  oracle:
    'Pinned Mermaid C4 parser and c4Db getters; cases include parser DB values before SVG layout. DB item wrap uses diagram.init top-level wrap (undefined here); config.wrap records the independent C4 renderer setting and does not populate row wrap flags. Node DOMPurify is identity-stubbed only for these plain C4 parser inputs and provides no Chrome sanitizer evidence.',
  parserInitialization: {
    topLevelWrap: 'undefined',
    note: 'C4 diagram init calls db.setWrap(topLevel wrap). The separate c4.wrap setting controls renderer wrapping and does not populate existing DB item wrap fields.',
  },
  cases,
  invalidCases,
};
const output = resolve(root, 'fixtures/mobile-parity/mermaid-c4-parser-expected.json');
await writeFile(output, JSON.stringify(fixture, null, 2) + '\n');
process.stdout.write(
  'Wrote ' + cases.length + ' actual C4 parser/DB cases and ' + invalidCases.length + ' parser errors to ' + output + '\n',
);
