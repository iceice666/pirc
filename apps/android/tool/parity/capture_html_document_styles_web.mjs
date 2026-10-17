import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_document_styles_web.mjs
// Measures Chrome's real CSS cascade on a raw HTML response reached by a
// pointer submission through the pinned production Markdown sanitizer.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-document-styles.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision) throw new Error('HTML document styles fixture must use the pinned web revision');
if (fixture.responseHtml.toLowerCase().includes('<script')) throw new Error('Raw HTML response must not contain scripts');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const origin = 'http://127.0.0.1:18924';
const outputDir = resolve('/private/tmp', 'pirc-html-document-styles-parity');
const serverRequests = [];
const serverResponses = [];
const externalRequests = [];
const browserErrors = [];

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Markdown CSS navigation harness</title></head><body><main id="fixture"></main><script type="module">
import { renderMarkdown } from '/src/lib/markdown.ts';
const fixture = ${fixtureSource};
const root = document.querySelector('#fixture');
root.innerHTML = renderMarkdown(fixture.markdownForm);
const form = root.querySelector('#markdown-style-form');
window.markdownFormSnapshot = form ? {
  action: form.action,
  method: form.method,
  target: form.target,
  html: root.innerHTML,
  submitter: form.querySelector('#markdown-style-submit')?.outerHTML || null,
} : null;
window.fixtureReady = true;
</script></body></html>`;

const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18924,
    strictPort: true,
    hmr: false,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-document-styles-parity',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const rawUrl = request.url || '/';
        const pathname = rawUrl.split(/[?#]/, 1)[0];
        if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        if (pathname === '/styles-harness.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(await vite.transformIndexHtml('/styles-harness.html', harnessHtml));
          return;
        }
        if (pathname === fixture.responsePath) {
          serverRequests.push({ method: request.method, rawUrl, kind: 'document' });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          serverResponses.push({ status: 200, rawUrl, kind: 'document' });
          response.end(fixture.responseHtml);
          return;
        }
        if (Object.hasOwn(fixture.stylesheets, pathname)) {
          serverRequests.push({ method: request.method, rawUrl, kind: 'stylesheet', accept: request.headers.accept });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/css; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          serverResponses.push({ status: 200, rawUrl, kind: 'stylesheet' });
          response.end(fixture.stylesheets[pathname]);
          return;
        }
        if (pathname.startsWith('/raw/styles/')) {
          serverRequests.push({ method: request.method, rawUrl, kind: 'unexpected-local-resource' });
          serverResponses.push({ status: 404, rawUrl, kind: 'unexpected-local-resource' });
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end('Unexpected local style fixture resource');
          return;
        }
        next();
      });
    },
  }],
});

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function pngPixel(png, x, y) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const imageChunks = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') imageChunks.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('Unsupported screenshot PNG format');
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('Screenshot sample is out of bounds');
  const channels = colorType === 6 ? 4 : 3;
  const bytesPerRow = width * channels;
  const raw = inflateSync(Buffer.concat(imageChunks));
  const pixels = Buffer.alloc(bytesPerRow * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[sourceOffset++];
    const rowOffset = row * bytesPerRow;
    for (let column = 0; column < bytesPerRow; column++) {
      const value = raw[sourceOffset++];
      const left = column >= channels ? pixels[rowOffset + column - channels] : 0;
      const up = row > 0 ? pixels[rowOffset + column - bytesPerRow] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[rowOffset + column - bytesPerRow - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error('Unsupported screenshot PNG filter');
      pixels[rowOffset + column] = (value + predictor) & 255;
    }
  }
  const start = y * bytesPerRow + x * channels;
  return { x, y, r: pixels[start], g: pixels[start + 1], b: pixels[start + 2], a: channels === 4 ? pixels[start + 3] : 255 };
}

async function captureDocument(page) {
  return page.evaluate(({ selectors, styleProperties }) => {
    const nodes = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element) { nodes[name] = null; continue; }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      nodes[name] = {
        tag: element.localName,
        id: element.id || null,
        text: (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
        attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computed: Object.fromEntries(styleProperties.map(property => [property, style.getPropertyValue(property).trim()])),
      };
    }
    const html = document.documentElement;
    const body = document.body;
    const rootStyle = getComputedStyle(html);
    const bodyStyle = getComputedStyle(body);
    const headSources = [...document.head.querySelectorAll('link[rel=stylesheet],style')].map(element => ({
      tag: element.localName,
      id: element.id || null,
      href: element.localName === 'link' ? element.href : null,
      media: element.media || null,
    }));
    const summarizeRules = rules => [...rules].map(rule => {
      const summary = {
        type: rule.constructor.name,
        cssText: rule.cssText,
        selectorText: rule.selectorText || null,
      };
      if (rule.styleSheet) {
        summary.importedStyleSheet = {
          href: rule.styleSheet.href,
          rules: summarizeRules(rule.styleSheet.cssRules),
        };
      }
      if (rule.cssRules) summary.nestedRules = summarizeRules(rule.cssRules);
      return summary;
    });
    const stylesheetTree = [...document.styleSheets].map(sheet => ({
      href: sheet.href,
      ownerTag: sheet.ownerNode?.localName || null,
      ownerId: sheet.ownerNode?.id || null,
      media: sheet.media?.mediaText || '',
      disabled: sheet.disabled,
      rules: summarizeRules(sheet.cssRules),
    }));
    const bodyRect = body.getBoundingClientRect();
    return {
      url: location.href,
      title: document.title,
      characterSet: document.characterSet,
      scriptCount: document.scripts.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      preferredColorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      htmlBackground: rootStyle.backgroundColor,
      htmlColorScheme: rootStyle.colorScheme,
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      bodyRect: { x: bodyRect.x, y: bodyRect.y, width: bodyRect.width, height: bodyRect.height },
      nodes,
      headSources,
      stylesheetTree,
      parserSupport: {
        customProperty: CSS.supports('--probe-accent', 'rgb(1, 2, 3)'),
        invalidColorValue: CSS.supports('color', 'not-a-real-color'),
        unsupportedPseudo: CSS.supports('selector(:future-pseudo)'),
      },
    };
  }, { selectors: fixture.snapshotNodes, styleProperties: fixture.styleProperties });
}

function expectedPixelFromCss(color) {
  const channels = color.match(/\d+/g)?.map(Number);
  return channels?.length >= 3 ? channels.slice(0, 3) : null;
}

function checkInvariants(captures) {
  for (const invariant of fixture.invariants) {
    const matching = captures.filter(item => {
      if (invariant.appliesTo === 'all') return true;
      if (invariant.appliesTo === 'narrow') return item.width === 390;
      if (invariant.appliesTo === 'wide') return item.width === 768;
      return item.colorScheme === invariant.appliesTo;
    });
    for (const capture of matching) {
      const actual = capture.document.nodes[invariant.node]?.computed[invariant.property] ?? null;
      if (actual !== invariant.expected) {
        throw new Error(`Invariant ${invariant.node}.${invariant.property} failed in ${capture.width}/${capture.colorScheme}: expected ${invariant.expected}, got ${actual}`);
      }
    }
  }
  for (const capture of captures) {
    const bodyBackground = capture.document.bodyBackground;
    const expectedChannels = expectedPixelFromCss(bodyBackground);
    const actualChannels = [capture.canvasPixel.r, capture.canvasPixel.g, capture.canvasPixel.b];
    if (!expectedChannels || actualChannels.some((channel, index) => channel !== expectedChannels[index])) {
      throw new Error(`Canvas corner does not match body background in ${capture.width}/${capture.colorScheme}: ${JSON.stringify({ bodyBackground, canvasPixel: capture.canvasPixel })}`);
    }
    if (capture.document.htmlBackground !== 'rgba(0, 0, 0, 0)') {
      throw new Error(`Expected transparent html canvas root, got ${capture.document.htmlBackground}`);
    }
    if (capture.document.scriptCount !== 0) throw new Error('Raw response unexpectedly contains executable scripts');
    for (const pathname of Object.keys(fixture.stylesheets)) {
      if (!capture.requests.some(item => item.url.startsWith(origin + pathname))) {
        throw new Error(`Missing local stylesheet request ${pathname} in ${capture.width}/${capture.colorScheme}`);
      }
    }
    if (capture.requests.some(item => new URL(item.url).origin !== origin)) {
      throw new Error('A browser request escaped the local fixture origin');
    }
  }
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
  const browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.')) throw new Error('Expected Chrome 154, got ' + browserVersion);
  const captures = [];

  for (const width of [390, 768]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        deviceScaleFactor: 1,
        colorScheme,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(4500);
      page.setDefaultNavigationTimeout(6500);
      const caseRequests = [];
      const caseResponses = [];
      page.on('request', request => {
        const requestUrl = request.url();
        if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return;
        try {
          if (new URL(requestUrl).origin !== origin) externalRequests.push(requestUrl);
        } catch { externalRequests.push(requestUrl); }
        if (requestUrl.startsWith(origin + '/raw/styles/') || requestUrl.startsWith(origin + '/styles-harness.html')) {
          caseRequests.push({ url: requestUrl, method: request.method(), resourceType: request.resourceType() });
        }
      });
      page.on('response', response => {
        if (response.url().startsWith(origin + '/raw/styles/') || response.url().startsWith(origin + '/styles-harness.html')) {
          caseResponses.push({ url: response.url(), status: response.status(), method: response.request().method() });
        }
      });
      page.on('pageerror', error => browserErrors.push({ width, colorScheme, kind: 'pageerror', message: error.stack || error.message }));
      page.on('console', message => {
        if (message.type() === 'error') browserErrors.push({ width, colorScheme, kind: 'console', message: message.text() });
      });

      await page.goto(origin + '/styles-harness.html', { waitUntil: 'load', timeout: 6500 });
      await page.waitForFunction(() => window.fixtureReady === true);
      const markdownForm = await page.evaluate(() => window.markdownFormSnapshot);
      if (!markdownForm || !markdownForm.action.endsWith('/raw/styles/response?via=markdown-form')) {
        throw new Error('Pinned production Markdown did not produce the expected form action: ' + JSON.stringify(markdownForm));
      }
      const requestStart = serverRequests.length;
      const [documentResponse] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 6500 }),
        page.locator('#markdown-style-submit').click(),
      ]);
      if (page.url() !== origin + '/raw/styles/response?via=markdown-form') {
        throw new Error('Markdown form navigated to unexpected URL ' + page.url());
      }
      const document = await captureDocument(page);
      const image = await page.screenshot({ type: 'png' });
      const canvasPixel = pngPixel(image, 1, 1);
      const item = {
        width,
        height: 844,
        colorScheme,
        markdownForm,
        documentStatus: documentResponse?.status() ?? null,
        document,
        canvasPixel,
        requests: caseRequests.filter(request => request.url.startsWith(origin + '/raw/styles/')),
        responses: caseResponses.filter(response => response.url.startsWith(origin + '/raw/styles/')),
        serverRequests: serverRequests.slice(requestStart),
      };
      captures.push(item);
      await context.close();
    }
  }

  checkInvariants(captures);
  if (externalRequests.length) throw new Error('Unexpected external requests: ' + JSON.stringify(externalRequests));
  if (browserErrors.length) throw new Error('Unexpected browser errors: ' + JSON.stringify(browserErrors));
  if (serverResponses.some(response => response.status >= 400)) throw new Error('Unexpected local error response: ' + JSON.stringify(serverResponses));

  const expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion,
    locale: await browser.newPage().then(page => page.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] }))),
    origin,
    sanitizer: 'apps/web/src/lib/markdown.ts renderMarkdown() / DOMPurify',
    captures,
    serverResponses,
    externalRequests,
    browserErrors,
    localRequestsOnly: externalRequests.length === 0 && captures.every(capture => capture.requests.every(request => request.url.startsWith(origin + '/'))),
    responseScriptsExecuted: false,
    unsupported: ['script behavior in raw responses', 'external network resources', 'font matching outside Chrome host defaults'],
  };
  const target = resolve(root, 'fixtures/mobile-parity/html-document-styles-expected.json');
  await writeFile(target, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    target,
    browserVersion,
    cases: captures.map(capture => ({
      width: capture.width,
      colorScheme: capture.colorScheme,
      finalUrl: capture.document.url,
      formAction: capture.markdownForm.action,
      bodyBackground: capture.document.bodyBackground,
      htmlBackground: capture.document.htmlBackground,
      canvasPixel: capture.canvasPixel,
      sourceOrder: capture.document.nodes['source-order']?.computed,
      specificity: capture.document.nodes.specificity?.computed.color,
      stylesheetRequests: capture.requests.filter(request => request.resourceType === 'stylesheet').map(request => new URL(request.url).pathname),
      stylesheetSources: capture.document.headSources,
    })),
    localRequestsOnly: expected.localRequestsOnly,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
