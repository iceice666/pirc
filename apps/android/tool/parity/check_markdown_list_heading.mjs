import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { marked } from '../../../web/node_modules/marked/lib/marked.esm.js';
const root = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(
  readFileSync(resolve(root, 'fixtures/mobile-parity/markdown-list-heading.json'), 'utf8'),
);
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web'], { cwd: root });
const installed = JSON.parse(
  readFileSync(resolve(root, 'apps/web/node_modules/marked/package.json'), 'utf8'),
).version;
assert.equal(installed, fixture.markedVersion);
for (const row of fixture.cases) {
  assert.equal(marked.parse(row.source), row.html, row.id);
  assert.equal(marked.lexer(row.source)[0].loose, row.loose, row.id);
}
console.log(`${fixture.cases.length} pinned Marked ${installed} list cases passed`);
