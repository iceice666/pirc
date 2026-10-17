import { requireTestBrowserExecutable } from './test_browser.mjs';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [repo + '/apps/gateway'] }));
const browserExecutable = [requireTestBrowserExecutable(), chromium.executablePath()].find(existsSync);
if (!browserExecutable) throw new Error('No local Chrome/Chromium');
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
const origin = 'https://example.test';
const html = `<!doctype html><a id="sync" href="/default" onclick="location.assign('/script')">sync</a><a id="cancel" href="/default-cancel" onclick="location.assign('/script-cancel'); event.preventDefault()">cancel</a><a id="micro" href="/default-micro" onclick="Promise.resolve().then(() => location.assign('/script-after'))">micro</a>`;
const outcomes = [];
try {
  for (const id of ['sync', 'cancel', 'micro']) {
    const page = await browser.newPage();
    const requests = [];
    await page.route(origin + '/**', async (route) => {
      const request = route.request();
      requests.push(new URL(request.url()).pathname);
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await page.goto(origin + '/start', { waitUntil: 'domcontentloaded' });
    await page.locator('#' + id).click();
    const expected = {sync:'/default', cancel:'/script-cancel', micro:'/default-micro'}[id];
    await page.waitForURL(origin + expected);
    await page.waitForTimeout(100);
    assert.deepEqual(requests, ['/start', expected]);
    outcomes.push({ id, finalUrl: page.url(), requests });
    await page.close();
  }
  process.stdout.write(JSON.stringify({browserVersion:browser.version(), cases:outcomes}, null, 2) + '\n');
} finally {
  await browser.close();
}
