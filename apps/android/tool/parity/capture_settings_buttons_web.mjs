import { requireTestBrowserExecutable } from './test_browser.mjs';
// Compare actual pinned .button CSS in isolated, identical 390x140 frames.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
execFileSync(
  'git',
  ['diff', '--exit-code', 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c', '--', 'apps/web'],
  { cwd: root },
);
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const out = resolve(root, 'apps/android/build/parity/settings-buttons');
await mkdir(out, { recursive: true });
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  cacheDir: resolve(out, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18915,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'settings-buttons',
      configureServer(server) {
        server.middlewares.use('/buttons.html', async (_, res) => {
          const html =
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>:root{font-family:Arial!important}main{padding:24px}</style></head><body><main><button class="button">Save</button></main><script type="module">import "/src/app.css";window.captureReady=true;</script></body></html>';
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/buttons.html', html));
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const results = {};
  for (const theme of ['light', 'dark']) {
    for (const variant of ['ghost', 'filled', 'primary']) {
      for (const state of ['normal', 'hover', 'keyboard', 'disabled']) {
        const page = await browser.newPage({
          viewport: { width: 390, height: 140 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        });
        await page.goto('http://127.0.0.1:18915/buttons.html');
        await page.waitForFunction(() => window.captureReady);
        await page.locator('button').evaluate(
          (el, { variant, state }) => {
            el.className = 'button' + (variant === 'filled' ? '' : ' ' + variant);
            el.disabled = state === 'disabled';
          },
          { variant, state },
        );
        await page.mouse.move(0, 0);
        if (state === 'hover') await page.locator('button').hover();
        if (state === 'keyboard') await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        const id = `${variant}-${state}-${theme}`;
        results[id] = await page.locator('button').evaluate((el) => {
          const s = getComputedStyle(el),
            r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            background: s.backgroundColor,
            color: s.color,
            opacity: s.opacity,
            outline: s.outline,
            outlineOffset: s.outlineOffset,
            focusVisible: el.matches(':focus-visible'),
          };
        });
        await page.screenshot({ path: resolve(out, `web-${id}.png`) });
        await page.close();
      }
    }
  }
  await writeFile(resolve(out, 'web.json'), JSON.stringify(results, null, 2) + '\n');
} finally {
  await browser?.close();
  await server.close();
}
