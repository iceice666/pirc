import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_navigation_web.mjs
// Measures real Chrome navigation after production renderMarkdown sanitization.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-navigation.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision) throw new Error('HTML navigation fixture must use pinned web revision');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const temporaryOutput = resolve('/private/tmp', 'pirc-html-navigation-parity');
const capturedRequests = [];
const browserResponses = [];
const browserIssues = { pageErrors: [], consoleErrors: [], badResponses: [], externalRequests: [], requestFailures: [] };
const origin = 'http://127.0.0.1:18921';
const metadataKey = '__pircHtmlNavigationLastSubmit';

const pageMarkup = [
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>HTML navigation fixture</title></head>',
  '<body><main id="fixture"></main><script type="module">',
  "import { renderMarkdown } from '/src/lib/markdown.ts';",
  'const fixture = ' + fixtureSource + ';',
  'const redirectForms = fixture.redirectStatuses.flatMap(status => ["get", "post"].map(method => {',
  '  const id = "redirect-" + method + "-" + status;',
  '  const payload = (method + " payload " + status + " ~! + &").replaceAll("&", "&amp;");',
  '  return \'<form id="\' + id + \'" action="/nav/redirect/start/\' + status + \'-\' + method + \'" method="\' + method + \'"><input name="payload" value="\' + payload + \'"><button id="\' + id + \'-submit">Redirect</button></form>\';',
  '})).join("");',
  'const statusForms = fixture.emptyResponseStatuses.map(status => {',
  '  const id = "status-" + status;',
  '  return \'<form id="\' + id + \'" action="/nav/status/\' + status + \'" method="post"><label for="\' + id + \'-edit">Editable value</label><input id="\' + id + \'-edit" name="value" value="initial"><button id="\' + id + \'-submit">Submit status</button></form>\';',
  '}).join("");',
  'const targetForms = [',
  '  \'<form id="not-found-form" action="/nav/not-found" method="get"><button id="not-found-submit">Expected 404</button></form>\',',
  '  \'<form id="target-blank" action="/capture/target-blank" method="get" target="_blank"><input name="payload" value="blank"><button id="target-blank-submit">Blank</button></form>\',',
  '  \'<form id="target-self" action="/capture/target-self" method="get" target="_self"><input name="payload" value="self"><button id="target-self-submit">Self</button></form>\',',
  '  \'<form id="target-parent" action="/capture/target-parent" method="get" target="_parent"><input name="payload" value="parent"><button id="target-parent-submit">Parent</button></form>\',',
  '  \'<form id="target-top" action="/capture/target-top" method="get" target="_top"><input name="payload" value="top"><button id="target-top-submit">Top</button></form>\',',
  '  \'<form id="target-named-first" action="/capture/target-named-first" method="get" target="pirc-navigation-window"><input name="payload" value="first"><button id="target-named-first-submit">Named first</button></form>\',',
  '  \'<form id="target-named-second" action="/capture/target-named-second" method="get" target="pirc-navigation-window"><input name="payload" value="second"><button id="target-named-second-submit">Named second</button></form>\'',
  '].join("");',
  'const root = document.querySelector("#fixture");',
  'root.innerHTML = renderMarkdown(fixture.source + redirectForms + statusForms + targetForms);',
  'const entries = data => [...data.entries()].map(([name, value]) => [name, value instanceof File ? { filename: value.name, type: value.type, size: value.size } : value]);',
  'root.addEventListener("submit", event => {',
  '  const form = event.target;',
  '  const submitter = event.submitter || null;',
  '  const data = submitter ? new FormData(form, submitter) : new FormData(form);',
  '  const observation = { formId: form.id || null, action: form.action, method: form.method, target: form.target, submitterId: submitter?.id || null, entries: entries(data) };',
  '  localStorage.setItem("' + metadataKey + '", JSON.stringify(observation));',
  '}, true);',
  'window.fixtureReady = true;',
  '</script></body></html>',
].join('\n');

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

function rawQuery(rawUrl) {
  const index = rawUrl.indexOf('?');
  return index < 0 ? '' : rawUrl.slice(index);
}

