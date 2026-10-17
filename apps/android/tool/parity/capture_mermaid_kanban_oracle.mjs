import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const webSha = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--quiet', webSha, '--', 'apps/web/src', 'apps/web/package.json'], {
  cwd: root,
});

const packageJson = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
if (packageJson.version !== '11.17.2') {
  throw new Error(`Expected pinned Mermaid 11.17.2; found ${packageJson.version}`);
}

const purifyPath = resolve(
  root,
  'node_modules/.bun/dompurify@3.4.16/node_modules/dompurify/dist/purify.es.mjs',
);
const purify = (await import(pathToFileURL(purifyPath).href)).default;
// This oracle passes plain fixture strings to Mermaid's real parser and DB.
// The installed DOMPurify package has no DOM in Node, so keep sanitization an
// identity operation for these text-only parser inputs.
purify.addHook = () => {};
purify.sanitize = (value) => value;

const mermaid = (
  await import(
    pathToFileURL(resolve(root, 'apps/web/node_modules/mermaid/dist/mermaid.core.mjs')).href
  )
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

const { diagram } = await import(
  pathToFileURL(
    resolve(
      root,
      'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/kanban-definition-UXKFOSKX.mjs',
    ),
  ).href
);
const cases = [
  {
    id: 'columns-and-cards',
    source: [
      'kanban',
      '  Backlog',
      '    task-1[Write parser tests]',
      '    task-2[Review the fixture]',
      '  In progress',
      '    task-3[Render the cards]',
      '  Done',
      '    task-4[Ship the change]',
    ].join('\n'),
  },
  {
    id: 'ticket-assignee-priority-and-label-override',
    source: [
      'kanban',
      '  Active',
      '    upload[Verify upload]@{ticket: APP-12, assigned: Lee, priority: Very High}',
      '    review[Original label]@{label: Review the patch, ticket: APP-18, assigned: Pat, priority: Medium}',
      '    cleanup[Trim toolbar]@{priority: Low}',
      '    plain[Unprioritized]@{ticket: APP-20, assigned: Ren}',
    ].join('\n'),
  },
  {
    id: 'empty-column-and-deep-item-indent',
    source: [
      'kanban',
      '  Icebox column title that wraps onto a second line',
      '  Ready',
      '        card[Six-space child]',
      '    card-2[Two-space child]',
    ].join('\n'),
  },
  {
    id: 'multiline-description',
    source: [
      'kanban',
      '  Doing column heading that wraps onto a second line',
      '    long[First line',
      ' second **bold** line<br/>',
      ' third `code` line',
      ' fourth line]',
      '    next[Next card]',
    ].join('\n'),
  },
  {
    id: 'card-shape-delimiters',
    source: [
      'kanban',
      '  Shapes',
      '    round(rounded card)',
      '    circle((circular card))',
      '    hex{{hexagonal card}}',
      '    rect[rectangular card]',
    ].join('\n'),
  },
];

function snapshotNode(node) {
  return Object.fromEntries(
    [
      'id',
      'parentId',
      'label',
      'labelType',
      'isGroup',
      'ticket',
      'priority',
      'assigned',
      'icon',
      'shape',
      'level',
      'rx',
      'ry',
      'look',
      'width',
      'height',
    ]
      .filter((key) => key in node)
      .map((key) => [key, node[key]]),
  );
}

for (const item of cases) {
  diagram.db.clear();
  diagram.parser.yy = diagram.db;
  diagram.parser.parse(item.source);
  item.expectedNodes = diagram.db.getData().nodes.map(snapshotNode);
}

const fixture = {
  webSha,
  mermaidVersion: packageJson.version,
  oracle:
    'Pinned Mermaid Kanban Jison parser and kanbanDb.getData; DOMPurify is identity-stubbed for plain parser fixtures. This is parser/DB evidence, not rendered-SVG geometry.',
  cases,
};
const output = resolve(root, 'fixtures/mobile-parity/mermaid-kanban.json');
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`Wrote ${cases.length} actual parser/DB cases to ${output}\n`);
