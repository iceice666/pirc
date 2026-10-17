import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture actual Chrome clipboard output for the pinned Markdown/KaTeX inline
// math corpus. The DOM selection string and clipboard text are stored as
// separate observations: they are not interchangeable.
//
// Full run:
//   node apps/android/tool/parity/capture_inline_math_clipboard_web.mjs
// Bounded run:
//   PIRC_INLINE_MATH_CLIPBOARD_CONFIGS=390-light-1,768-light-1 \
//   PIRC_INLINE_MATH_CLIPBOARD_CASES=inline-before-after,inline-cjk-prose \
//   node apps/android/tool/parity/capture_inline_math_clipboard_web.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/inline-math-paragraph.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned Web source');
assert.equal(fixture.cases.length, 17, 'unexpected inline-math paragraph case count');
assert.deepEqual(fixture.capture.widths, [390, 650, 651, 768, 860, 861, 1024]);
assert.deepEqual(fixture.capture.themes, ['light', 'dark']);
assert.deepEqual(fixture.capture.textScales, [1, 2]);
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
const outputDir = resolve(root, 'apps/android/build/parity/inline-math-clipboard-web');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const configFilter = process.env.PIRC_INLINE_MATH_CLIPBOARD_CONFIGS;
const caseFilter = process.env.PIRC_INLINE_MATH_CLIPBOARD_CASES;
const selectedCases = caseFilter
  ? fixture.cases.filter(item => caseFilter.split(',').includes(item.id))
  : fixture.cases;
assert.notEqual(selectedCases.length, 0, `unknown inline-math clipboard case filter: ${caseFilter}`);
const selectedConfigurations = [];
for (const width of fixture.capture.widths) {
  for (const theme of fixture.capture.themes) {
    for (const textScale of fixture.capture.textScales) {
      const id = `${width}-${theme}-${textScale}`;
      if (!configFilter || configFilter.split(',').includes(id)) {
        selectedConfigurations.push({ id, width, theme, textScale });
      }
    }
  }
}
assert.notEqual(selectedConfigurations.length, 0, `unknown clipboard configuration filter: ${configFilter}`);