function addRequest(request, rawUrl, body) {
  const parsed = new URL(rawUrl, origin);
  const query = parsed.search;
  const decodedEntries = [...new URLSearchParams(request.method === 'GET' ? query : body.toString('utf8')).entries()];
  capturedRequests.push({
    method: request.method,
    rawUrl,
    absoluteUrl: origin + rawUrl,
    pathname: rawUrl.split(/[?#]/, 1)[0],
    rawQuery: rawQuery(rawUrl),
    contentType: request.headers['content-type'] || null,
    bodyByteLength: body.length,
    bodyText: body.toString('utf8'),
    bodyBase64: body.toString('base64'),
    decodedEntries,
  });
}

function replyHtml(response, status, title, marker) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>' + title + '</title></head><body><h1 id="response-heading">' + title + '</h1><p id="response-paragraph">Static response body.</p><a id="response-link" href="#response-marker">Same response</a><form><input value="response input"><button type="button">Response button</button></form><main id="response-marker" data-marker="' + marker + '">' + title + '</main></body></html>');
}

function windows1252Bytes(value) {
  const special = new Map([[0x20ac, 0x80], [0x2013, 0x96]]);
  const bytes = [];
  for (const character of value) {
    const code = character.codePointAt(0);
    if (special.has(code)) bytes.push(special.get(code));
    else if (code <= 0xff) bytes.push(code);
    else throw new Error('Unsupported Windows-1252 character U+' + code.toString(16));
  }
  return Buffer.from(bytes);
}

function encodeCharsetPage(spec) {
  const text = 'caf\u00e9 \u2013 \u20ac';
  const html = '<!doctype html><html><head><meta charset="' + spec.meta + '"><title>charset ' + spec.id + '</title></head><body><p id="decoded">' + text + '</p></body></html>';
  let bytes;
  if (spec.wireEncoding === 'windows1252') bytes = windows1252Bytes(html);
  else if (spec.wireEncoding === 'utf16le' || spec.wireEncoding === 'utf16be') {
    bytes = Buffer.from(html, 'utf16le');
    if (spec.wireEncoding === 'utf16be') {
      const swapped = Buffer.alloc(bytes.length);
      for (let index = 0; index < bytes.length; index += 2) {
        swapped[index] = bytes[index + 1];
        swapped[index + 1] = bytes[index];
      }
      bytes = swapped;
    }
  } else bytes = Buffer.from(html, 'utf8');
  if (spec.bom === 'utf8') bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  else if (spec.bom === 'utf16le') bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
  else if (spec.bom === 'utf16be') bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]);
  return bytes;
}

