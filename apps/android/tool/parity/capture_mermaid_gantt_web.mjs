import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_mermaid_gantt_web.mjs
// Captures the pinned web Markdown + Mermaid Gantt path at 390/768 CSS pixels.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/mermaid-gantt.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const revision = fixture.webRevision;
assert.equal(revision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(fixture.mermaidVersion, '11.17.2');
assert.deepEqual(fixture.widths, [390, 768]);
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

const outputDir = resolve(root, 'apps/android/build/parity/mermaid-gantt-web');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18908,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'mermaid-gantt-parity-fixture',
      configureServer(vite) {
        vite.middlewares.use('/gantt.html', async (_, res, next) => {
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
                import mermaid from 'mermaid';

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
                const svgBox = (element) => {
                  if (!element) return null;
                  try {
                    const b = element.getBBox();
                    return { x: b.x, y: b.y, width: b.width, height: b.height };
                  } catch { return null; }
                };
                const clientBox = (element) => {
                  if (!element) return null;
                  const b = element.getBoundingClientRect();
                  return { x: b.x, y: b.y, width: b.width, height: b.height };
                };
                const transformChain = (element, svg) => {
                  const chain = [];
                  for (let node = element; node && node !== svg; node = node.parentElement) {
                    const transform = node.getAttribute?.('transform');
                    if (transform) chain.push(transform);
                  }
                  return chain.reverse();
                };
                const attrs = (element, names) => Object.fromEntries(
                  names.map((name) => [name, element.getAttribute(name)]),
                );
                const textNode = (element, svg) => {
                  const style = getComputedStyle(element);
                  return {
                    text: element.textContent,
                    class: element.getAttribute('class'),
                    id: element.getAttribute('id'),
                    attrs: attrs(element, ['x', 'y', 'dx', 'dy', 'text-anchor', 'font-size', 'fill', 'stroke', 'transform']),
                    computed: {
                      fontFamily: style.fontFamily,
                      fontSize: style.fontSize,
                      fontWeight: style.fontWeight,
                      lineHeight: style.lineHeight,
                      textAnchor: style.textAnchor,
                      fill: style.fill,
                      stroke: style.stroke,
                    },
                    bbox: svgBox(element),
                    box: clientBox(element),
                    transformChain: transformChain(element, svg),
                  };
                };
                const shapeNode = (element, svg) => {
                  const style = getComputedStyle(element);
                  return {
                    tag: element.tagName.toLowerCase(),
                    class: element.getAttribute('class'),
                    id: element.getAttribute('id'),
                    attrs: attrs(element, [
                      'd', 'points', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height',
                      'cx', 'cy', 'r', 'rx', 'ry', 'transform', 'fill', 'stroke', 'stroke-width',
                    ]),
                    computed: {
                      fill: style.fill,
                      stroke: style.stroke,
                      strokeWidth: style.strokeWidth,
                      opacity: style.opacity,
                      fillOpacity: style.fillOpacity,
                      strokeOpacity: style.strokeOpacity,
                      lineCap: style.strokeLinecap,
                      lineJoin: style.strokeLinejoin,
                    },
                    bbox: svgBox(element),
                    box: clientBox(element),
                    transformChain: transformChain(element, svg),
                  };
                };
                const taskRow = (task, svg) => {
                  const bar = [...svg.querySelectorAll('.task[id]')]
                    .find((element) => element.id.endsWith('-' + task.id));
                  const label = [...svg.querySelectorAll('text[id]')]
                    .find((element) => element.id.endsWith('-' + task.id + '-text'));
                  return {
                    id: task.id,
                    label: task.task ?? task.description ?? '',
                    section: task.section,
                    type: task.type,
                    order: task.order,
                    previousTaskId: task.prevTaskId ?? null,
                    status: {
                      active: !!task.active,
                      done: !!task.done,
                      crit: !!task.crit,
                      milestone: !!task.milestone,
                      vertical: !!task.vert,
                    },
                    processed: task.processed ?? true,
                    manualEndTime: !!task.manualEndTime,
                    startTime: task.startTime instanceof Date ? task.startTime.toISOString() : task.startTime ?? null,
                    endTime: task.endTime instanceof Date ? task.endTime.toISOString() : task.endTime ?? null,
                    renderEndTime: task.renderEndTime instanceof Date ? task.renderEndTime.toISOString() : task.renderEndTime ?? null,
                    raw: {
                      data: task.raw?.data ?? null,
                      startTime: task.raw?.startTime ?? null,
                      endTime: task.raw?.endTime ?? null,
                    },
                    classList: bar?.getAttribute('class')?.trim().split(/\\s+/) ?? [],
                    bar: bar ? shapeNode(bar, svg) : null,
                    labelGeometry: label ? textNode(label, svg) : null,
                  };
                };
                const snapshot = (item, block, textScale, db) => {
                  const figure = block.querySelector('.mermaid-figure');
                  const svg = figure?.querySelector('svg');
                  const blockStyle = getComputedStyle(block);
                  const figureStyle = figure ? getComputedStyle(figure) : null;
                  const svgStyle = svg ? getComputedStyle(svg) : null;
                  if (!svg) throw new Error('Mermaid produced no SVG for ' + item.id);
                  const ticks = [...svg.querySelectorAll('.grid .tick')].map((tick) => ({
                    transform: tick.getAttribute('transform'),
                    text: tick.querySelector('text') ? textNode(tick.querySelector('text'), svg) : null,
                    shapes: [...tick.querySelectorAll('path, line')].map((element) => shapeNode(element, svg)),
                  }));
                  const title = svg.querySelector('.titleText');
                  return {
                    id: item.id,
                    textScale,
                    status: block.dataset.rendered,
                    source: block.querySelector('.mermaid-source code')?.textContent ?? null,
                    errorText: block.querySelector('.mermaid-error')?.textContent ?? null,
                    html: {
                      block: {
                        box: clientBox(block),
                        fontFamily: blockStyle.fontFamily,
                        fontSize: blockStyle.fontSize,
                        lineHeight: blockStyle.lineHeight,
                      },
                      figure: figure ? {
                        box: clientBox(figure),
                        fontFamily: figureStyle.fontFamily,
                        fontSize: figureStyle.fontSize,
                        lineHeight: figureStyle.lineHeight,
                      } : null,
                    },
                    api: db,
                    svg: {
                      attrs: attrs(svg, ['width', 'height', 'viewBox', 'preserveAspectRatio', 'role', 'aria-label']),
                      box: clientBox(svg),
                      bbox: svgBox(svg),
                      computed: {
                        fontFamily: svgStyle.fontFamily,
                        fontSize: svgStyle.fontSize,
                        lineHeight: svgStyle.lineHeight,
                        width: svgStyle.width,
                        height: svgStyle.height,
                        maxWidth: svgStyle.maxWidth,
                      },
                      title: title ? textNode(title, svg) : null,
                      taskRows: db.tasks.map((task) => taskRow(task, svg)),
                      sectionBands: [...svg.querySelectorAll('rect.section')].map((element) => shapeNode(element, svg)),
                      sectionLabels: [...svg.querySelectorAll('text.sectionTitle')].map((element) => textNode(element, svg)),
                      excludeRanges: [...svg.querySelectorAll('rect.exclude-range')].map((element) => shapeNode(element, svg)),
                      todayMarkers: [...svg.querySelectorAll('.today')].map((element) => shapeNode(element, svg)),
                      axes: {
                        ticks,
                        paths: [...svg.querySelectorAll('g.grid path')].map((element) => shapeNode(element, svg)),
                      },
                    },
                  };
                };
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
                  const entries = [...document.querySelectorAll('#fixture, #fixture *')]
                    .filter((node) => node instanceof HTMLElement && !node.closest('svg'))
                    .map((node) => {
                      const style = getComputedStyle(node);
                      return [node, parseFloat(style.fontSize), style.lineHeight];
                    });
                  for (const [node, size, line] of entries) {
                    node.style.setProperty('font-size', size * scale + 'px', 'important');
                    if (line !== 'normal') {
                      node.style.setProperty('line-height', parseFloat(line) * scale + 'px', 'important');
                    }
                  }
                  for (const [svg, fontSize, lineHeight] of svgDefaults) {
                    svg.style.setProperty('font-size', fontSize, 'important');
                    if (lineHeight !== 'normal') {
                      svg.style.setProperty('line-height', lineHeight, 'important');
                    }
                  }
                  for (const [node, fontSize, lineHeight] of svgTextDefaults) {
                    node.style.setProperty('font-size', fontSize, 'important');
                    if (lineHeight !== 'normal') {
                      node.style.setProperty('line-height', lineHeight, 'important');
                    }
                  }
                };
                window.captureGanttCase = async (id, textScale) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown Mermaid Gantt case: ' + id);
                  const html = renderMarkdown(item.source);
                  root.innerHTML = html;
                  const block = root.querySelector('.mermaid-block');
                  if (!block) throw new Error('Markdown did not create a Mermaid block for ' + id);
                  if (!action) action = enhanceMarkdown(root, { html, ready: true });
                  else action.update({ html, ready: true });
                  await waitForDiagram(block);
                  applyHtmlTextScale(textScale);
                  await document.fonts.ready;
                  const source = block.querySelector('.mermaid-source code')?.textContent ?? '';
                  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
                  if (diagram.type !== 'gantt') throw new Error('Expected gantt diagram, got ' + diagram.type);
                  const tasks = diagram.db.getTasks();
                  const config = mermaid.mermaidAPI.getConfig();
                  const db = {
                    accepted: true,
                    type: diagram.type,
                    sections: diagram.db.getSections(),
                    dateFormat: diagram.db.getDateFormat(),
                    axisFormat: diagram.db.getAxisFormat(),
                    excludes: diagram.db.getExcludes(),
                    includes: diagram.db.getIncludes(),
                    todayMarker: diagram.db.getTodayMarker(),
                    displayMode: diagram.db.getDisplayMode(),
                    topAxis: diagram.db.topAxisEnabled(),
                    dateTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    tasks: tasks.map((task) => ({
                      id: task.id,
                      task: task.task ?? task.description ?? '',
                      section: task.section,
                      type: task.type,
                      order: task.order,
                      prevTaskId: task.prevTaskId ?? null,
                      active: !!task.active,
                      done: !!task.done,
                      crit: !!task.crit,
                      milestone: !!task.milestone,
                      vert: !!task.vert,
                      processed: task.processed ?? true,
                      manualEndTime: !!task.manualEndTime,
                      startTime: task.startTime instanceof Date ? task.startTime.toISOString() : task.startTime ?? null,
                      endTime: task.endTime instanceof Date ? task.endTime.toISOString() : task.endTime ?? null,
                      renderEndTime: task.renderEndTime instanceof Date ? task.renderEndTime.toISOString() : task.renderEndTime ?? null,
                      raw: {
                        data: task.raw?.data ?? null,
                        startTime: task.raw?.startTime ?? null,
                        endTime: task.raw?.endTime ?? null,
                      },
                      classes: task.classes ?? [],
                    })),
                    config: {
                      gantt: JSON.parse(JSON.stringify(config.gantt ?? {})),
                      theme: config.theme ?? null,
                      themeVariables: {
                        fontFamily: config.themeVariables?.fontFamily ?? null,
                        fontSize: config.themeVariables?.fontSize ?? null,
                        background: config.themeVariables?.background ?? null,
                        primaryColor: config.themeVariables?.primaryColor ?? null,
                        primaryTextColor: config.themeVariables?.primaryTextColor ?? null,
                        lineColor: config.themeVariables?.lineColor ?? null,
                      },
                    },
                  };
                  return snapshot(item, block, textScale, db);
                };
                await preloadRenderers();
                window.destroyMarkdownEnhancer = () => action?.destroy();
                window.fixtureReady = true;
              </script>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/gantt.html', html));
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
  const themes = {};
  for (const colorScheme of ['light', 'dark']) {
    const widthRows = [];
    for (const width of fixture.widths) {
      const scaleRows = [];
      for (const textScale of fixture.textScales) {
        const caseRows = [];
        for (const item of fixture.cases) {
          const page = await browser.newPage({
            viewport: { width, height: fixture.height },
            deviceScaleFactor: fixture.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            locale: 'en-US',
            timezoneId: 'UTC',
            colorScheme,
          });
          await page.clock.setFixedTime(new Date(fixture.fixedNow));
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
            await page.goto('http://127.0.0.1:18908/gantt.html');
            await page.waitForFunction(() => window.fixtureReady);
            const logStart = consoleErrors.length;
            const result = await page.evaluate(
              ({ id, scale }) => window.captureGanttCase(id, scale),
              { id: item.id, scale: textScale },
            );
            result.consoleErrors = consoleErrors.slice(logStart);
            result.pageErrors = [...pageErrors];
            caseRows.push(result);
            if (badResponses.length) throw new Error(badResponses.join('\n'));
            if (pageErrors.length) throw new Error(pageErrors.join('\n'));
            if (result.status !== 'ok') throw new Error(`Mermaid failed for ${item.id}: ${result.errorText}`);
            await page.screenshot({
              path: resolve(outputDir, `${item.id}-${width}-${colorScheme}-scale${textScale}.png`),
              fullPage: true,
            });
            await page.evaluate(() => window.destroyMarkdownEnhancer?.());
          } finally {
            await page.close();
          }
        }
        scaleRows.push({ textScale, cases: caseRows });
      }
      widthRows.push({ width, scales: scaleRows });
    }
    themes[colorScheme] = { widths: widthRows };
  }
  const resultDocument = {
    fixture: fixture.id,
    reference: revision,
    mermaidVersion: mermaidPackage.version,
    deviceScaleFactor: fixture.deviceScaleFactor,
    scalePolicy: 'After Mermaid render, multiply computed font-size and line-height for HTML elements under #fixture only. Pin SVG roots and SVG text/tspan nodes to pre-scale computed font-size and line-height; keep SVG geometry unchanged. CSS pixels, deviceScaleFactor 1.',
    fixedNow: fixture.fixedNow,
    themes,
  };
  const expectedPath = resolve(root, 'fixtures/mobile-parity/mermaid-gantt-expected.json');
  const prettierConfig = await resolvePrettierConfig(expectedPath);
  const json = await formatWithPrettier(JSON.stringify(resultDocument, null, 2), {
    ...prettierConfig,
    filepath: expectedPath,
    parser: 'json',
  });
  await writeFile(resolve(outputDir, 'mermaid-gantt-web.json'), json);
  await writeFile(expectedPath, json);
  console.log(outputDir);
} finally {
  await browser?.close();
  await server.close();
}
