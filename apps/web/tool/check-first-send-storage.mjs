// Production IndexedDB adapter, exercised in a dedicated Headless Shell/profile.
import { createServer } from '../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { requireTestBrowserExecutable } from '../../android/tool/parity/test_browser.mjs';
const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const temporary = await mkdtemp(join(tmpdir(), 'pirc-first-storage-'));
let server, context;
try {
  server = await createServer({
    root: join(root, 'apps/web'),
    cacheDir: join(temporary, 'vite-cache'),
    configFile: join(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'first-send-storage-check',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/storage-check.html') return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><script type="module">import {BrowserDraftStore} from "/src/lib/first-send-storage.ts";window.store=new BrowserDraftStore();</script>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/storage-check.html`;
  const options = { executablePath: requireTestBrowserExecutable(), headless: true };
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), options);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!window.store);
  await page.evaluate(async () => {
    await window.store.update('account-a', 'op', () => ({
      scope: 'account-a',
      ownerUser: 'alice',
      operationId: 'op',
      revision: 1,
      workspaceId: 'node:repo',
      message: 'saved before network',
      frozen: false,
      updatedAt: 1,
      files: [
        {
          id: 'f',
          name: 'reference.txt',
          mimeType: 'text/plain',
          byteSize: 12,
          blob: new Blob(['附件 bytes']),
        },
      ],
    }));
  });
  await page.reload();
  await page.waitForFunction(() => !!window.store);
  assert.deepEqual(
    await page.evaluate(async () => {
      const row = await window.store.get('account-a', 'op');
      return [
        row.message,
        await row.files[0].blob.text(),
        (await window.store.list('account-b')).length,
      ];
    }),
    ['saved before network', '附件 bytes', 0],
  );
  await page.evaluate(async () => {
    try {
      await window.store.update('account-a', 'op', () => {
        throw Error('synthetic abort');
      });
    } catch {}
  });
  assert.equal(
    await page.evaluate(async () => (await window.store.get('account-a', 'op')).revision),
    1,
  );
  const peer = await context.newPage();
  await peer.goto(url);
  await peer.waitForFunction(() => !!window.store);
  const edit = async (page, text) =>
    page.evaluate(async (text) => {
      try {
        await window.store.update('account-a', 'op', (row) => {
          if (row.revision !== 1) throw Error('stale');
          return { ...row, revision: 2, message: text };
        });
        return true;
      } catch {
        return false;
      }
    }, text);
  assert.equal(
    (await Promise.all([edit(page, 'tab one'), edit(peer, 'tab two')])).filter(Boolean).length,
    1,
  );
  await context.close();
  context = undefined;
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), options);
  const cold = await context.newPage();
  await cold.goto(url);
  await cold.waitForFunction(() => !!window.store);
  const recovered = await cold.evaluate(async () => {
    const row = await window.store.get('account-a', 'op');
    return { revision: row.revision, bytes: await row.files[0].blob.text() };
  });
  assert.deepEqual(recovered, { revision: 2, bytes: '附件 bytes' });
  console.log(
    'PASS: production IndexedDB preserves Blob bytes across reload/browser restart, isolates accounts, rolls back aborted writes, and serializes competing tabs.',
  );
} finally {
  await context?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