const charsetPages = new Map(fixture.charsets.map(spec => [spec.id, { spec, bytes: encodeCharsetPage(spec) }]));
const server = await createServer({
  cacheDir: resolve(temporaryOutput, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18921,
    strictPort: true,
    hmr: false,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-navigation-parity',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const rawUrl = request.url || '/';
        const pathname = rawUrl.split(/[?#]/, 1)[0];
        const hasQuery = rawQuery(rawUrl) !== '';
        if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }

        if (pathname === '/parity.html') {
          if (hasQuery) addRequest(request, rawUrl, Buffer.alloc(0));
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(await vite.transformIndexHtml('/parity.html', pageMarkup));
          return;
        }

        if (pathname.startsWith('/nav/redirect/start/')) {
          const id = pathname.split('/').at(-1);
          const match = /^(\d+)-(get|post)$/.exec(id);
          if (!match) { next(); return; }
          const body = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
          addRequest(request, rawUrl, body);
          response.statusCode = Number(match[1]);
          response.setHeader('Location', '/capture/redirect-final/' + id + '?done=1');
          response.setHeader('Cache-Control', 'no-store');
          response.end();
          return;
        }

        if (pathname.startsWith('/nav/status/')) {
          const body = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
          addRequest(request, rawUrl, body);
          const status = Number(pathname.split('/').at(-1));
          if (fixture.emptyResponseStatuses.includes(status)) {
            response.statusCode = status;
            response.setHeader('Cache-Control', 'no-store');
            response.end();
            return;
          }
        }

        if (pathname === '/mime/plain' || pathname === '/mime/json') {
          addRequest(request, rawUrl, Buffer.alloc(0));
          response.statusCode = 200;
          response.setHeader('Content-Type', pathname === '/mime/plain' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          const body = pathname === '/mime/plain'
            ? '{"message":"text/plain"}' + String.fromCharCode(10) + 'second line' + String.fromCharCode(10)
            : JSON.stringify({ message: 'application/json', items: [1, 2], nested: { enabled: true } }, null, 2);
          response.end(body);
          return;
        }

        if (pathname.startsWith('/charset/')) {
          const id = pathname.split('/').at(-1);
          const item = charsetPages.get(id);
          if (!item) { next(); return; }
          addRequest(request, rawUrl, Buffer.alloc(0));
          response.statusCode = 200;
          response.setHeader('Content-Type', item.spec.contentType);
          response.setHeader('Cache-Control', 'no-store');
          response.end(item.bytes);
          return;
        }

        if (pathname === '/nav/base-page') {
          addRequest(request, rawUrl, Buffer.alloc(0));
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end('<!doctype html><html><head><meta charset="utf-8"><base href="/nav/base/assets/"><title>base response</title></head><body><h1>Base response</h1><p>Static base URL test.</p><a id="base-link" href="next?from=anchor">Relative anchor</a><form id="base-form" action="submit?from=form" method="get"><input name="baseValue" value="base form"><button id="base-submit">Submit base form</button></form><img id="base-image" src="pixel.svg" alt="pixel"></body></html>');
          return;
        }

        if (pathname === '/nav/base/assets/pixel.svg') {
          addRequest(request, rawUrl, Buffer.alloc(0));
          response.statusCode = 200;
          response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
          return;
        }

        if (pathname === '/nav/not-found') {
          addRequest(request, rawUrl, Buffer.alloc(0));
          replyHtml(response, 404, 'Expected local 404 body', 'not-found');
          return;
        }

        if (pathname === '/nav/history-away') {
          addRequest(request, rawUrl, Buffer.alloc(0));
          replyHtml(response, 200, 'History destination', 'history-away');
          return;
        }

        if (pathname.startsWith('/nav/') || pathname.startsWith('/capture/')) {
          const body = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
          addRequest(request, rawUrl, body);
          const marker = pathname.split('/').filter(Boolean).at(-1) || 'capture';
          replyHtml(response, 200, 'Local navigation response', marker);
          return;
        }

        return next();
      });
    },
  }],
});

const browser = await (async () => {
  await server.listen();
  return require('playwright-core').chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
})();

const observedPages = new WeakSet();
function observePage(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.setDefaultTimeout(3500);
  page.setDefaultNavigationTimeout(4500);
  page.on('pageerror', error => browserIssues.pageErrors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserIssues.consoleErrors.push(message.text() + ' ' + JSON.stringify(message.location()));
  });
  page.on('response', response => {
    const responseUrl = response.url();
    if (response.status() >= 400) browserIssues.badResponses.push({ status: response.status(), url: responseUrl });
    if (responseUrl.startsWith(origin)) {
      const path = new URL(responseUrl).pathname;
      if (path.startsWith('/capture/') || path.startsWith('/nav/') || path.startsWith('/charset/') || path === '/parity.html') {
        browserResponses.push({ status: response.status(), url: responseUrl, method: response.request().method() });
      }
    }
  });
  page.on('request', request => {
    const requestUrl = request.url();
    if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return;
    try {
      if (new URL(requestUrl).origin !== origin) browserIssues.externalRequests.push(requestUrl);
    } catch { browserIssues.externalRequests.push(requestUrl); }
  });
  page.on('requestfailed', request => {
    browserIssues.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || null });
  });
}

const browserVersion = await browser.version();
if (!browserVersion.startsWith('154.')) throw new Error('Expected Chromium 154, got ' + browserVersion);
const newContextPage = async (viewport = { width: 1024, height: 768 }, colorScheme = 'light') => {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addInitScript(() => {
    window.__pircNavigationLifecycle = [];
    const record = (type, event) => {
      const navigation = performance.getEntriesByType('navigation')[0];
      window.__pircNavigationLifecycle.push({
        type,
        persisted: event && 'persisted' in event ? event.persisted : null,
        url: location.href,
        navigationType: navigation ? navigation.type : null,
        timeOrigin: performance.timeOrigin,
      });
    };
    addEventListener('pageshow', event => record('pageshow', event));
    addEventListener('pagehide', event => record('pagehide', event));
    addEventListener('popstate', event => record('popstate', event));
    addEventListener('hashchange', event => record('hashchange', event));
  });
  context.on('page', observePage);
  const page = await context.newPage();
  observePage(page);
  return { context, page };
};

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

