import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture real Chrome clipboard output for a small inline linear-math corpus.
// Run with: node apps/android/tool/parity/capture_linear_math_clipboard_web.mjs
// The expected fixture is generated from navigator.clipboard.read(), never
// inferred from the DOM selection or handwritten copy strings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/linear-math-clipboard-expected.json');
const outputName = 'fixtures/mobile-parity/linear-math-clipboard-expected.json';
const cases = [
  { id: 'a-plus-b', expression: 'a+b' },
  { id: 'x-plus-y', expression: 'x+y' },
  { id: '12-plus-34', expression: '12+34' },
  { id: 'a-minus-b', expression: 'a-b' },
  { id: 'x-equals-y', expression: 'x=y' },
  { id: 'ab', expression: 'ab' },
  { id: 'parenthesized-a-plus-b', expression: '(a+b)' },
  { id: 'a-plus-b-plus-c', expression: 'a+b+c' },
  { id: 'alpha-plus-beta', expression: '\\alpha+\\beta' },
].map(item => ({ ...item, source: `Before $${item.expression}$ after.` }));

// The Markdown renderer and its two production stylesheets must be the pinned
// Web implementation. The worktree may contain newer Web parity tooling.
execFileSync(
  'git',
  ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root },
);
const katexPackage = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/katex/package.json'), 'utf8'),
);
assert.equal(katexPackage.version, '0.16.47', 'unexpected local KaTeX version');

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browserExecutable = requireTestBrowserExecutable();
const fixtureSource = JSON.stringify(cases).replaceAll('<', '\\u003c');
const temporaryCache = resolve('/private/tmp', `pirc-linear-math-vite-cache-${process.pid}`);
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: temporaryCache,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: {
    host: '127.0.0.1',
    port: 18948,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'linear-math-clipboard-oracle',
      configureServer(vite) {
        vite.middlewares.use('/linear-math-clipboard.html', async (_, res, next) => {
          try {
            const html = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>Linear math clipboard oracle</title>
<style>
html,body{margin:0;min-height:100%;}
body{overflow:auto!important;}
#fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;}
</style></head><body>
<main id="fixture" class="markdown"></main>
<script type="module">
import '/src/app.css';
import '/src/markdown.css';
import { loadKatex, renderMarkdown } from '/src/lib/markdown.ts';
const cases = ${fixtureSource};
await loadKatex();
await document.fonts.ready;
window.mountCase = source => {
  const root = document.querySelector('#fixture');
  root.innerHTML = renderMarkdown(source);
  return root;
};
window.__copyProbe = { copyEvents: 0 };
document.addEventListener('copy', () => { window.__copyProbe.copyEvents += 1; });
window.linearMathClipboardPageReady = true;
</script></body></html>`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await vite.transformIndexHtml('/linear-math-clipboard.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object', 'Vite did not expose its local server port');
  const url = `http://127.0.0.1:${address.port}/linear-math-clipboard.html`;
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });

  const viewport = { width: 390, height: 1100 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.linearMathClipboardPageReady === true);
  } catch (error) {
    console.error(JSON.stringify({ pageTitle: await page.title(), pageText: await page.locator('body').innerText(), browserErrors }));
    throw error;
  }

  const captures = [];
  const htmlSamplesByCase = Object.create(null);
  for (const item of cases) {
    const rendered = await page.evaluate(async source => {
      const root = window.mountCase(source);
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const formulas = [...root.querySelectorAll('.katex,.katex-error')].map(node => {
        const mathml = node.querySelector('.katex-mathml');
        const html = node.querySelector('.katex-html');
        return {
          kind: node.classList.contains('katex-error') ? 'whole-expression-error' : 'rendered',
          annotation: node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null,
          mathmlText: mathml?.textContent ?? null,
          htmlText: html?.innerText ?? html?.textContent ?? null,
          htmlAriaHidden: html?.getAttribute('aria-hidden') ?? null,
        };
      });
      const target = root.querySelector('p') || root.firstElementChild || root;
      const rect = target.getBoundingClientRect();
      return {
        formulas,
        rootTextBeforeSelection: root.innerText,
        clickPoint: {
          x: Math.min(rect.right - 1, rect.left + Math.max(2, Math.min(rect.width / 2, 24))),
          y: Math.min(rect.bottom - 1, rect.top + Math.max(2, Math.min(rect.height / 2, 12))),
        },
      };
    }, item.source);
    assert.equal(rendered.formulas.length, 1, `${item.id}: expected one rendered formula`);
    assert.equal(rendered.formulas[0].annotation, item.expression, `${item.id}: unexpected TeX annotation`);

    await page.mouse.click(rendered.clickPoint.x, rendered.clickPoint.y);
    await page.keyboard.press('Meta+A');
    const sourceSelection = await page.evaluate(() => {
      const selected = window.getSelection();
      return {
        text: selected?.toString() ?? '',
        rangeCount: selected?.rangeCount ?? 0,
        isCollapsed: selected?.isCollapsed ?? null,
      };
    });
    assert.ok(sourceSelection.rangeCount > 0, `${item.id}: Meta+A did not create a selection`);

    await page.evaluate(() => { window.__copyProbe.copyEvents = 0; });
    await page.keyboard.press('Meta+C');
    await page.waitForTimeout(20);
    const clipboardRead = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const records = [];
      for (const clipboardItem of items) {
        const formats = {};
        for (const type of clipboardItem.types) {
          formats[type] = await (await clipboardItem.getType(type)).text();
        }
        records.push(formats);
      }
      return { records, copyEventCount: window.__copyProbe.copyEvents };
    });
    assert.equal(clipboardRead.copyEventCount, 1, `${item.id}: expected one native copy event`);
    assert.equal(clipboardRead.records.length, 1, `${item.id}: expected one clipboard item`);
    const clipboard = clipboardRead.records[0];
    assert.equal(typeof clipboard['text/plain'], 'string', `${item.id}: missing text/plain clipboard data`);
    const html = typeof clipboard['text/html'] === 'string' ? clipboard['text/html'] : null;
    const htmlSha256 = html === null ? null : createHash('sha256').update(html, 'utf8').digest('hex');
    htmlSamplesByCase[item.id] = html === null ? null : {
      markup: html,
      sha256: htmlSha256,
      utf8Bytes: Buffer.byteLength(html, 'utf8'),
    };
    captures.push({
      id: item.id,
      expression: item.expression,
      source: item.source,
      formulaMetadata: rendered.formulas,
      rootTextBeforeSelection: rendered.rootTextBeforeSelection,
      sourceSelection: {
        method: 'Chrome keyboard Meta+A; read Selection.toString() separately from clipboard data',
        text: sourceSelection.text,
        utf8Bytes: Buffer.byteLength(sourceSelection.text, 'utf8'),
        rangeCount: sourceSelection.rangeCount,
        isCollapsed: sourceSelection.isCollapsed,
      },
      actualClipboard: {
        method: 'Chrome keyboard Meta+C followed by navigator.clipboard.read()',
        copyEventCount: clipboardRead.copyEventCount,
        formats: Object.keys(clipboard).sort(),
        textPlain: clipboard['text/plain'],
        textPlainUtf8Bytes: Buffer.byteLength(clipboard['text/plain'], 'utf8'),
        textHtmlAvailable: html !== null,
        textHtmlSha256: htmlSha256,
        textHtmlUtf8Bytes: html === null ? null : Buffer.byteLength(html, 'utf8'),
      },
    });
  }
  assert.deepEqual(browserErrors, [], 'unexpected browser errors');
  await context.close();

  const expected = {
    fixture: outputName,
    webRevision: revision,
    capturedAt: new Date().toISOString(),
    browser: {
      name: 'Google Chrome',
      version: browser.version(),
      executable: browserExecutable,
      viewport: { ...viewport, deviceScaleFactor: 1 },
      theme: 'light',
      textScale: 1,
      locale: 'en-US',
    },
    renderer: {
      api: 'apps/web/src/lib/markdown.ts renderMarkdown() -> KaTeX.renderToString()',
      stylesheets: ['apps/web/src/app.css', 'apps/web/src/markdown.css', 'katex/dist/katex.min.css via markdown.ts'],
      katexVersion: katexPackage.version,
    },
    captureMethod: {
      focus: 'Pointer click into the rendered paragraph, then Chrome keyboard Meta+A.',
      sourceSelection: 'Selection.toString() is recorded as a separate diagnostic value.',
      clipboard: 'Chrome keyboard Meta+C is sent without a copy handler; navigator.clipboard.read() captures the real clipboard formats.',
      permissions: ['clipboard-read', 'clipboard-write'],
      noCopyHandler: true,
      noTrimOrUnicodeNormalization: true,
    },
    normalization: {
      textPlain: 'Exact text/plain string returned by Chrome Clipboard API; no trimming, Unicode normalization, newline conversion, or reconstruction.',
      textHtml: 'Exact text/html string returned by Chrome is stored per case; SHA-256 is over its UTF-8 bytes.',
      formulaMetadata: 'KaTeX annotation and MathML/HTML text are read from the production-rendered DOM and stored separately from clipboard contents.',
    },
    cases: captures,
    clipboardHtmlSamplesByCase: htmlSamplesByCase,
    coverage: {
      caseCount: captures.length,
      actualKeyboardCopyCount: captures.reduce((count, item) => count + item.actualClipboard.copyEventCount, 0),
      viewportConfigurationCount: 1,
      expressions: cases.map(({ id, expression }) => ({ id, expression })),
      scope: 'Small observed linear-expression corpus; this fixture does not claim full math grammar or pixel parity.',
    },
  };
  await writeFile(fixturePath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    revision,
    browser: expected.browser.version,
    configuration: '390-light-1',
    cases: captures.length,
    actualKeyboardCopies: expected.coverage.actualKeyboardCopyCount,
    outputPath: fixturePath,
    observed: captures.map(item => ({
      id: item.id,
      textPlain: item.actualClipboard.textPlain,
      formulaAnnotation: item.formulaMetadata[0].annotation,
      formats: item.actualClipboard.formats,
    })),
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(temporaryCache, { recursive: true, force: true });
}
