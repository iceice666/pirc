// node apps/android/tool/parity/generate_c4_android_cases.mjs
// Generate integration-test constants directly from the pinned parser oracle.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturePath = resolve(
  root,
  'fixtures/mobile-parity/mermaid-c4-parser-expected.json',
);
const outputPath = resolve(
  root,
  'apps/android/integration_test/c4_android_cases.dart',
);
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (fixture.fixture !== 'mermaid-c4-parser-v1') {
  throw new Error('Unexpected parser fixture: ' + fixture.fixture);
}
if (fixture.mermaidVersion !== '11.17.2') {
  throw new Error('Expected Mermaid 11.17.2; found ' + fixture.mermaidVersion);
}
if (fixture.cases?.length !== 8) {
  throw new Error('Expected eight valid C4 cases; found ' + fixture.cases?.length);
}

const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const dartString = (value) => JSON.stringify(String(value)).replaceAll('$', '\\$');
const nullableString = (value) => (value == null ? 'null' : dartString(value));
const rawTriple = (value) => {
  if (value.includes("'''")) {
    throw new Error('C4 source contains the raw triple-string delimiter');
  }
  return "r'''" + value + "'''";
};
const text = (value) => (value && typeof value.text === 'string' ? value.text : '');
const itemWrap = (entries, identity) => {
  const state = entries.find((entry) => entry.alias === identity)?.value;
  return state === true || state === 'true';
};
const list = (entries, render) =>
  entries.length === 0
    ? '[]'
    : '[\n' +
      entries.map((entry) => `      ${render(entry)}`).join(',\n') +
      ',\n    ]';

const cases = fixture.cases
  .map((item) => {
    const db = item.db;
    const expectedNodes = db.shapes.map((shape) => {
      const wrap = itemWrap(db.itemWrapState?.shapes ?? [], shape.alias);
      return `C4AndroidExpectedNode(\n` +
        `        alias: ${dartString(shape.alias)},\n` +
        `        kind: ${dartString(text(shape.typeC4Shape))},\n` +
        `        label: ${dartString(text(shape.label))},\n` +
        `        parentBoundary: ${dartString(shape.parentBoundary ?? '')},\n` +
        `        customType: ${nullableString(text(shape.type) || null)},\n` +
        `        technology: ${dartString(text(shape.techn))},\n` +
        `        description: ${dartString(text(shape.descr))},\n` +
        `        wrap: ${wrap},\n` +
        `        backgroundColor: ${nullableString(shape.bgColor)},\n` +
        `        fontColor: ${nullableString(shape.fontColor)},\n` +
        `        borderColor: ${nullableString(shape.borderColor)},\n` +
        `        shadowing: ${nullableString(shape.shadowing)},\n` +
        `      )`;
    });
    const expectedBoundaries = db.boundaries.map((boundary) => {
      const wrap = itemWrap(db.itemWrapState?.boundaries ?? [], boundary.alias);
      return `C4AndroidExpectedBoundary(\n` +
        `        alias: ${dartString(boundary.alias)},\n` +
        `        label: ${dartString(text(boundary.label))},\n` +
        `        type: ${dartString(text(boundary.type))},\n` +
        `        parentBoundary: ${dartString(boundary.parentBoundary ?? '')},\n` +
        `        kind: ${nullableString(boundary.kind)},\n` +
        `        description: ${dartString(text(boundary.descr))},\n` +
        `        technology: ${dartString(text(boundary.techn))},\n` +
        `        wrap: ${wrap},\n` +
        `        nodeType: ${nullableString(boundary.nodeType)},\n` +
        `        backgroundColor: ${nullableString(boundary.bgColor)},\n` +
        `        fontColor: ${nullableString(boundary.fontColor)},\n` +
        `        borderColor: ${nullableString(boundary.borderColor)},\n` +
        `        shadowing: ${nullableString(boundary.shadowing)},\n` +
        `      )`;
    });
    const expectedRelations = db.rels.map((relation) => {
      const relationState = (db.itemWrapState?.rels ?? []).find(
        (entry) => entry.from === relation.from && entry.to === relation.to,
      )?.value;
      const wrap = relationState === true || relationState === 'true';
      return `C4AndroidExpectedRelation(\n` +
        `        kind: ${dartString(relation.type)},\n` +
        `        from: ${dartString(relation.from)},\n` +
        `        to: ${dartString(relation.to)},\n` +
        `        label: ${dartString(text(relation.label))},\n` +
        `        technology: ${dartString(text(relation.techn))},\n` +
        `        description: ${dartString(text(relation.descr))},\n` +
        `        wrap: ${wrap},\n` +
        `        textColor: ${nullableString(relation.textColor)},\n` +
        `        lineColor: ${nullableString(relation.lineColor)},\n` +
        `        offsetX: ${relation.offsetX == null ? 'null' : relation.offsetX},\n` +
        `        offsetY: ${relation.offsetY == null ? 'null' : relation.offsetY},\n` +
        `      )`;
    });
    const expectedWrap = item.config?.wrap ?? true;
    return `  C4AndroidCase(\n` +
      `    id: ${dartString(item.id)},\n` +
      `    source: ${rawTriple(item.source)},\n` +
      `    kind: ${dartString(db.type)},\n` +
      `    title: ${nullableString(db.title)},\n` +
      `    expectedWrap: ${expectedWrap},\n` +
      `    shapeInRow: ${db.shapeInRow},\n` +
      `    boundaryInRow: ${db.boundaryInRow},\n` +
      `    expectedNodeAliases: ${list(db.shapes.map((shape) => shape.alias), (alias) => dartString(alias))},\n` +
      `    expectedNodes: ${list(expectedNodes, (entry) => entry)},\n` +
      `    expectedBoundaryAliases: ${list(db.boundaries.map((boundary) => boundary.alias), (alias) => dartString(alias))},\n` +
      `    expectedBoundaries: ${list(expectedBoundaries, (entry) => entry)},\n` +
      `    expectedRelations: ${list(expectedRelations, (entry) => entry)},\n` +
      `  )`;
  })
  .join(',\n');