async function documentProbe(targetPage) {
  return targetPage.evaluate(() => {
    const selectors = { body: 'body', h1: 'h1', p: 'p', a: 'a', input: 'input', button: 'button', pre: 'pre' };
    const styles = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) return [name, null];
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return [name, {
        font: computed.font,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        margin: computed.margin,
        background: computed.backgroundColor,
        color: computed.color,
        colorScheme: computed.colorScheme,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }];
    }));
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      url: location.href,
      title: document.title,
      characterSet: document.characterSet,
      bodyText: (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 240),
      hasFixtureRoot: !!document.querySelector('#fixture'),
      responseMarker: document.querySelector('#response-marker')?.getAttribute('data-marker') || null,
      fields: Object.fromEntries(['history-edit', 'status-204-edit', 'status-205-edit'].map(id => {
        const element = document.getElementById(id);
        return [id, element ? element.value : null];
      })),
      scrollY: window.scrollY,
      timeOrigin: performance.timeOrigin,
      preferredColorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      htmlBackground: htmlStyle.backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      nodes: styles,
      lifecycle: (window.__pircNavigationLifecycle || []).slice(-8),
    };
  });
}

async function storedSubmit(targetPage) {
  return targetPage.evaluate(key => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }, metadataKey);
}

async function clickAndObserveNavigation(targetPage, selector, timeout = 1800) {
  const beforeUrl = targetPage.url();
  const navigation = targetPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout })
    .then(response => ({ observed: true, status: response ? response.status() : null }))
    .catch(error => ({ observed: false, reason: error.name }));
  await targetPage.locator(selector).click({ timeout: 3000 });
  const result = await navigation;
  await targetPage.waitForTimeout(60);
  return { beforeUrl, afterUrl: targetPage.url(), navigation: result };
}

const { context, page } = await newContextPage();
const fixtureUrl = origin + '/parity.html';
let requestStart = 0;
const urlActions = [];
const actionResult = async (actionId, selector) => {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  await page.evaluate(key => localStorage.removeItem(key), metadataKey);
  requestStart = capturedRequests.length;
  const timeBefore = await page.evaluate(() => performance.timeOrigin);
  const transition = await clickAndObserveNavigation(page, selector);
  return {
    id: actionId,
    transition,
    finalUrl: page.url(),
    sameDocumentInstance: timeBefore === await page.evaluate(() => performance.timeOrigin),
    submit: await storedSubmit(page),
    document: await documentProbe(page),
    requests: capturedRequests.slice(requestStart),
  };
};

