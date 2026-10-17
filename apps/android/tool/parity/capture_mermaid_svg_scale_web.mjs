import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_mermaid_svg_scale_web.mjs
// Captures SVG paint geometry and text metrics before/after Pirc's HTML text scaling.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/mermaid-svg-scale.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const revision = fixture.webRevision;
assert.equal(revision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(fixture.mermaidVersion, '11.17.2');
assert.deepEqual(fixture.widths, [390, 768, 1024]);
assert.deepEqual(fixture.themes, ['light', 'dark']);
assert.deepEqual(fixture.textScales, [1, 2]);
assert.equal(fixture.deviceScaleFactor, 1);
execFileSync(
  'git',
  ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root },
);

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const mermaidPackage = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
assert.equal(mermaidPackage.version, fixture.mermaidVersion);

const outputDir = resolve(root, 'apps/android/build/parity/mermaid-svg-scale-web');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18923,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'mermaid-svg-scale-parity-fixture',
      configureServer(vite) {
        vite.middlewares.use('/svg-scale.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head>
              <link rel="icon" href="data:,">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <style>
                body{overflow:auto!important}
                #fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}
                .mermaid-case{margin:0}
              </style>
            </head><body><main id="fixture" class="markdown"></main>
              <script type="module">
                import '/src/app.css';
                import '/src/markdown.css';
                import { preloadRenderers, renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';

                const fixture = ${fixtureSource};
                const root = document.querySelector('#fixture');
                let action;
                const waitForDiagram = async (block) => {
                  for (let i = 0; i < 300; i++) {
                    if (block.dataset.rendered === 'ok' || block.dataset.rendered === 'error') return;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  throw new Error('Timed out waiting for Mermaid: ' + block.textContent.slice(0, 100));
                };
                const rect = (element) => {
                  if (!element) return null;
                  const b = element.getBoundingClientRect();
                  return { x: b.x, y: b.y, width: b.width, height: b.height };
                };
                const bbox = (element) => {
                  if (!element) return null;
                  try {
                    const b = element.getBBox();
                    return { x: b.x, y: b.y, width: b.width, height: b.height };
                  } catch { return null; }
                };
                const attrs = (element, names) => Object.fromEntries(
                  names.flatMap((name) => {
                    const value = element.getAttribute(name);
                    return value === null ? [] : [[name, value]];
                  }),
                );
                const fontStyle = (style) => ({
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  fontWeight: style.fontWeight,
                  lineHeight: style.lineHeight,
                  fill: style.fill,
                  color: style.color,
                });
                const shapeStyle = (style) => ({
                  fill: style.fill,
                  stroke: style.stroke,
                  strokeWidth: style.strokeWidth,
                  opacity: style.opacity,
                  fillOpacity: style.fillOpacity,
                  strokeOpacity: style.strokeOpacity,
                  lineCap: style.strokeLinecap,
                  lineJoin: style.strokeLinejoin,
                });
                const svgSnapshot = (svg) => ({
                  attrs: attrs(svg, ['width', 'height', 'viewBox', 'preserveAspectRatio', 'role', 'aria-label']),
                  box: rect(svg),
                  worldBox: bbox(svg),
                  computed: {
                    fontFamily: getComputedStyle(svg).fontFamily,
                    fontSize: getComputedStyle(svg).fontSize,
                    lineHeight: getComputedStyle(svg).lineHeight,
                    color: getComputedStyle(svg).color,
                    fill: getComputedStyle(svg).fill,
                    width: getComputedStyle(svg).width,
                    height: getComputedStyle(svg).height,
                    maxWidth: getComputedStyle(svg).maxWidth,
                  },
                  texts: [...svg.querySelectorAll('text,tspan')].map((node) => ({
                    tag: node.tagName.toLowerCase(),
                    text: node.textContent,
                    attrs: attrs(node, ['x', 'y', 'dx', 'dy', 'transform', 'fill', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline']),
                    style: fontStyle(getComputedStyle(node)),
                    rect: rect(node),
                    worldBox: bbox(node),
                    ...(node.matches('text') ? { computedTextLength: node.getComputedTextLength() } : {}),
                  })),
                  foreignObjects: [...svg.querySelectorAll('foreignObject')].map((node) => ({
                    text: node.textContent,
                    attrs: attrs(node, ['x', 'y', 'width', 'height', 'transform']),
                    style: fontStyle(getComputedStyle(node)),
                    rect: rect(node),
                    worldBox: bbox(node),
                    textNodes: [...node.querySelectorAll('*')]
                      .filter((child) => !child.children.length && child.textContent.trim())
                      .map((child) => ({
                        tag: child.tagName.toLowerCase(),
                        class: child.getAttribute('class'),
                        text: child.textContent,
                        style: fontStyle(getComputedStyle(child)),
                        rect: rect(child),
                      })),
                  })),
                  shapes: [...svg.querySelectorAll('path,rect,polygon,circle,line,ellipse,polyline')].map((node) => ({
                    tag: node.tagName.toLowerCase(),
                    class: node.getAttribute('class'),
                    id: node.getAttribute('id'),
                    attrs: attrs(node, ['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'transform', 'fill', 'stroke', 'stroke-width']),
                    style: shapeStyle(getComputedStyle(node)),
                    rect: rect(node),
                    worldBox: bbox(node),
                  })),
                });
                const applyHtmlTextScale = (scale) => {
                  if (scale === 1) return;
                  const svgDefaults = [...document.querySelectorAll('#fixture svg')]
                    .map((svg) => {
                      const style = getComputedStyle(svg);
                      return [svg, style.fontSize, style.lineHeight];
                    });
                  const svgTextDefaults = [...document.querySelectorAll('#fixture svg text, #fixture svg tspan')]
                    .map((node) => {
                      const style = getComputedStyle(node);
                      return [node, style.fontSize, style.lineHeight];
                    });
                  // Snapshot every HTML node before changing any ancestor or child style.
                  const entries = [...document.querySelectorAll('#fixture, #fixture *')]
                    .filter((node) => node instanceof HTMLElement && !node.closest('svg'))
                    .map((node) => {
                      const style = getComputedStyle(node);
                      return [node, parseFloat(style.fontSize), style.lineHeight];
                    });
                  for (const [node, size, line] of entries) {
                    node.style.setProperty('font-size', size * scale + 'px', 'important');
                    if (line !== 'normal') node.style.setProperty('line-height', parseFloat(line) * scale + 'px', 'important');
                  }
                  // Preserve diagram-owned SVG font metrics and all user-space paint geometry.
                  for (const [svg, fontSize, lineHeight] of svgDefaults) {
                    svg.style.setProperty('font-size', fontSize, 'important');
                    if (lineHeight !== 'normal') svg.style.setProperty('line-height', lineHeight, 'important');
                  }
                  for (const [node, fontSize, lineHeight] of svgTextDefaults) {
                    node.style.setProperty('font-size', fontSize, 'important');
                    if (lineHeight !== 'normal') node.style.setProperty('line-height', lineHeight, 'important');
                  }
                };
                window.captureCase = async (id, scale) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown Mermaid case: ' + id);
                  // Reset the persistent root before each case so textScale never compounds.
                  root.style.removeProperty('font-size');
                  root.style.removeProperty('line-height');
                  const html = renderMarkdown(item.source);
                  root.innerHTML = html;
                  const block = root.querySelector('.mermaid-block');
                  if (!block) throw new Error('Markdown did not create a Mermaid block for ' + id);
                  if (!action) action = enhanceMarkdown(root, { html, ready: true });
                  else action.update({ html, ready: true });
                  await waitForDiagram(block);
                  await document.fonts.ready;
                  const svg = block.querySelector('.mermaid-figure svg');
                  applyHtmlTextScale(scale);
                  await document.fonts.ready;
                  const blockStyle = getComputedStyle(block);
                  const figure = block.querySelector('.mermaid-figure');
                  const figureStyle = figure ? getComputedStyle(figure) : null;
                  return {
                    id,
                    kind: item.kind,
                    textScale: scale,
                    status: block.dataset.rendered ?? 'missing',
                    source: block.querySelector('.mermaid-source code')?.textContent ?? null,
                    block: {
                      box: rect(block),
                      fontSize: blockStyle.fontSize,
                      lineHeight: blockStyle.lineHeight,
                      background: blockStyle.backgroundColor,
                    },
                    figure: figure ? {
                      box: rect(figure),
                      fontSize: figureStyle.fontSize,
                      lineHeight: figureStyle.lineHeight,
                    } : null,
                    svg: svg ? svgSnapshot(svg) : null,
                    errorText: block.querySelector('.mermaid-error')?.textContent ?? null,
                  };
                };
                await preloadRenderers();
                window.destroyMarkdownEnhancer = () => action?.destroy();
                window.fixtureReady = true;
              </script>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/svg-scale.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

function svgScaleSignature(snapshot) {
  const svg = snapshot.svg;
  return {
    attrs: svg.attrs,
    worldBox: svg.worldBox,
    texts: svg.texts.map(({ rect: _rect, ...node }) => node),
    foreignObjects: svg.foreignObjects.map(({ rect: _rect, textNodes, ...node }) => ({
      ...node,
      textNodes: textNodes.map(({ rect: _textRect, ...textNode }) => textNode),
    })),
    shapes: svg.shapes.map(({ rect: _rect, ...shape }) => shape),
  };
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const themes = {};
  const scaleComparisons = [];
  for (const colorScheme of fixture.themes) {
    const widthRows = [];
    for (const width of fixture.widths) {
      const scaleRows = [];
      const perScale = {};
      for (const textScale of fixture.textScales) {
        const page = await browser.newPage({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: fixture.deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
          locale: 'en-US',
          colorScheme,
        });
        const pageErrors = [];
        const consoleErrors = [];
        const badResponses = [];
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('response', (response) => {
          if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
        });
        try {
          await page.goto('http://127.0.0.1:18923/svg-scale.html');
          await page.waitForFunction(() => window.fixtureReady);
          const rows = [];
          for (const item of fixture.cases) {
            const beforeErrors = consoleErrors.length;
            const snapshot = await page.evaluate(
              ({ id, scale }) => window.captureCase(id, scale),
              { id: item.id, scale: textScale },
            );
            snapshot.pageErrors = [...pageErrors];
            snapshot.consoleErrors = consoleErrors.slice(beforeErrors);
            assert.equal(snapshot.status, 'ok', `Mermaid failed: ${item.id} ${snapshot.errorText}`);
            assert.ok(snapshot.svg, `Missing SVG for ${item.id}`);
            assert.ok(snapshot.svg.attrs.viewBox, `Missing viewBox for ${item.id}`);
            assert.ok(snapshot.svg.texts.length + snapshot.svg.foreignObjects.length > 0, `No labels for ${item.id}`);
            assert.equal(snapshot.pageErrors.length, 0, snapshot.pageErrors.join('\n'));
            assert.equal(snapshot.consoleErrors.length, 0, snapshot.consoleErrors.join('\n'));
            assert.equal(badResponses.length, 0, badResponses.join('\n'));
            rows.push(snapshot);
            await page.screenshot({
              path: resolve(outputDir, `${item.id}-${width}-${colorScheme}-scale${textScale}.png`),
              fullPage: true,
            });
          }
          await page.evaluate(() => window.destroyMarkdownEnhancer?.());
          perScale[textScale] = rows;
          scaleRows.push({ textScale, cases: rows });
        } finally {
          await page.close();
        }
      }
      const atOne = new Map(perScale[1].map((snapshot) => [snapshot.id, snapshot]));
      for (const atTwo of perScale[2]) {
        const atOneSnapshot = atOne.get(atTwo.id);
        const oneSignature = svgScaleSignature(atOneSnapshot);
        const twoSignature = svgScaleSignature(atTwo);
        assert.deepEqual(twoSignature, oneSignature,
          `SVG attributes, paint geometry, or text font metrics changed with text scale: ${colorScheme}/${width}/${atTwo.id}`);
        assert.equal(atTwo.block.fontSize, `${parseFloat(atOneSnapshot.block.fontSize) * 2}px`,
          `HTML text size did not scale once: ${colorScheme}/${width}/${atTwo.id}`);
        scaleComparisons.push({
          id: atTwo.id,
          theme: colorScheme,
          width,
          svgPaintGeometryAndFontsUnchanged: true,
          viewBox: atOneSnapshot.svg.attrs.viewBox,
          svgWorldBox: atOneSnapshot.svg.worldBox,
          svgClientBoxAtScale1: atOneSnapshot.svg.box,
          svgClientBoxAtScale2: atTwo.svg.box,
          labelFontSizes: [...atOneSnapshot.svg.texts.map((text) => text.style.fontSize),
            ...atOneSnapshot.svg.foreignObjects.flatMap((node) => [node.style.fontSize, ...node.textNodes.map((child) => child.style.fontSize)])],
          htmlBlockFontSize: { scale1: atOneSnapshot.block.fontSize, scale2: atTwo.block.fontSize },
          htmlBlockHeight: { scale1: atOneSnapshot.block.box.height, scale2: atTwo.block.box.height },
        });
      }
      widthRows.push({ width, scales: scaleRows });
    }
    themes[colorScheme] = { widths: widthRows };
  }

  const resultDocument = {
    fixture: fixture.id,
    reference: revision,
    mermaidVersion: mermaidPackage.version,
    chromeVersion: browser.version(),
    deviceScaleFactor: fixture.deviceScaleFactor,
    matrix: { widths: fixture.widths, themes: fixture.themes, textScales: fixture.textScales, height: fixture.height },
    scalePolicy: 'Per chart, restore #fixture font-size and line-height before rendering. After Mermaid has rendered, snapshot all HTML computed font sizes before writing, then scale HTML text only. Freeze the measured SVG root and text/tspan font-size and line-height to their original values. SVG paint comparison includes viewBox, user-space BBoxes, raw paint geometry attributes, computed fill/stroke/font metrics; client boxes are recorded per capture.',
    scaleComparisons,
    themes,
  };
  const expectedPath = resolve(root, 'fixtures/mobile-parity/mermaid-svg-scale-expected.json');
  const prettierConfig = await resolvePrettierConfig(expectedPath);
  const json = await formatWithPrettier(JSON.stringify(resultDocument, null, 2), {
    ...prettierConfig,
    filepath: expectedPath,
    parser: 'json',
  });
  await writeFile(resolve(outputDir, 'mermaid-svg-scale-web.json'), json);
  await writeFile(expectedPath, json);
  console.log(outputDir);
} finally {
  await browser?.close();
  await server.close();
}
