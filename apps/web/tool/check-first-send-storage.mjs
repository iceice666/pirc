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
              '<!doctype html><script type="module">import {BrowserDraftStore} from "/src/lib/first-send-storage.ts";import {FirstSend} from "/src/lib/first-send.ts";window.store=new BrowserDraftStore();window.flow=new FirstSend(window.store,{});</script>',
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
  // Keep an actual version-1 connection open: refusal must preserve legacy
  // bytes, and closing it must allow a non-destructive version-2 upgrade.
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('pirc-first-send-v1', 1);
      r.onupgradeneeded = () =>
        r.result
          .createObjectStore('drafts', { keyPath: ['scope', 'operationId'] })
          .createIndex('scope', 'scope');
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put({
      scope: 'account-a',
      ownerUser: 'alice',
      operationId: 'legacy',
      revision: 3,
      workspaceId: 'node:repo',
      message: 'legacy input',
      frozen: true,
      stopCommandId: 'saved-stop',
      pendingStopControl: { clientId: 'old', generation: 8 },
      files: [{ id: 'old-file', blob: new Blob(['legacy bytes']) }],
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.onversionchange = () => {};
    window.legacyDb = db;
  });
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.store.update('account-a', 'must-not-exist', () => {
          throw Error('must not write');
        });
        return 'unexpected success';
      } catch (e) {
        return e.message;
      }
    }),
    /Close older pirc tabs/,
  );
  await page.evaluate(() => window.legacyDb.close());
  assert.deepEqual(
    await page.evaluate(async () => {
      const row = await window.store.get('account-a', 'legacy');
      return [
        row.message,
        await row.files[0].blob.text(),
        row.stopCommandId,
        row.pendingStopControl.generation,
        (await window.store.get('account-a', 'must-not-exist')) ?? null,
      ];
    }),
    ['legacy input', 'legacy bytes', 'saved-stop', 8, null],
  );
  assert.equal(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('pirc-first-send-v1', 1);
          r.onerror = (event) => {
            event.preventDefault();
            resolve(r.error.name);
          };
          r.onsuccess = () => {
            r.result.close();
            resolve('unexpected open');
          };
        }),
    ),
    'VersionError',
  );
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
  // Two actual pages share the production store. Preserve a stale editor's
  // selection after its peer freezes the immutable source, without a transport.
  const peerOriginalText = await peer.evaluate(
    async () => (await window.store.get('account-a', 'op')).message,
  );
  await page.evaluate(async () => {
    window.editor = await window.store.get('account-a', 'op');
    window.editor.message = 'Unsent editor text';
    window.editor.files.push({
      id: 'new-file',
      name: 'new.txt',
      mimeType: 'text/plain',
      byteSize: 9,
      blob: new Blob(['new bytes']),
    });
  });
  await peer.evaluate(async () =>
    window.store.update('account-a', 'op', (row) => ({
      ...row,
      frozen: true,
      revision: row.revision + 1,
    })),
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.flow.save('account-a', 'alice', 'op', window.editor, 2);
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  const recoveredId = await page.evaluate(async () => {
    const copy = await window.flow.recoverEdits(window.editor, window.editor);
    window.recoveredId = copy.operationId;
    return copy.operationId;
  });
  assert.notEqual(recoveredId, 'op');
  assert.deepEqual(
    await peer.evaluate(async (id) => {
      const copy = await window.store.get('account-a', id),
        original = await window.store.get('account-a', 'op');
      return [
        copy.message,
        await copy.files[0].blob.text(),
        await copy.files[1].blob.text(),
        copy.frozen,
        copy.recoveredFrom,
        original.message,
      ];
    }, recoveredId),
    ['Unsent editor text', '附件 bytes', 'new bytes', false, 'op', peerOriginalText],
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
  assert.deepEqual(recovered, { revision: 3, bytes: '附件 bytes' });
  assert.deepEqual(
    await cold.evaluate(async (id) => {
      const copy = await window.store.get('account-a', id);
      return [copy.message, await copy.files[1].blob.text(), copy.recoveredFrom];
    }, recoveredId),
    ['Unsent editor text', 'new bytes', 'op'],
  );
  console.log(
    'PASS: production IndexedDB upgrades legacy rows/Blobs without loss, rejects old writers, preserves Blob bytes across reload/browser restart, isolates accounts, rolls back aborted writes, serializes competing tabs, and retains unsent conflict text/Blobs through a real peer freeze and browser restart.',
  );
} finally {
  await context?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
