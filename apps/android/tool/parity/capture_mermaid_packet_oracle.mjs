// node apps/android/tool/parity/capture_mermaid_packet_oracle.mjs
// Reads packet data from the pinned Mermaid PacketDB/parser in Node. This is a
// parser oracle; it does not launch a browser or produce SVG captures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const mermaidPackage = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
assert.equal(mermaidPackage.version, '11.17.2');

// Mermaid's common DB sanitizes accessibility/title strings through DOMPurify.
// Provide its existing workspace jsdom runtime before importing the diagram.
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { JSDOM } = require('jsdom');
globalThis.window = new JSDOM('').window;
globalThis.document = globalThis.window.document;

const { diagram } = await import(
  resolve(root, 'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/diagram-Z3DM3KII.mjs')
);
const { setConfig } = await import(
  resolve(root, 'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/chunk-DU6HZSFF.mjs')
);

const cases = [
  {
    id: 'packet-tcp',
    source: [
      'packet-beta',
      'title TCP',
      '0-15: "Source Port"',
      '16-31: "Destination Port"',
      '32-63: "Sequence Number"',
      '64-95: "Acknowledgment Number"',
    ].join('\n'),
  },
  {
    id: 'packet-cross-row',
    source: [
      'packet-beta',
      '+5: "Header"',
      '+43: "Cross row"',
      '+16: "Payload"',
    ].join('\n'),
  },
  {
    id: 'packet-accessible',
    source: [
      'packet',
      'accTitle: Binary frame',
      'accDescr: Flag and payload fields',
      '0: "Flag"',
      '1-7: "Mode"',
      '8-31: "Payload"',
    ].join('\n'),
  },
  {
    id: 'packet-configured',
    source: [
      '%%{init: {"packet": {"bitsPerRow":16,"bitWidth":24,"showBits":false}}}%%',
      'packet-beta',
      'title Configured header',
      '+9: "Control"',
      '+23: "Payload"',
    ].join('\n'),
    packetConfig: { bitsPerRow: 16, bitWidth: 24, showBits: false },
  },
  {
    id: 'packet-init-all-fields',
    source: [
      '%%{init: {"packet": {"bitsPerRow":16,"bitWidth":24,"showBits":true,"rowHeight":24,"paddingX":0,"paddingY":7,"useMaxWidth":false}}}%%',
      'packet-beta',
      'title Custom geometry',
      '+8: "Header"',
      '+16: "Body"',
    ].join('\n'),
    packetConfig: {
      bitsPerRow: 16,
      bitWidth: 24,
      showBits: true,
      rowHeight: 24,
      paddingX: 0,
      paddingY: 7,
      useMaxWidth: false,
    },
  },
];

const outputCases = [];
for (const item of cases) {
  if (item.packetConfig) {
    setConfig({ packet: item.packetConfig });
  }
  const db = diagram.db;
  db.clear();
  diagram.parser.parser.yy = db;
  const parserSource = item.source.replace(/^%%\{init:[^\n]*\}%%\n/, '');
  await diagram.parser.parse(parserSource);
  outputCases.push({
    id: item.id,
    source: item.source,
    title: db.getDiagramTitle(),
    accessibleTitle: db.getAccTitle(),
    accessibleDescription: db.getAccDescription(),
    config: db.getConfig(),
    rows: db.getPacket().map((row) =>
      row.map(({ start, end, bits, label }) => ({ start, end, bits, label })),
    ),
  });
}

const output = {
  webRevision: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
  mermaidVersion: mermaidPackage.version,
  oracleMode: 'node-pinned-packet-db-parser-only',
  usesChromium: false,
  source: 'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/diagram-Z3DM3KII.mjs',
  sourceMap: 'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/diagram-Z3DM3KII.mjs.map',
  cases: outputCases,
};
const outputPath = resolve(root, 'fixtures/mobile-parity/mermaid-packet-oracle.json');
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath} from Mermaid ${mermaidPackage.version} PacketDB (Node parser-only).`);
