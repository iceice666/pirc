import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_named_properties_web.mjs
// Capture Chromium's DOMPurify SANITIZE_DOM named-property set and a rendered
// HTML corpus. The Dart constant is generated from the captured blocked names.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const webRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync('git', ['diff', '--exit-code', webRevision, '--', 'apps/web'], {
  cwd: root,
});

const cases = [
  { key: 'hidden', id: 'hidden', name: 'hidden' },
  { key: 'action', id: 'action', name: 'action' },
  { key: 'reset', id: 'reset', name: 'reset' },
  { key: 'length', id: 'length', name: 'length' },
  { key: 'constructor', id: 'constructor', name: 'constructor' },
  { key: 'double-underscore-proto', id: '__proto__', name: '__proto__' },
  { key: 'prototype', id: 'prototype', name: 'prototype' },
  { key: 'uppercase-hidden', id: 'Hidden', name: 'Hidden' },
  { key: 'safe-id-and-name', id: 'safeID', name: 'safeID' },
  { key: 'id-blocked-name-allowed', id: 'hidden', name: 'pirc-safe-name' },
  { key: 'id-allowed-name-blocked', id: 'pirc-safe-id', name: 'action' },
  { key: 'ascii-space-edges', id: ' hidden ', name: ' action ' },
  { key: 'ascii-tab-newline-edges', id: '\thidden\n', name: '\nreset\t' },
  { key: 'unicode-nbsp-bom-hidden', id: '\u00a0\ufeffhidden\ufeff\u00a0', name: '\u00a0\ufeffhidden\ufeff\u00a0' },
  { key: 'unicode-0085-safe-id', id: '\u0085safeID\u0085', name: '\u0085safeID\u0085' },
  { key: 'unicode-em-space-safe-id', id: '\u2003safeID\u2003', name: '\u2003safeID\u2003' },
  { key: 'allowed-name-attribute', id: 'pirc-safe-id-2', name: 'custom-field' },
];
const outputDir = resolve(root, 'apps/android/build/parity');
await mkdir(outputDir, { recursive: true });
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache-html-named-properties'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18920,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'html-named-properties-parity',
      configureServer(server) {
        server.middlewares.use('/named-properties.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head>
              <link rel="icon" href="data:,">
              <meta name="viewport" content="width=device-width,initial-scale=1">
            </head><body>
              <script type="module">
                import { renderMarkdown } from '/src/lib/markdown.ts';
                const cases = ${JSON.stringify(cases).replaceAll('<', '\\u003c').replaceAll('\u0085', '\\u0085')};
                const escapeAttribute = value => value
                  .replaceAll('&', '&amp;')
                  .replaceAll('"', '&quot;')
                  .replaceAll('<', '&lt;')
                  .replaceAll('\\t', '&#9;')
                  .replaceAll('\\n', '&#10;')
                  .replaceAll('\\r', '&#13;')
                  .replaceAll('\\u00a0', '&#160;')
                  .replaceAll('\\ufeff', '&#65279;')
                  .replaceAll('\\u2003', '&#8195;');
                const corpusSource = cases.map(item =>
                  '<input data-named-property-case="' + item.key + '" id="' +
                  escapeAttribute(item.id) + '" name="' + escapeAttribute(item.name) + '">'
                ).join('\\n');
                const propertyChain = object => {
                  const chain = [];
                  let current = object;
                  while (current !== null) {
                    const descriptor = Object.getOwnPropertyDescriptor(current, 'constructor');
                    const constructor = descriptor?.value;
                    chain.push({
                      level: chain.length,
                      owner: chain.length === 0 ? 'instance' :
                        (typeof constructor === 'function' ? constructor.name : '(anonymous)'),
                      ownPropertyNames: Object.getOwnPropertyNames(current).sort(),
                    });
                    current = Object.getPrototypeOf(current);
                  }
                  return chain;
                };
                window.captureNamedProperties = () => {
                  const form = document.createElement('form');
                  const documentPrototypeChain = propertyChain(document);
                  const formPrototypeChain = propertyChain(form);
                  const candidates = [...new Set([
                    ...documentPrototypeChain.flatMap(level => level.ownPropertyNames),
                    ...formPrototypeChain.flatMap(level => level.ownPropertyNames),
                  ])].sort();
                  const blockedNames = candidates.filter(name => name in document || name in form);
                  const sanitizedHtml = renderMarkdown(corpusSource);
                  const template = document.createElement('template');
                  template.innerHTML = sanitizedHtml;
                  const sanitizedCases = [...template.content.querySelectorAll('[data-named-property-case]')]
                    .map(element => {
                      const key = element.getAttribute('data-named-property-case');
                      const input = cases.find(item => item.key === key);
                      return {
                        key,
                        input: { id: input.id, name: input.name },
                        output: {
                          id: element.getAttribute('id'),
                          name: element.getAttribute('name'),
                          html: element.outerHTML,
                        },
                      };
                    });
                  return {
                    documentPrototypeChain,
                    formPrototypeChain,
                    blockedNames,
                    sanitizedHtml,
                    sanitizedCases,
                  };
                };
                window.namedPropertiesCorpusSource = corpusSource;
                window.namedPropertiesCorpusCases = cases;
                window.fixtureReady = true;
              </script>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/named-properties.html', html));
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
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const browserVersion = browser.version();
  if (!browserVersion.startsWith('154.')) {
    throw new Error(`Expected Chrome 154, got ${browserVersion}`);
  }
  const page = await browser.newPage({ locale: 'en-US' });
  await page.goto('http://127.0.0.1:18920/named-properties.html');
  await page.waitForFunction(() => window.fixtureReady);
  const captured = await page.evaluate(() => ({
    ...window.captureNamedProperties(),
    corpusSource: window.namedPropertiesCorpusSource,
    corpusCases: window.namedPropertiesCorpusCases,
    userAgent: navigator.userAgent,
  }));

  const codePoints = value => Array.from(value, character => {
    const codePoint = character.codePointAt(0);
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  });
  const fixture = {
    browser: `Chrome ${browserVersion}`,
    userAgent: captured.userAgent,
    domPurifyVersion: '3.4.16',
    webRevision,
    rule: 'DOMPurify trims id/name attribute values, then SANITIZE_DOM rejects them when value in document || value in formElement.',
    inventory: {
      documentPrototypeChain: captured.documentPrototypeChain,
      formPrototypeChain: captured.formPrototypeChain,
      blockedNames: captured.blockedNames,
    },
    sanitizedCorpus: {
      source: captured.corpusSource,
      cases: captured.sanitizedCases.map(item => ({
        ...item,
        inputCodePoints: {
          id: codePoints(item.input.id),
          name: codePoints(item.input.name),
        },
      })),
      html: captured.sanitizedHtml,
    },
    notes: 'The inventory captures this Chrome document and its form prototype chain. Browser versions, enabled features, and document state can change named-property behavior; this is a pinned parity set, not a universal sanitizer implementation. DOMPurify uses ECMAScript String.trim before the collision check: NBSP, BOM, and U+2003 trim, while U+0085 does not.',
  };
  const fixturePath = resolve(root, 'fixtures/mobile-parity/html-named-properties.json');
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const dartEntries = captured.blockedNames
    .map(name => `  ${JSON.stringify(name)},`)
    .join('\n');
  const dartSource = `// Generated by capture_html_named_properties_web.mjs from ${fixture.browser} and DOMPurify 3.4.16.\n// This mirrors the captured \`value in document || value in formElement\` filter.\n// Browser features and document state vary, so this is a pinned parity set rather than a universal sanitizer rule.\nconst Set<String> nativeHtmlBlockedNamedProperties = <String>{\n${dartEntries}\n};\n`;
  await writeFile(
    resolve(root, 'apps/android/lib/rendering/html_named_properties.dart'),
    dartSource,
  );

  console.log(
    `Captured ${captured.blockedNames.length} blocked names from ${browserVersion}; ` +
      `${captured.sanitizedCases.length} sanitized cases written.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
