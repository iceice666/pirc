/**
 * Writes target/injected.js: Playwright's injected script (the in-page half
 * of locators and aria snapshots), copied out of playwright-core's bundle.
 * playwright-core is Apache-2.0; a real port pins and embeds this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const bundle = readFileSync(
  path.join(import.meta.dir, '../../apps/gateway/node_modules/playwright-core/lib/coreBundle.js'),
  'utf8',
);
const start = bundle.indexOf("source4 = '", bundle.indexOf('generated/injectedScriptSource.ts'));
if (start < 0) throw new Error('injected script source not found');
let end = start + "source4 = '".length;
while (bundle[end] !== "'") end += bundle[end] === '\\' ? 2 : 1;
const source = (0, eval)(bundle.slice(start + 'source4 = '.length, end + 1)) as string;
mkdirSync(path.join(import.meta.dir, 'target'), { recursive: true });
writeFileSync(path.join(import.meta.dir, 'target/injected.js'), source);
console.log(`target/injected.js: ${source.length} bytes`);
