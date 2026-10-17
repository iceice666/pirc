// node apps/android/tool/parity/capture_mermaid_requirement_oracle.mjs
// Captures the pinned Mermaid requirement parser DB before SVG layout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const webRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--quiet', webRevision, '--', 'apps/web/src', 'apps/web/package.json'], {
  cwd: root,
});

const mermaidRoot = resolve(root, 'apps/web/node_modules/mermaid');
const packageJson = JSON.parse(await readFile(resolve(mermaidRoot, 'package.json'), 'utf8'));
assert.equal(packageJson.version, '11.17.2', 'expected pinned Mermaid 11.17.2');

const purifyPath = resolve(
  root,
  'node_modules/.bun/dompurify@3.4.16/node_modules/dompurify/dist/purify.es.mjs',
);
const purify = (await import(pathToFileURL(purifyPath).href)).default;
// Node has no browser DOM. This identity stub is parser-only evidence; Chrome
// captures use the real production sanitizer and Markdown initialization.
purify.addHook = () => {};
purify.sanitize = (value) => value;

const mermaid = (
  await import(pathToFileURL(resolve(mermaidRoot, 'dist/mermaid.core.mjs')).href)
).default;
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

const cases = [
  {
    id: 'basic-requirement-element-satisfies',
    description: 'One requirement, one element, all common fields, and a satisfying relationship.',
    source: [
      'requirementDiagram',
      'requirement SignIn {',
      'id: REQ1',
      'text: The service shall authenticate each user.',
      'risk: high',
      'verifyMethod: test',
      '}',
      'element Gateway {',
      'type: service',
      'docRef: API1',
      '}',
      'Gateway - satisfies -> SignIn',
    ].join('\n'),
  },
  {
    id: 'all-requirement-types-risks-verification-methods',
    description: 'All six requirement types, all risk levels, and all verification methods.',
    source: [
      'requirementDiagram',
      'requirement General {',
      'id: R1',
      'text: General constraint.',
      'risk: low',
      'verifyMethod: analysis',
      '}',
      'functionalRequirement Functional {',
      'id: R2',
      'text: Functional behavior.',
      'risk: medium',
      'verifyMethod: demonstration',
      '}',
      'interfaceRequirement Interface {',
      'id: R3',
      'text: Interface contract.',
      'risk: high',
      'verifyMethod: inspection',
      '}',
      'performanceRequirement Performance {',
      'id: R4',
      'text: Latency bound.',
      'risk: low',
      'verifyMethod: test',
      '}',
      'physicalRequirement Physical {',
      'id: R5',
      'text: Physical dimensions.',
      'risk: medium',
      'verifyMethod: analysis',
      '}',
      'designConstraint Design {',
      'id: R6',
      'text: Design constraint.',
      'risk: high',
      'verifyMethod: test',
      '}',
    ].join('\n'),
  },
  {
    id: 'all-relations-forward-reverse',
    description: 'All seven relationship types, with right-facing and left-facing source arrows.',
    source: [
      'requirementDiagram',
      'requirement R1 {',
      'id: R1',
      'text: Top level.',
      '}',
      'requirement R2 {',
      'id: R2',
      'text: Derived level.',
      '}',
      'requirement R3 {',
      'id: R3',
      'text: Trace target.',
      '}',
      'element E1 {',
      'type: service',
      'docRef: E1REF',
      '}',
      'element E2 {',
      'type: client',
      'docRef: E2REF',
      '}',
      'R1 - contains -> R2',
      'R2 <- copies - R1',
      'R2 - derives -> E1',
      'E1 <- satisfies - R1',
      'R1 - verifies -> E2',
      'E2 <- refines - R2',
      'E2 - traces -> R3',
    ].join('\n'),
  },
  {
    id: 'direction-lr-disconnected-nodes',
    description: 'Left-to-right layout direction and disconnected requirement/element nodes.',
    source: [
      'requirementDiagram',
      'direction LR',
      'requirement Left {',
      'id: LEFT',
      'text: Connected source.',
      '}',
      'element Processor {',
      'type: service',
      'docRef: PROC1',
      '}',
      'requirement Right {',
      'id: RIGHT',
      'text: Connected target.',
      '}',
      'requirement Isolated {',
      'id: SOLO',
      'text: This node has no relationships.',
      '}',
      'Processor - satisfies -> Left',
    ].join('\n'),
  },
  {
    id: 'long-quoted-html-entities-accessibility',
    description: 'Long quoted field text, escaped quotes, HTML/entity source text, and accessibility metadata.',
    source: [
      'requirementDiagram',
      'accTitle: Extended authentication requirements',
      'accDescr {',
      'A multiline accessibility description for the long requirement diagram.',
      'It preserves an &amp; entity and literal <b>HTML</b> input.',
      '}',
      'functionalRequirement LongLabel {',
      'id: REQLONG',
      'text: "The service shall preserve a deliberately long quoted statement with an &amp; entity, literal <b>HTML</b>, and &quot;quoted words&quot; for inspection across multiple rendered lines."',
      'risk: medium',
      'verifyMethod: inspection',
      '}',
      'element LongService {',
      'type: "A deliberately long service type label"',
      'docRef: DOCLONG',
      '}',
      'LongService - satisfies -> LongLabel',
    ].join('\n'),
  },
  {
    id: 'classes-styles-duplicates-default-class',
    description: '::: classes, class/classDef/style statements, default styles, duplicate fields, and duplicate names.',
    source: [
      'requirementDiagram',
      'classDef default fill:#fff1cc,stroke:#92400e,color:#1f2937',
      'requirement PlainDefault {',
      'id: DEFAULT',
      'text: Default class probe.',
      '}',
      'requirement R {',
      'id: FIRST',
      'id: SECOND',
      'text: First field value.',
      'text: Second field value.',
      'risk: low',
      'risk: high',
      '}',
      'requirement R {',
      'id: REPLACEMENT',
      'text: Duplicate name value.',
      '}',
      'element E {',
      'type: first',
      'type: second',
      'docRef: FIRSTREF',
      'docRef: SECONDREF',
      '}',
      'element E {',
      'type: duplicate',
      '}',
      'requirement Urgent:::hot {',
      'id: URGENT',
      'text: Urgent requirement.',
      '}',
      'element Worker:::cool {',
      'type: processor',
      'docRef: WORKERREF',
      '}',
      'class R,E hot',
      'style R fill:#dbeafe,stroke:#1d4ed8,color:#123456',
      'classDef hot fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d',
      'classDef cool fill:#dcfce7,stroke:#15803d,color:#14532d',
      'R - satisfies -> E',
    ].join('\n'),
  },
];

