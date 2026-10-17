import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const path = 'apps/web/src/lib/components/Sidebar.svelte';
execFileSync('git', ['diff', '--exit-code', revision, '--', path], { cwd: root });
const source = await readFile(resolve(root, path), 'utf8');
assert.match(source, /bind:value=\{renameValue\}\s+maxlength="200"/);
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<input maxlength="200">');
  const cases = [];
  for (const entry of [
    { name: 'ascii', old: '', start: 0, end: 0, insert: 'a'.repeat(201) },
    { name: 'emoji', old: '', start: 0, end: 0, insert: '😀'.repeat(101) },
    { name: 'combining', old: '', start: 0, end: 0, insert: 'e\u0301'.repeat(101) },
    { name: 'surrogate boundary', old: 'a'.repeat(199), start: 199, end: 199, insert: '😀x' },
    { name: 'middle insertion', old: 'a'.repeat(198)+'Z', start: 1, end: 1, insert: 'XYZ' },
    { name: 'selection replacement', old: 'a'.repeat(198)+'ZZ', start: 1, end: 3, insert: 'XYZQ' },
    { name: 'combining boundary', old: 'a'.repeat(199), start: 199, end: 199, insert: 'e\u0301' },
  ]) {
    await page.locator('input').evaluate((el, v) => { el.value = v.old; el.focus(); el.setSelectionRange(v.start, v.end); }, entry);
    await page.keyboard.insertText(entry.insert);
    cases.push({ ...entry, ...await page.locator('input').evaluate(el => ({ value: el.value, selection: el.selectionStart })) });
  }
  await writeFile(resolve(root, 'fixtures/mobile-parity/session-rename-length.json'), JSON.stringify({ revision, browser: browser.version(), cases }, null, 2)+'\n');
  console.log(cases.map(x => ({name:x.name,length:x.value.length,selection:x.selection})));
} finally { await browser.close(); }