const output = `// Generated by node apps/android/tool/parity/generate_c4_android_cases.mjs.
// Source: fixtures/mobile-parity/mermaid-c4-parser-expected.json
// SHA-256 of the exact source fixture bytes: ${fixtureSha256}

class C4AndroidCase {
  const C4AndroidCase({
    required this.id,
    required this.source,
    required this.kind,
    required this.title,
    required this.expectedWrap,
    required this.shapeInRow,
    required this.boundaryInRow,
    required this.expectedNodeAliases,
    required this.expectedNodes,
    required this.expectedBoundaryAliases,
    required this.expectedBoundaries,
    required this.expectedRelations,
  });

  final String id;
  final String source;
  final String kind;
  final String? title;
  final bool expectedWrap;
  final int shapeInRow;
  final int boundaryInRow;
  final List<String> expectedNodeAliases;
  final List<C4AndroidExpectedNode> expectedNodes;
  final List<String> expectedBoundaryAliases;
  final List<C4AndroidExpectedBoundary> expectedBoundaries;
  final List<C4AndroidExpectedRelation> expectedRelations;
}

class C4AndroidExpectedNode {
  const C4AndroidExpectedNode({
    required this.alias,
    required this.kind,
    required this.label,
    required this.parentBoundary,
    required this.customType,
    required this.technology,
    required this.description,
    required this.wrap,
    required this.backgroundColor,
    required this.fontColor,
    required this.borderColor,
    required this.shadowing,
  });

  final String alias;
  final String kind;
  final String label;
  final String parentBoundary;
  final String? customType;
  final String technology;
  final String description;
  final bool wrap;
  final String? backgroundColor;
  final String? fontColor;
  final String? borderColor;
  final String? shadowing;
}

class C4AndroidExpectedBoundary {
  const C4AndroidExpectedBoundary({
    required this.alias,
    required this.label,
    required this.type,
    required this.parentBoundary,
    required this.kind,
    required this.description,
    required this.technology,
    required this.wrap,
    required this.nodeType,
    required this.backgroundColor,
    required this.fontColor,
    required this.borderColor,
    required this.shadowing,
  });

  final String alias;
  final String label;
  final String type;
  final String parentBoundary;
  final String? kind;
  final String description;
  final String technology;
  final bool wrap;
  final String? nodeType;
  final String? backgroundColor;
  final String? fontColor;
  final String? borderColor;
  final String? shadowing;
}

class C4AndroidExpectedRelation {
  const C4AndroidExpectedRelation({
    required this.kind,
    required this.from,
    required this.to,
    required this.label,
    required this.technology,
    required this.description,
    required this.wrap,
    required this.textColor,
    required this.lineColor,
    required this.offsetX,
    required this.offsetY,
  });

  final String kind;
  final String from;
  final String to;
  final String label;
  final String technology;
  final String description;
  final bool wrap;
  final String? textColor;
  final String? lineColor;
  final int? offsetX;
  final int? offsetY;
}

const c4AndroidParserFixtureSha256 = '${fixtureSha256}';

const c4AndroidCases = <C4AndroidCase>[
${cases},
];
`;

await writeFile(outputPath, output);
process.stdout.write(
  `Wrote ${fixture.cases.length} C4 Android cases to ${outputPath} (fixture SHA-256 ${fixtureSha256})\n`,
);
