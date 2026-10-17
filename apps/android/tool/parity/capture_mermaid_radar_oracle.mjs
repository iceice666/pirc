import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const inputPath = path.join(repoRoot, 'fixtures/mobile-parity/mermaid-important-cases.json');
const outputPath = path.join(repoRoot, 'fixtures/mobile-parity/mermaid-radar-oracle.json');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const radarCases = input.cases.filter((item) => item.id?.startsWith('radar-'));
const modulePath = pathToFileURL(
  path.join(
    repoRoot,
    'apps/web/node_modules/mermaid/dist/chunks/mermaid.core/diagram-UQ7AKVKN.mjs',
  ),
).href;
const { diagram } = await import(modulePath);

const cases = [];
for (const item of radarCases) {
  diagram.db.clear();
  await diagram.parser.parse(item.source);
  cases.push({
    id: item.id,
    source: item.source,
    expected: {
      title: diagram.db.getDiagramTitle(),
      accessibleTitle: diagram.db.getAccTitle(),
      accessibleDescription: diagram.db.getAccDescription(),
      axes: diagram.db.getAxes(),
      curves: diagram.db.getCurves(),
      options: diagram.db.getOptions(),
      config: diagram.db.getConfig(),
    },
  });
}

const mermaidPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
const oracle = {
  baselineCommit: input.baselineCommit,
  mermaidVersion: mermaidPackage.version,
  source: 'pinned Mermaid radar parser and DB; parser metadata only, no browser rendering',
  cases,
};
writeFileSync(outputPath, `${JSON.stringify(oracle, null, 2)}\n`);
console.log(`Wrote ${cases.length} Mermaid ${mermaidPackage.version} radar parser cases to ${path.relative(repoRoot, outputPath)}`);
