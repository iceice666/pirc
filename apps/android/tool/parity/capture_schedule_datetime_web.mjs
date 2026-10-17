import { requireTestBrowserExecutable } from './test_browser.mjs';
// Extract the pinned datetime-local input and record its value/validity rules.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const path = 'apps/web/src/lib/components/ScheduleSettings.svelte';
execFileSync('git', ['diff', '--exit-code', revision, '--', path], { cwd: root });
const source = await readFile(resolve(root, path), 'utf8');
const input = source.match(/<input type="datetime-local"[^>]*>/)?.[0];
assert.equal(input, '<input type="datetime-local" bind:value={form.at} required />');
const values = [
  '',
  '2026-11-05T09:30',
  '2026-11-05 09:30',
  '2026-11-05T09:30:00',
  '2026-11-05T09:30:01',
  '2026-11-05T09:30:00.001',
  '2026-11-05T09:30:00.000',
  '2024-02-29T12:00',
  '2026-02-29T12:00',
  '2000-02-29T12:00',
  '1900-02-29T12:00',
  '2026-04-31T12:00',
  '2026-00-01T00:00',
  '2026-13-01T00:00',
  '2026-01-00T00:00',
  '2026-01-01T24:00',
  '2026-01-01T12:60',
  '2026-1-1T09:30',
  '0000-01-01T00:00',
  '0001-01-01T00:00',
  '10000-01-01T00:00',
  '00001-01-01T00:00',
  '275760-09-13T00:00',
  '275760-09-13T00:01',
  '275761-01-01T00:00',
  '2026-11-05T09:30Z',
  '2026-11-05T09:30+08:00',
  ' 2026-11-05T09:30 ',
  '2026-11-05t09:30',
];
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    isMobile: true,
    hasTouch: true,
  });
  await page.setContent(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      input.replace(' bind:value={form.at}', ''),
  );
  const cases = await page.locator('input').evaluate(
    (el, values) =>
      values.map((value) => {
        el.value = value;
        return {
          input: value,
          value: el.value,
          valid: el.validity.valid,
          stepMismatch: el.validity.stepMismatch,
        };
      }),
    values,
  );
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/schedule-datetime.json'),
    JSON.stringify({ webRevision: revision, source: path, cases }, null, 2) + '\n',
  );
  const out = resolve(root, 'apps/android/build/parity/schedule-picker');
  await mkdir(out, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({
    content:
      'body{margin:24px;font-family:Arial}input{box-sizing:border-box;width:342px;height:40px;font:16px Arial}',
  });
  await page.locator('input').evaluate((el) => (el.value = '2026-11-05T09:30'));
  await page.locator('input').click({ position: { x: 330, y: 20 } });
  await page.screenshot({ path: resolve(out, 'web-open-light.png') });
  await writeFile(resolve(out, 'web-dom.txt'), await page.locator('body').ariaSnapshot());
  console.log(`${cases.length} constraint cases; picker screenshot captured`);
} finally {
  await browser.close();
}
