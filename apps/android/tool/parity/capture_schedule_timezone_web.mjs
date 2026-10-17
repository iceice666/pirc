import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const path = 'apps/web/src/lib/components/ScheduleSettings.svelte';
execFileSync('git', ['diff', '--exit-code', revision, '--', path], { cwd: root });
const source = await readFile(resolve(root, path), 'utf8');
const markup = source.match(/<input\s+bind:value=\{form.timezone\}[^>]*>/)?.[0];
assert(markup?.includes('list="schedule-timezones"') && markup.includes('required'));
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: false });
try {
  const page = await browser.newPage();
  const cases = [];
  for (const scenario of [
    { name: 'exact Enter', value: 'Asia/Taipei', keys: ['Enter'] },
    { name: 'unlisted Enter', value: 'Europe/Paris', keys: ['Enter'] },
    { name: 'empty Enter', value: '', keys: ['Enter'] },
    { name: 'partial Enter', value: 'Asia', keys: ['Enter'] },
    { name: 'partial Down Enter', value: 'Asia', keys: ['ArrowDown', 'Enter'] },
    { name: 'partial Escape Enter', value: 'Asia', keys: ['Escape', 'Enter'] },
  ]) {
    await page.setContent('<form>'+markup.replace('bind:value={form.timezone}', '')+'<datalist id="schedule-timezones"><option value="Asia/Taipei"></option><option value="UTC"></option></datalist><button>Save</button></form>');
    await page.evaluate(() => { window.submissions = []; document.querySelector('form').onsubmit = e => { e.preventDefault(); window.submissions.push(document.querySelector('input').value); }; });
    await page.locator('input').fill(scenario.value);
    for (const key of scenario.keys) await page.keyboard.press(key);
    cases.push({...scenario, ...await page.evaluate(() => ({ value: document.querySelector('input').value, submissions: window.submissions }))});
  }
  console.log(JSON.stringify(cases));
  await writeFile(resolve(root,'fixtures/mobile-parity/schedule-timezone-keyboard.json'),JSON.stringify({revision,browser:browser.version(),headless:false,cases},null,2)+'\n');
} finally { await browser.close(); }