const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18947,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'inline-math-clipboard-oracle',
      configureServer(vite) {
        vite.middlewares.use('/inline-math-clipboard.html', async (_, res, next) => {
          try {
            const html = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>Inline math clipboard oracle</title>
<style>
html,body{margin:0;min-height:100%;}
body{overflow:auto!important;}
#fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;}
</style></head><body>
<main id="fixture" class="markdown"></main>
<script type="module">
import '/src/app.css';
import '/src/markdown.css';
import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';
const fixture = ${fixtureSource};
await preloadRenderers();
await document.fonts.ready;
window.mountInlineMathSource = source => {
  const root = document.querySelector('#fixture');
  root.innerHTML = renderMarkdown(source);
  return root;
};
window.__copyProbe = { copyEvents: 0 };
document.addEventListener('copy', () => { window.__copyProbe.copyEvents += 1; });
window.inlineMathClipboardPageReady = true;
</script></body></html>`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await vite.transformIndexHtml('/inline-math-clipboard.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
const configurations = [];
const htmlSamplesByCase = Object.create(null);
const browserErrors = [];
try {
  await server.listen();
  for (const { id: configId, width, theme, textScale } of selectedConfigurations) {
    const context = await browser.newContext({
      viewport: { width, height: fixture.capture.height },
      deviceScaleFactor: fixture.capture.deviceScaleFactor,
      colorScheme: theme,
      locale: 'en-US',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const contextName = `${width}/${theme}/${textScale}`;
    page.on('pageerror', error => browserErrors.push(`${contextName}: ${error.stack || error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(`${contextName}: ${message.text()}`);
    });
    await page.goto('http://127.0.0.1:18947/inline-math-clipboard.html', { waitUntil: 'load' });
    await page.waitForFunction(() => window.inlineMathClipboardPageReady === true);

    const captures = [];
    for (const item of selectedCases) {
      const rendered = await page.evaluate(async ({ source, scale }) => {
        const root = window.mountInlineMathSource(source);
        root.style.setProperty('--fixture-scale', String(scale));
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const formulas = [...root.querySelectorAll('.katex,.katex-error')].map(node => ({
          kind: node.classList.contains('katex-error')
            ? 'whole-expression-error'
            : [node, ...node.querySelectorAll('*')].some(element => getComputedStyle(element).color === 'rgb(204, 0, 0)')
              ? 'rendered-with-unsupported-command' : 'rendered',
          annotation: node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null,
          mathmlText: node.querySelector('.katex-mathml')?.textContent ?? null,
          htmlText: node.querySelector('.katex-html')?.innerText ?? node.querySelector('.katex-html')?.textContent ?? null,
          mathmlUserSelect: node.querySelector('.katex-mathml') ? getComputedStyle(node.querySelector('.katex-mathml')).userSelect : null,
          htmlAriaHidden: node.querySelector('.katex-html')?.getAttribute('aria-hidden') ?? null,
        }));
        return {
          formulaCount: formulas.length,
          formulas,
          rootTextBeforeSelection: root.innerText,
          clickPoint: (() => {
            const target = root.querySelector('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,table') || root.firstElementChild || root;
            const rect = target.getBoundingClientRect();
            return { x: Math.min(rect.right - 1, rect.left + Math.max(2, Math.min(rect.width / 2, 24))),
              y: Math.min(rect.bottom - 1, rect.top + Math.max(2, Math.min(rect.height / 2, 12))) };
          })(),
        };
      }, { source: item.source, scale: textScale });
      assert.equal(rendered.formulaCount, item.expectedMathCount, `${configId}/${item.id}: unexpected formula count`);

      await page.mouse.click(rendered.clickPoint.x, rendered.clickPoint.y);
      await page.keyboard.press('Meta+A');
      const selection = await page.evaluate(() => {
        const selected = window.getSelection();
        const nodePath = node => {
          const path = [];
          for (let current = node; current && current !== document; current = current.parentNode) {
            let siblingIndex = 0;
            for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) siblingIndex += 1;
            const name = current.nodeType === Node.TEXT_NODE
              ? '#text'
              : current.nodeType === Node.ELEMENT_NODE
                ? `${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ''}${typeof current.className === 'string' && current.className ? `.${current.className.trim().replace(/\s+/g, '.')}` : ''}`
                : current.nodeName;
            path.unshift({ name, siblingIndex, textLength: current.nodeType === Node.TEXT_NODE ? current.nodeValue?.length ?? 0 : null });
          }
          return path;
        };
        return {
          text: selected?.toString() ?? '',
          rangeCount: selected?.rangeCount ?? 0,
          anchorNodeName: selected?.anchorNode?.nodeName ?? null,
          anchorOffset: selected?.anchorOffset ?? null,
          anchorPath: selected?.anchorNode ? nodePath(selected.anchorNode) : null,
          focusNodeName: selected?.focusNode?.nodeName ?? null,
          focusOffset: selected?.focusOffset ?? null,
          focusPath: selected?.focusNode ? nodePath(selected.focusNode) : null,
          isCollapsed: selected?.isCollapsed ?? null,
        };
      });
      assert.ok(selection.rangeCount > 0, `${configId}/${item.id}: Meta+A did not create a selection`);

      await page.evaluate(() => { window.__copyProbe.copyEvents = 0; });
      await page.keyboard.press('Meta+C');
      await page.waitForTimeout(20);
      const clipboardItems = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const records = [];
        for (const item of items) {
          const formats = {};
          for (const type of item.types) {
            const blob = await item.getType(type);
            formats[type] = await blob.text();
          }
          records.push(formats);
        }
        return { records, copyEvents: window.__copyProbe.copyEvents };
      });
      assert.equal(clipboardItems.copyEvents, 1, `${configId}/${item.id}: did not observe exactly one browser copy event`);
      assert.equal(clipboardItems.records.length, 1, `${configId}/${item.id}: expected one clipboard item`);
      const clipboard = clipboardItems.records[0];
      assert.equal(typeof clipboard['text/plain'], 'string', `${configId}/${item.id}: Chrome supplied no text/plain clipboard data`);
      const plainText = clipboard['text/plain'];
      const html = typeof clipboard['text/html'] === 'string' ? clipboard['text/html'] : null;
      const htmlSha256 = html === null ? null : createHash('sha256').update(html, 'utf8').digest('hex');
      const htmlUtf8Bytes = html === null ? null : Buffer.byteLength(html, 'utf8');
      if (html !== null && htmlSamplesByCase[item.id] === undefined) {
        htmlSamplesByCase[item.id] = {
          capturedConfiguration: configId,
          sha256: htmlSha256,
          utf8Bytes: htmlUtf8Bytes,
          markup: html,
        };
      }
      const clipboardNow = await page.evaluate(() => ({ copyEvents: window.__copyProbe.copyEvents }));
      captures.push({
        id: item.id,
        formulaCount: rendered.formulaCount,
        formulaMetadata: rendered.formulas,
        rootTextBeforeSelection: rendered.rootTextBeforeSelection,
        sourceSelectionText: selection.text,
        selectionUtf8Bytes: Buffer.byteLength(selection.text, 'utf8'),
        selection: {
          method: 'Chrome keyboard Meta+A after pointer focus; captured Selection.toString() without assigning a Range in script',
          rangeCount: selection.rangeCount,
          isCollapsed: selection.isCollapsed,
          anchorNodeName: selection.anchorNodeName,
          anchorOffset: selection.anchorOffset,
          anchorPath: selection.anchorPath,
          focusNodeName: selection.focusNodeName,
          focusOffset: selection.focusOffset,
          focusPath: selection.focusPath,
        },
        actualClipboard: {
          method: 'Chrome keyboard Meta+C followed by navigator.clipboard.read()',
          copyEventCount: clipboardNow.copyEvents,
          formats: Object.keys(clipboard).sort(),
          textPlain: plainText,
          textPlainUtf8Bytes: Buffer.byteLength(plainText, 'utf8'),
          textHtmlAvailable: html !== null,
          textHtmlSha256: htmlSha256,
          textHtmlUtf8Bytes: htmlUtf8Bytes,
        },
      });
    }
    configurations.push({ id: configId, viewport: { width, height: fixture.capture.height }, theme, textScale,
      deviceScaleFactor: fixture.capture.deviceScaleFactor, cases: captures });
    await context.close();
  }
  assert.deepEqual(browserErrors, [], 'unexpected browser errors');
  if (!configFilter && !caseFilter) assert.equal(configurations.length, 28);
  assert.equal(
    configurations.reduce((count, configuration) => count + configuration.cases.length, 0),
    selectedConfigurations.length * selectedCases.length,
  );
  assert.equal(Object.keys(htmlSamplesByCase).length, selectedCases.length,
    'expected one deduplicated rich-HTML sample per captured source case');

  const expected = {
    fixture: 'fixtures/mobile-parity/inline-math-paragraph.json',
    webRevision: revision,
    capturedAt: new Date().toISOString(),
    browser: {
      name: 'Google Chrome',
      version: browser.version(),
      executable: requireTestBrowserExecutable(),
      deviceScaleFactor: fixture.capture.deviceScaleFactor,
      viewportWidths: fixture.capture.widths,
      height: fixture.capture.height,
      themes: fixture.capture.themes,
      textScales: fixture.capture.textScales,
      configurationFilter: configFilter ?? 'all',
      caseFilter: caseFilter ?? 'all',
    },
    renderer: {
      api: 'apps/web/src/lib/markdown.ts renderMarkdown() -> KaTeX.renderToString()',
      katexVersion: katexPackage.version,
      output: 'htmlAndMathml',
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      maxExpand: 500,
    },
    captureMethod: {
      focus: 'Pointer click into the first rendered text block, then Chrome keyboard Meta+A.',
      sourceSelection: 'After Meta+A, read window.getSelection().toString() as a separate observation; no script-created Range is assigned.',
      clipboard: 'Send Chrome keyboard Meta+C, observe the native copy event without preventing it, then read navigator.clipboard.read().',
      permissions: ['clipboard-read', 'clipboard-write'],
      noCopyHandler: true,
      noTrimOrUnicodeNormalization: true,
      themeAndScale: 'Fresh context per viewport/theme/text-scale; colorScheme is the requested theme and the actual Markdown container font-size is scaled before copy.',
    },
    normalization: {
      sourceSelectionText: 'Exact JavaScript Selection.toString() UTF-16 string; encoded-byte count is UTF-8. Not a clipboard value.',
      textPlain: 'Exact Chrome text/plain clipboard string returned by Clipboard API; no trimming, Unicode normalization, newline conversion, or source reconstruction.',
      textHtml: 'Exact Chrome text/html clipboard string is stored once per source case (first selected configuration); every case/config records its SHA-256 and UTF-8 byte length.',
      hashes: 'SHA-256 is over the UTF-8 bytes of the exact text/html string returned by Clipboard API.',
    },
    sourceCases: selectedCases.map(({ id, description, source }) => ({ id, description, source })),
    clipboardHtmlSamplesByCase: htmlSamplesByCase,
    configurations,
    coverage: {
      configurationCount: configurations.length,
      caseCountPerConfiguration: selectedCases.length,
      actualKeyboardCopyCount: configurations.reduce((count, configuration) => count + configuration.cases.length, 0),
      completeMatrix: !configFilter && !caseFilter,
      sourceSelectionAndClipboardStoredSeparately: true,
    },
  };
  const outputPath = configFilter || caseFilter
    ? resolve(outputDir, `smoke-${(configFilter ?? 'all').replaceAll(',', '_')}-${(caseFilter ?? 'all').replaceAll(',', '_')}.json`)
    : resolve(root, 'fixtures/mobile-parity/inline-math-clipboard-expected.json');
  await writeFile(outputPath, JSON.stringify(expected) + '\n');
  console.log(JSON.stringify({
    revision,
    browser: expected.browser.version,
    configurations: configurations.length,
    casesPerConfiguration: selectedCases.length,
    actualKeyboardCopies: expected.coverage.actualKeyboardCopyCount,
    htmlSamples: Object.keys(htmlSamplesByCase).length,
    outputPath,
    summary: configurations.map(configuration => ({
      id: configuration.id,
      cases: configuration.cases.map(item => ({
        id: item.id,
        formats: item.actualClipboard.formats,
        plainBytes: item.actualClipboard.textPlainUtf8Bytes,
        selectionEqualsPlain: item.sourceSelectionText === item.actualClipboard.textPlain,
      })),
    })),
  }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
