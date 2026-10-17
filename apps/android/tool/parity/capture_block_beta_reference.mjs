import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { diagram as blockDiagram } from '../../../../apps/web/node_modules/mermaid/dist/chunks/mermaid.core/blockDiagram-I7D4REHJ.mjs';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const webSha = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--quiet', webSha, '--', 'apps/web/src', 'apps/web/package.json'], {
  cwd: root,
});
const dependency = JSON.parse(
  await readFile(path.join(root, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
assert.equal(dependency.version, '11.17.2');

const cases = [
  {
    id: 'columns-shapes',
    source: `block-beta
columns 4
a["Alpha"] b("Beta") c(("Circle")) d{"Decision"}`,
  },
  {
    id: 'spans-and-space',
    source: `block-beta
columns 3
wide["Wide"]:2 space:1 tail["Tail"]`,
  },
  {
    id: 'nested-columns',
    source: `block-beta
columns 2
block:group
columns 2
a["A"] b["B"]
end
c["C"]`,
  },
  {
    id: 'labeled-and-styled-arrows',
    source: `block-beta
a["Start"] -- "labeled" --> b["End"]
b ==x c
c -.-> d`,
  },
  {
    id: 'extended-shapes',
    source: `block-beta
a[["Subroutine"]] b{{"Hexagon"}} c(["Stadium"]) d[("Cylinder")]`,
  },
];

const parser = blockDiagram.parser.parser;
const sourceVersion = 'mermaid@11.17.2';
const silence = { debug() {} };

for (const item of cases) {
  let ast;
  let generatedId = 0;
  parser.yy = {
    ...blockDiagram.db,
    getLogger: () => silence,
    setHierarchy: (value) => {
      ast = value;
    },
    generateId: () => `generated-${++generatedId}`,
  };
  parser.parse(item.source);
  item.parserAst = ast;
}

const outputPath = fileURLToPath(
  new URL('../../../../fixtures/mobile-parity/mermaid-block-beta-reference.json', import.meta.url),
);
await writeFile(
  outputPath,
  `${JSON.stringify({ webSha, sourceVersion, cases }, null, 2)}\n`,
  'utf8',
);
console.log(`Wrote ${cases.length} block-beta parser references to ${path.resolve(outputPath)}`);
