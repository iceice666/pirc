import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const path = 'apps/web/src/lib/components/panel/BrowserTab.svelte';
execFileSync('git', ['diff', '--exit-code', revision, '--', path], { cwd: root });
assert.match(
  await readFile(resolve(root, path), 'utf8'),
  /<video controls preload="metadata" src=\{panelApi.recordingUrl\(sessionId, path\)\}><\/video>/,
);
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
const output = resolve(root, 'apps/android/build/parity/recording-controls');
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  await page.setContent(
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:24px;padding-top:300px}video{width:100%}</style><video controls preload="metadata"></video>',
  );
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = i % 2 ? '#333333' : '#225588';
      ctx.fillRect(0, 0, 320, 180);
      await new Promise((r) => setTimeout(r, 100));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    const video = document.querySelector('video');
    video.src = URL.createObjectURL(blob);
    await new Promise((r) => (video.onloadeddata = r));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await writeFile(resolve(output, 'reference.webm'), Buffer.from(bytes));
  const cdp = await page.context().newCDPSession(page);
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const nodes = [];
  function walk(n) {
    if (n.attributes?.some((v) => v.includes('media-controls'))) nodes.push(n);
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
  }
  walk(doc.root);
  const controls = nodes.map((n) => ({
    nodeId: n.nodeId,
    name: n.nodeName,
    attributes: n.attributes,
  }));
  await writeFile(resolve(output, 'controls.json'), JSON.stringify(controls, null, 2));
  const overflow = nodes.find((n) =>
    n.attributes.includes('-internal-media-controls-overflow-button'),
  );
  assert(overflow, 'Chrome media overflow button must exist');
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: overflow.nodeId });
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function(){this.click()}',
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, 'web-menu.png') });
  const ax = await cdp.send('Accessibility.getFullAXTree');
  const names = ax.nodes
    .filter((n) => !n.ignored)
    .map((n) => ({ role: n.role?.value, name: n.name?.value }));
  await writeFile(resolve(output, 'menu-accessibility.json'), JSON.stringify(names, null, 2));
  const speed = nodes.find((n) =>
    n.attributes.includes('-internal-media-controls-playback-speed-button'),
  );
  assert(speed);
  const speedObject = await cdp.send('DOM.resolveNode', { nodeId: speed.nodeId });
  await cdp.send('Runtime.callFunctionOn', {
    objectId: speedObject.object.objectId,
    functionDeclaration: 'function(){this.click()}',
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, 'web-speed-menu.png') });
  const speedAx = await cdp.send('Accessibility.getFullAXTree');
  const speedNames = speedAx.nodes
    .filter((n) => !n.ignored)
    .map((n) => ({ role: n.role?.value, name: n.name?.value, properties: n.properties }));
  await writeFile(resolve(output, 'speed-accessibility.json'), JSON.stringify(speedNames, null, 2));
  const selectedRate = speedAx.nodes.find(
    (n) => !n.ignored && n.role?.value === 'menuitemcheckbox' && n.name?.value === '1.5',
  );
  assert(selectedRate?.backendDOMNodeId);
  const selectedObject = await cdp.send('DOM.resolveNode', {
    backendNodeId: selectedRate.backendDOMNodeId,
  });
  await cdp.send('Runtime.callFunctionOn', {
    objectId: selectedObject.object.objectId,
    functionDeclaration: 'function(){this.click()}',
  });
  const menuActivation = await page
    .locator('video')
    .evaluate((el) => ({ rate: el.playbackRate, paused: el.paused }));
  assert.equal(menuActivation.rate, 1.5);
  assert.equal(menuActivation.paused, true);
  const rateResults = [];
  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    rateResults.push(
      await page.locator('video').evaluate((el, rate) => {
        el.playbackRate = rate;
        return { requested: rate, actual: el.playbackRate, paused: el.paused };
      }, rate),
    );
  }
  const evidence = {
    revision,
    browser: browser.version(),
    viewport: { width: 390, height: 844 },
    platform:
      'desktop macOS Chrome; browser-owned controls use host Chinese UI despite en-US page locale',
    menu: names.filter((n) => n.role === 'menuitem'),
    speedMenu: speedNames.filter(
      (n) => n.role === 'menuitemcheckbox' || n.role === 'menuitemradio' || n.role === 'menuitem',
    ),
    menuActivation,
    rateResults,
    limitations: [
      'Silent generated WebM; audio behavior not tested.',
      'Desktop controls do not establish Android controls, PiP availability or geometry.',
      'Only 1.5x is activated through the native menu; rate assignment confirms accepted values, not measured playback speed.',
    ],
  };
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/recording-controls-web.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