try {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  const locale = await page.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] }));

  requestStart = capturedRequests.length;
  const anchorUrlBefore = page.url();
  const anchorTimeBefore = await page.evaluate(() => performance.timeOrigin);
  await page.locator('#same-document-link').click({ timeout: 3000 });
  await page.waitForTimeout(60);
  urlActions.push({
    id: 'same-document-anchor-fragment',
    beforeUrl: anchorUrlBefore,
    finalUrl: page.url(),
    anchor: await page.evaluate(() => { const element = document.querySelector('#same-document-link'); return { hrefAttribute: element?.getAttribute('href') || null, href: element?.href || null, targetExists: !!document.querySelector('#same-document-target') }; }),
    sameDocumentInstance: anchorTimeBefore === await page.evaluate(() => performance.timeOrigin),
    requests: capturedRequests.slice(requestStart),
    document: await documentProbe(page),
  });

  requestStart = capturedRequests.length;
  await page.goto(origin + '/nav/fragment-page', { waitUntil: 'load', timeout: 4500 });
  const responseFragmentTimeBefore = await page.evaluate(() => performance.timeOrigin);
  const responseFragmentTransition = await clickAndObserveNavigation(page, '#response-link');
  urlActions.push({
    id: 'response-document-anchor-fragment',
    transition: responseFragmentTransition,
    finalUrl: page.url(),
    sameDocumentInstance: responseFragmentTimeBefore === await page.evaluate(() => performance.timeOrigin),
    requests: capturedRequests.slice(requestStart + 1),
    document: await documentProbe(page),
  });

  for (const item of [
    ['relative-action', '#url-relative-submit'],
    ['empty-action', '#url-empty-submit'],
    ['query-only-action', '#url-query-only-submit'],
    ['fragment-only-action', '#url-fragment-submit'],
    ['same-path-fragment-action', '#url-same-path-fragment-submit'],
  ]) urlActions.push(await actionResult(item[0], item[1]));

  const baseObservations = {};
  requestStart = capturedRequests.length;
  await page.goto(origin + '/nav/base-page', { waitUntil: 'load', timeout: 4500 });
  await page.waitForFunction(() => document.querySelector('#base-image')?.complete, { timeout: 3500 });
  baseObservations.parsedPage = await page.evaluate(() => ({
    baseElement: document.querySelector('base')?.href || null,
    anchorHref: document.querySelector('#base-link')?.href || null,
    formAction: document.querySelector('#base-form')?.action || null,
    imageSrc: document.querySelector('#base-image')?.src || null,
    imageCurrentSrc: document.querySelector('#base-image')?.currentSrc || null,
    imageNaturalWidth: document.querySelector('#base-image')?.naturalWidth ?? null,
    document: {
      title: document.title,
      bodyText: document.body.innerText.trim(),
      characterSet: document.characterSet,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    },
  }));
  baseObservations.imageRequests = capturedRequests.slice(requestStart);
  requestStart = capturedRequests.length;
  const baseAnchorTransition = await clickAndObserveNavigation(page, '#base-link');
  baseObservations.anchor = {
    transition: baseAnchorTransition,
    document: await documentProbe(page),
    requests: capturedRequests.slice(requestStart),
  };
  requestStart = capturedRequests.length;
  await page.goto(origin + '/nav/base-page', { waitUntil: 'load', timeout: 4500 });
  await page.waitForFunction(() => document.querySelector('#base-image')?.complete, { timeout: 3500 });
  const baseFormTransition = await clickAndObserveNavigation(page, '#base-submit');
  baseObservations.form = {
    transition: baseFormTransition,
    submit: await storedSubmit(page),
    document: await documentProbe(page),
    requests: capturedRequests.slice(requestStart),
  };

  const redirectObservations = [];
  for (const status of fixture.redirectStatuses) {
    for (const method of ['get', 'post']) {
      const id = 'redirect-' + method + '-' + status;
      await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
      await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
      await page.evaluate(key => localStorage.removeItem(key), metadataKey);
      requestStart = capturedRequests.length;
      const transition = await clickAndObserveNavigation(page, '#' + id + '-submit');
      redirectObservations.push({
        id,
        status,
        method: method.toUpperCase(),
        transition,
        submit: await storedSubmit(page),
        document: await documentProbe(page),
        requests: capturedRequests.slice(requestStart),
      });
    }
  }

  const emptyResponseObservations = [];
  for (const status of fixture.emptyResponseStatuses) {
    const id = 'status-' + status;
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
    await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
    await page.locator('#' + id + '-edit').fill('edited-before-submit');
    await page.evaluate(key => localStorage.removeItem(key), metadataKey);
    requestStart = capturedRequests.length;
    const timeBefore = await page.evaluate(() => performance.timeOrigin);
    const transition = await clickAndObserveNavigation(page, '#' + id + '-submit', 1200);
    emptyResponseObservations.push({
      id,
      status,
      transition,
      finalUrl: page.url(),
      sameDocumentInstance: timeBefore === await page.evaluate(() => performance.timeOrigin),
      submit: await storedSubmit(page),
      document: await documentProbe(page),
      requests: capturedRequests.slice(requestStart),
    });
  }

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  requestStart = capturedRequests.length;
  const notFoundTransition = await clickAndObserveNavigation(page, '#not-found-submit');
  const notFoundObservation = {
    transition: notFoundTransition,
    finalUrl: page.url(),
    submit: await storedSubmit(page),
    document: await documentProbe(page),
    requests: capturedRequests.slice(requestStart),
  };

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  await page.evaluate(() => { document.body.style.minHeight = '1800px'; });
  await page.locator('#history-edit').fill('edited before away navigation');
  await page.evaluate(() => window.scrollTo(0, 620));
  const historyBefore = await documentProbe(page);
  requestStart = capturedRequests.length;
  await page.goto(origin + '/nav/history-away', { waitUntil: 'load', timeout: 4500 });
  const historyAway = await documentProbe(page);
  const historyAwayRequests = capturedRequests.slice(requestStart);
  const backResponse = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.waitForFunction(() => !!document.querySelector('#fixture'), { timeout: 3500 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const historyBack = { responseStatus: backResponse ? backResponse.status() : null, document: await documentProbe(page) };
  const forwardResponse = await page.goForward({ waitUntil: 'domcontentloaded', timeout: 4500 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const historyForward = { responseStatus: forwardResponse ? forwardResponse.status() : null, document: await documentProbe(page) };
  const historyObservation = {
    beforeAway: historyBefore,
    away: historyAway,
    awayRequests: historyAwayRequests,
    back: historyBack,
    forward: historyForward,
  };

  const targetObservations = [];
  for (const target of ['_self', '_parent', '_top']) {
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
    await page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
    await page.evaluate(key => localStorage.removeItem(key), metadataKey);
    requestStart = capturedRequests.length;
    const pageCountBefore = context.pages().length;
    const transition = await clickAndObserveNavigation(page, '#target-' + target.slice(1) + '-submit');
    targetObservations.push({
      target,
      transition,
      samePageObject: true,
      pageCountBefore,
      pageCountAfter: context.pages().length,
      submit: await storedSubmit(page),
      document: await documentProbe(page),
      requests: capturedRequests.slice(requestStart),
    });
  }

  const blankSession = await newContextPage();
  await blankSession.page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await blankSession.page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  await blankSession.page.evaluate(key => localStorage.removeItem(key), metadataKey);
  requestStart = capturedRequests.length;
  const blankPagePromise = blankSession.context.waitForEvent('page', { timeout: 2500 });
  await blankSession.page.locator('#target-blank-submit').click({ timeout: 3000 });
  const openedBlankPage = await blankPagePromise;
  await openedBlankPage.waitForLoadState('domcontentloaded', { timeout: 4500 });
  const blankObservation = {
    sourceUrl: blankSession.page.url(),
    openedUrl: openedBlankPage.url(),
    sourceAndTargetAreSamePage: blankSession.page === openedBlankPage,
    pageCount: blankSession.context.pages().length,
    submit: await storedSubmit(openedBlankPage),
    targetDocument: await documentProbe(openedBlankPage),
    requests: capturedRequests.slice(requestStart),
  };
  targetObservations.push({ target: '_blank', ...blankObservation });
  await blankSession.context.close();

  const namedSession = await newContextPage();
  await namedSession.page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 4500 });
  await namedSession.page.waitForFunction(() => window.fixtureReady, { timeout: 3500 });
  await namedSession.page.evaluate(key => localStorage.removeItem(key), metadataKey);
  requestStart = capturedRequests.length;
  const namedPagePromise = namedSession.context.waitForEvent('page', { timeout: 2500 });
  await namedSession.page.locator('#target-named-first-submit').click({ timeout: 3000 });
  const namedPage = await namedPagePromise;
  await namedPage.waitForLoadState('domcontentloaded', { timeout: 4500 });
  const firstNamed = {
    pageCount: namedSession.context.pages().length,
    sourceUrl: namedSession.page.url(),
    targetUrl: namedPage.url(),
    targetName: await namedPage.evaluate(() => window.name),
    submit: await storedSubmit(namedPage),
    requests: capturedRequests.slice(requestStart),
  };
  requestStart = capturedRequests.length;
  const namedTargetNavigation = namedPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 })
    .then(response => ({ observed: true, status: response ? response.status() : null }))
    .catch(error => ({ observed: false, reason: error.name }));
  await namedSession.page.locator('#target-named-second-submit').click({ timeout: 3000 });
  const namedReuseNavigation = await namedTargetNavigation;
  await namedPage.waitForTimeout(60);
  const namedReuse = {
    navigation: namedReuseNavigation,
    pageCount: namedSession.context.pages().length,
    targetPageReused: namedSession.context.pages().includes(namedPage),
    sourceUrl: namedSession.page.url(),
    targetUrl: namedPage.url(),
    targetName: await namedPage.evaluate(() => window.name),
    submit: await storedSubmit(namedPage),
    document: await documentProbe(namedPage),
    requests: capturedRequests.slice(requestStart),
  };
  targetObservations.push({ target: 'named', first: firstNamed, reuse: namedReuse });
  await namedSession.context.close();

  const charsetObservations = [];
  for (const spec of fixture.charsets) {
    await page.goto(origin + '/charset/' + spec.id, { waitUntil: 'load', timeout: 4500 });
    charsetObservations.push({
      id: spec.id,
      wireEncoding: spec.wireEncoding,
      contentType: spec.contentType,
      meta: spec.meta,
      bom: spec.bom,
      document: await page.evaluate(() => ({
        characterSet: document.characterSet,
        title: document.title,
        decodedText: document.querySelector('#decoded')?.textContent || null,
        bodyText: (document.body?.innerText || '').trim(),
      })),
    });
  }

  const mimeObservations = [];
  for (const item of [
    { id: 'text-plain', path: '/mime/plain', contentType: 'text/plain; charset=utf-8' },
    { id: 'application-json', path: '/mime/json', contentType: 'application/json; charset=utf-8' },
  ]) {
    const response = await page.goto(origin + item.path, { waitUntil: 'load', timeout: 4500 });
    const document = await documentProbe(page);
    const viewerDom = await page.evaluate(() => ({
      bodyHtml: document.body?.innerHTML || '',
      bodyTextContent: document.body?.textContent || '',
      bodyChildren: [...(document.body?.children || [])].map(element => ({ tag: element.localName, id: element.id || null, text: (element.innerText || '').slice(0, 300) })),
      preformatted: [...document.querySelectorAll('pre')].map(element => {
        const style = getComputedStyle(element);
        return { text: element.innerText, font: style.font, fontSize: style.fontSize, lineHeight: style.lineHeight, margin: style.margin, background: style.backgroundColor, color: style.color, colorScheme: style.colorScheme };
      }),
      buttons: [...document.querySelectorAll('button')].map(element => ({ text: element.innerText, ariaLabel: element.getAttribute('aria-label'), title: element.title })),
      openShadowRoots: [...document.querySelectorAll('*')].filter(element => element.shadowRoot).map(element => ({ tag: element.localName, id: element.id || null, html: element.shadowRoot.innerHTML.slice(0, 600) })),
    }));
    mimeObservations.push({ id: item.id, contentType: item.contentType, responseStatus: response?.status() ?? null, document, viewerDom });
  }

  const styleProbes = [];
  for (const width of [390, 768]) {
    for (const colorScheme of ['light', 'dark']) {
      const styleSession = await newContextPage({ width, height: 844 }, colorScheme);
      await styleSession.page.goto(origin + '/nav/style-probe', { waitUntil: 'load', timeout: 4500 });
      const png = await styleSession.page.screenshot({ type: 'png' });
      const viewportCornerPixel = pngPixel(png, width - 2, 842);
      styleProbes.push({
        width,
        height: 844,
        colorScheme,
        document: await documentProbe(styleSession.page),
        viewportCornerPixel,
      });
      await styleSession.context.close();
    }
  }

  const expected404 = browserIssues.badResponses.filter(item => item.status === 404 && new URL(item.url).pathname === '/nav/not-found');
  const unexpectedBadResponses = browserIssues.badResponses.filter(item => !(item.status === 404 && new URL(item.url).pathname === '/nav/not-found'));
  if (expected404.length !== 1) throw new Error('Expected exactly one explicitly allowed local 404 response, got ' + expected404.length);
  if (unexpectedBadResponses.length) throw new Error('Unexpected bad responses: ' + JSON.stringify(unexpectedBadResponses));
  if (browserIssues.pageErrors.length) throw new Error('Browser page errors: ' + browserIssues.pageErrors.join('\n'));
  const expected404ConsoleErrors = browserIssues.consoleErrors.filter(message => message.includes('404 (Not Found)') && message.includes(origin + '/nav/not-found'));
  const unexpectedConsoleErrors = browserIssues.consoleErrors.filter(message => !(message.includes('404 (Not Found)') && message.includes(origin + '/nav/not-found')));
  if (unexpectedConsoleErrors.length) throw new Error('Browser console errors: ' + unexpectedConsoleErrors.join('\n'));
  if (browserIssues.externalRequests.length) throw new Error('Unexpected external requests: ' + browserIssues.externalRequests.join('\n'));
  const expectedEmptyResponseFailures = browserIssues.requestFailures.filter(item =>
    item.error === 'net::ERR_ABORTED' && ['/nav/status/204', '/nav/status/205'].includes(new URL(item.url).pathname));
  const unexpectedRequestFailures = browserIssues.requestFailures.filter(item =>
    !(item.error === 'net::ERR_ABORTED' && ['/nav/status/204', '/nav/status/205'].includes(new URL(item.url).pathname)));
  if (unexpectedRequestFailures.length) throw new Error('Unexpected request failures: ' + JSON.stringify(unexpectedRequestFailures));
  if (capturedRequests.some(item => !item.rawUrl.startsWith('/'))) throw new Error('Captured a non-local request URL');

  const expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion,
    locale: await page.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] })),
    sanitizer: 'apps/web/src/lib/markdown.ts renderMarkdown() / DOMPurify',
    origin,
    urlActions,
    baseResponse: baseObservations,
    redirects: redirectObservations,
    emptyResponses: emptyResponseObservations,
    notFound: notFoundObservation,
    history: historyObservation,
    targets: targetObservations,
    charset: charsetObservations,
    mimeDocuments: mimeObservations,
    responseStyleProbes: styleProbes,
    capturedRequests,
    browserResponses,
    browserIssues,
    expectedEmptyResponseFailures,
    localRequestsOnly: browserIssues.externalRequests.length === 0 && capturedRequests.every(item => item.rawUrl.startsWith('/')),
    unsupported: fixture.notes.unsupported,
  };
  const target = resolve(root, 'fixtures/mobile-parity/html-navigation-expected.json');
  await writeFile(target, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    target,
    browserVersion,
    urlActions: urlActions.map(item => ({ id: item.id, finalUrl: item.finalUrl, sameDocumentInstance: item.sameDocumentInstance ?? null, requests: item.requests.length })),
    redirects: redirectObservations.map(item => ({
      id: item.id,
      source: item.requests[0] ? { method: item.requests[0].method, rawUrl: item.requests[0].rawUrl, bodyText: item.requests[0].bodyText } : null,
      final: item.requests[1] ? { method: item.requests[1].method, rawUrl: item.requests[1].rawUrl, bodyText: item.requests[1].bodyText } : null,
    })),
    emptyResponses: emptyResponseObservations.map(item => ({ status: item.status, finalUrl: item.finalUrl, sameDocumentInstance: item.sameDocumentInstance, fields: item.document.fields, requests: item.requests })),
    notFound: { finalUrl: notFoundObservation.finalUrl, document: notFoundObservation.document, requests: notFoundObservation.requests },
    history: {
      beforeScrollY: historyBefore.scrollY,
      back: { scrollY: historyBack.document.scrollY, historyValue: historyBack.document.fields['history-edit'], lifecycle: historyBack.document.lifecycle },
      forward: { scrollY: historyForward.document.scrollY, lifecycle: historyForward.document.lifecycle },
    },
    targets: targetObservations.map(item => item.target === 'named' ? { target: 'named', first: item.first, reuse: item.reuse } : { target: item.target, pageCount: item.pageCount, samePageObject: item.samePageObject, openedUrl: item.openedUrl || null }),
    charset: charsetObservations.map(item => ({ id: item.id, characterSet: item.document.characterSet, decodedText: item.document.decodedText })),
    mimeDocuments: mimeObservations.map(item => ({ id: item.id, responseStatus: item.responseStatus, bodyText: item.document.bodyText, nodes: item.document.nodes, preformatted: item.viewerDom.preformatted, buttons: item.viewerDom.buttons, openShadowRoots: item.viewerDom.openShadowRoots })),
    responseStyleProbes: styleProbes.map(item => ({ width: item.width, colorScheme: item.colorScheme, canvasCornerPixel: item.viewportCornerPixel, nodes: item.document.nodes })),
    browserIssues,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
