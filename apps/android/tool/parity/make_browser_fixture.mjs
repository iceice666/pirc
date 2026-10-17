import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    await readFile(resolve(root, 'fixtures/mobile-parity/browser-page.html'), 'utf8'),
  );
  const jpeg = (await page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64');
  const f = {
    id: 'native-browser-panel',
    webRevision: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
    widths: [390, 420],
    height: 900,
    views: ['empty', 'agent', 'user', 'activity', 'replay', 'unavailable'],
    image: jpeg,
    state: {
      active: true,
      url: 'https://fixture.example/form',
      title: 'Native browser fixture',
      mode: 'agent',
      handoff: null,
      agentWaiting: false,
      action: null,
      recording: null,
      tabs: [
        {
          index: 0,
          url: 'https://fixture.example/form',
          title: 'Native browser fixture',
          active: true,
        },
        { index: 1, url: 'https://fixture.example/help', title: 'Help', active: false },
      ],
      viewport: { width: 640, height: 400 },
    },
    log: [
      {
        index: 1,
        at: 1790992800000,
        actor: 'agent',
        action: 'Navigate to fixture',
        url: 'https://fixture.example/form',
        image: true,
      },
      {
        index: 2,
        at: 1790992801000,
        actor: 'user',
        action: 'User took control',
        url: 'https://fixture.example/form',
        image: false,
      },
      {
        index: 3,
        at: 1790992802000,
        actor: 'user',
        action: 'User returned control',
        url: 'https://fixture.example/form',
        image: true,
      },
    ],
  };
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/browser.json'),
    JSON.stringify(f, null, 2) + '\n',
  );
} finally {
  await browser.close();
}