const invalidCases = [
  {
    id: 'invalid-risk-value',
    description: 'A risk value outside Mermaid’s low/medium/high grammar.',
    source: [
      'requirementDiagram',
      'requirement InvalidRisk {',
      'id: RISK1',
      'text: Invalid risk.',
      'risk: critical',
      'verifyMethod: test',
      '}',
    ].join('\n'),
  },
  {
    id: 'invalid-unclosed-requirement',
    description: 'A requirement body without its closing brace.',
    source: [
      'requirementDiagram',
      'requirement Unclosed {',
      'id: OPEN1',
      'text: Missing the closing brace.',
    ].join('\n'),
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function captureDb(db) {
  const requirements = [...db.getRequirements().entries()];
  const elements = [...db.getElements().entries()];
  const relations = db.getRelationships();
  const classes = [...db.getClasses().entries()];
  const raw = {
    requirements: clone(requirements),
    elements: clone(elements),
    relations: clone(relations),
    direction: db.getDirection() ?? null,
    title: db.getDiagramTitle() ?? '',
    accTitle: db.getAccTitle() ?? '',
    accDescription: db.getAccDescription() ?? '',
    classes: clone(classes),
  };

  // getData is Mermaid’s actual adapter input to layout. Keep only the graph
  // projection; the resolved Mermaid config is global and can be large.
  const data = db.getData();
  return {
    raw,
    graphData: {
      nodes: clone(data.nodes),
      edges: clone(data.edges),
      other: clone(data.other),
      direction: data.direction ?? null,
    },
    enumerations: {
      requirementTypes: clone(db.RequirementType),
      risks: clone(db.RiskLevel),
      verificationMethods: clone(db.VerifyType),
      relationships: clone(db.Relationships),
    },
  };
}

async function parseCase(item) {
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(item.source);
    return {
      accepted: true,
      diagramType: diagram.type ?? null,
      db: captureDb(diagram.db),
    };
  } catch (error) {
    return {
      accepted: false,
      errorName: error instanceof Error ? error.name : 'Error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

for (const item of cases) {
  item.parser = await parseCase(item);
  assert.equal(item.parser.accepted, true, 'valid corpus case rejected: ' + item.id + ': ' + item.parser.error);
}

for (const item of invalidCases) {
  item.parser = await parseCase(item);
  assert.equal(item.parser.accepted, false, 'invalid corpus case accepted: ' + item.id);
}

// The lexer recognizes a title token, but Mermaid 11.17.2’s generated
// requirement parser has no title terminal/action. Preserve that real grammar
// limitation as an explicit probe instead of silently treating title syntax
// as a valid corpus field.
const titleProbe = {
  source: 'requirementDiagram\ntitle Requirement diagram title',
};
titleProbe.parser = await parseCase(titleProbe);
assert.equal(titleProbe.parser.accepted, false, 'requirement title unexpectedly became valid');
const escapedQuoteProbe = {
  source: [
    'requirementDiagram',
    'requirement EscapedQuote {',
    'id: ESC1',
    'text: "A requirement field with \\"escaped quotes\\"."',
    '}',
  ].join('\n'),
};
escapedQuoteProbe.parser = await parseCase(escapedQuoteProbe);
assert.equal(
  escapedQuoteProbe.parser.accepted,
  false,
  'escaped quoted-string syntax unexpectedly became valid',
);

const fixture = {
  fixture: 'mermaid-requirement-parser-v1',
  webRevision,
  mermaidVersion: packageJson.version,
  requirementChunk: 'dist/chunks/mermaid.core/requirementDiagram-BXWQKSXE.mjs',
  oracle:
    'Pinned Mermaid requirement parser, RequirementDB raw maps, and RequirementDB.getData graph projection before SVG layout. Production light initialization is copied from apps/web/src/lib/markdown.ts. Node DOMPurify is identity-stubbed only for parser input; Chrome captures use the real production Markdown, sanitizer, CSS, and color-scheme initialization.',
  parserInitialization: {
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    directionDefault: 'TB from RequirementDB initialization',
  },
  databaseProjection: [
    'requirements',
    'elements',
    'relations',
    'direction',
    'title',
    'accTitle',
    'accDescription',
    'classes',
  ],
  cases,
  invalidCases,
  knownGrammarLimits: {
    title: {
      source: titleProbe.source,
      accepted: titleProbe.parser.accepted,
      errorName: titleProbe.parser.errorName,
      error: titleProbe.parser.error,
      note:
        'The requirement lexer recognizes title syntax, but its generated parser rejects it. RequirementDB.getDiagramTitle() is captured as the actual empty string in valid cases.',
    },
    escapedQuotes: {
      source: escapedQuoteProbe.source,
      accepted: escapedQuoteProbe.parser.accepted,
      errorName: escapedQuoteProbe.parser.errorName,
      error: escapedQuoteProbe.parser.error,
      note:
        'Requirement values may be quoted, but backslash-escaped quote characters are rejected by this parser. The valid rich-text case uses the supported &quot; entity.',
    },
  },
};

const output = resolve(root, 'fixtures/mobile-parity/mermaid-requirement-parser-expected.json');
await writeFile(output, JSON.stringify(fixture, null, 2) + '\n');
process.stdout.write(
  'Wrote ' +
    cases.length +
    ' actual requirement parser/DB cases, ' +
    invalidCases.length +
    ' parser errors, and one unsupported-title probe to ' +
    output +
    '\n',
);
