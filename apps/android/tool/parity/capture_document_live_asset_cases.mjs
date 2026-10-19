import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { requireTestBrowserExecutable } from './test_browser.mjs';
import { readAssetState } from './document_live_assets_fixture.mjs';
export async function captureLiveAssetCases(
  { assetHTML, assetCSS, assetEntry, assetDep, assetPng, secondFetchPng, startupAssetHTML },
  { outputURL, imagePath = '/photo.png', imageMime = 'image/png' },
) {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  const browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  try {
    assert.equal(browser.version(), '153.0.8010.12');
    const cases = [];
    for (const viewport of [
      { width: 390, height: 796 },
      { width: 768, height: 976 },
    ])
      for (const dpr of [1, 3])
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: dpr,
            colorScheme: theme,
          });
          try {
            const pending = new Map(),
              requests = [],
              errors = [];
            await context.route('**/*', (r) => {
              const p = new URL(r.request().url()).pathname;
              requests.push(p);
              if (p === '/test') return r.fulfill({ contentType: 'text/html', body: assetHTML });
              pending.set(p, r);
            });
            const page = await context.newPage();
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto('https://assets.example/test');
            async function request(path) {
              for (let i = 0; i < 10000 && !pending.has(path); i++)
                await new Promise((r) => setTimeout(r, 1));
              assert.ok(pending.has(path), path);
              return pending.get(path);
            }
            async function capture(phase, pixels = false) {
              const state = await page.evaluate(readAssetState);
              if (pixels) {
                state.points = [];
                for (const rect of [state.photo, state.canvas])
                  for (const [x, y] of [
                    [4, 4],
                    [28, 4],
                    [4, 28],
                    [28, 28],
                  ])
                    state.points.push([rect[0] + x, rect[1] + y]);
                const screenshot = await page.screenshot();
                state.pixels = await page.evaluate(
                  async ({ data, points, dpr }) => {
                    const bitmap = await createImageBitmap(
                      new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
                        type: 'image/png',
                      }),
                    );
                    const canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    const c = canvas.getContext('2d');
                    c.drawImage(bitmap, 0, 0);
                    bitmap.close();
                    return points.map(([x, y]) =>
                      Array.from(
                        c.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data,
                      ),
                    );
                  },
                  { data: screenshot.toString('base64'), points: state.points, dpr },
                );
              }
              return { phase, ...state };
            }
            const states = [await capture('initial')];
            await page.locator('#draft').fill('草稿🙂');
            await page.locator('#style').click();
            await (
              await request('/theme.css')
            ).fulfill({ contentType: 'text/css', body: assetCSS });
            await page.waitForFunction(() => probe.style === 1);
            states.push(await capture('style'));
            await page.locator('#image').click();
            await (
              await request(imagePath)
            ).fulfill({
              contentType: imageMime,
              headers: { 'cache-control': 'no-store' },
              body: Buffer.from(assetPng, 'base64'),
            });
            await page.waitForFunction(() => probe.image === 1);
            states.push(await capture('image', true));
            await page.locator('#module').click();
            await (
              await request('/entry.js')
            ).fulfill({ contentType: 'application/javascript', body: assetEntry });
            await (
              await request('/dep.js')
            ).fulfill({ contentType: 'application/javascript', body: assetDep });
            await page.waitForFunction(() => probe.runs === 1);
            states.push(await capture('module', true));
            await page.locator('#module').click();
            await page.waitForFunction(() => probe.runs === 2);
            states.push(await capture('cached', true));
            assert.deepEqual(errors, []);
            assert.deepEqual(requests, ['/test', '/theme.css', imagePath, '/entry.js', '/dep.js']);
            const startup = await context.newPage();
            let startupImages = 0;
            await startup.route('**/*', (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === imagePath) {
                startupImages++;
                return route.fulfill({
                  contentType: imageMime,
                  headers: { 'cache-control': 'no-store' },
                  body: Buffer.from(assetPng, 'base64'),
                });
              }
              return route.fulfill({ contentType: 'text/html', body: startupAssetHTML });
            });
            await startup.goto('https://assets.example/test');
            await startup.waitForFunction(() => probe.image === 1);
            const startupState = await startup.evaluate(readAssetState);
            startupState.points = [];
            for (const rect of [startupState.photo, startupState.canvas])
              for (const [x, y] of [
                [4, 4],
                [28, 4],
                [4, 28],
                [28, 28],
              ])
                startupState.points.push([rect[0] + x, rect[1] + y]);
            const startupPng = await startup.screenshot();
            startupState.pixels = await startup.evaluate(
              async ({ data, points, dpr }) => {
                const bitmap = await createImageBitmap(
                  new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
                    type: 'image/png',
                  }),
                );
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext('2d');
                context.drawImage(bitmap, 0, 0);
                bitmap.close();
                return points.map(([x, y]) =>
                  Array.from(
                    context.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data,
                  ),
                );
              },
              { data: startupPng.toString('base64'), points: startupState.points, dpr },
            );
            assert.equal(startupImages, 1);
            cases.push({ viewport, dpr, theme, states, startup: startupState });
          } finally {
            await context.close();
          }
        }
    await writeFile(
      outputURL,
      JSON.stringify(
        {
          browserVersion: browser.version(),
          html: assetHTML,
          startupHtml: startupAssetHTML,
          css: assetCSS,
          entry: assetEntry,
          dep: assetDep,
          ...(imageMime === 'image/png' ? { png: assetPng } : { imageBase64: assetPng }),
          imagePath,
          imageMime,
          secondFetchPng,
          cases,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`${cases.length} live asset profiles captured`);
  } finally {
    await browser.close();
  }
}
