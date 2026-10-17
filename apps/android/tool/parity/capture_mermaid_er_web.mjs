import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_mermaid_er_web.mjs
// Captures the pinned web Markdown + Mermaid ER path at 390/768px.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/mermaid-er.json'), 'utf8'),
);
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web'], { cwd: root });

const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-mermaid-er'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18907,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'mermaid-parity-fixture',
      configureServer(server) {
        server.middlewares.use('/parity.html', async (_, res, next) => {
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
                const params = new URLSearchParams(location.search);
                if (params.has('lineHeight')) root.style.lineHeight = params.get('lineHeight');
                let action;
                const waitForDiagram = async (block) => {
                  for (let i = 0; i < 300; i++) {
                    if (block.dataset.rendered === 'ok' || block.dataset.rendered === 'error') return;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  throw new Error('Timed out waiting for Mermaid: ' + block.textContent.slice(0, 100));
                };
                const box = (element) => {
                  if (!element) return null;
                  try {
                    const b = element.getBBox();
                    return { x: b.x, y: b.y, width: b.width, height: b.height };
                  } catch { return null; }
                };
                const geometry = (element) => {
                  const r = element.getBoundingClientRect();
                  return { x: r.x, y: r.y, width: r.width, height: r.height };
                };
                const transformChain = (element, svg) => {
                  const chain = [];
                  for (let node = element; node && node !== svg; node = node.parentElement) {
                    const transform = node.getAttribute?.('transform');
                    if (transform) chain.push(transform);
                  }
                  return chain.reverse();
                };
                const snapshot = (item, block, consoleErrors, db) => {
                  const svg = block.querySelector('svg');
                  const figure = block.querySelector('.mermaid-figure');
                  const source = block.querySelector('.mermaid-source code');
                  const styles = getComputedStyle(block);
                  const figureStyle = figure ? getComputedStyle(figure) : null;
                  const svgStyle = svg ? getComputedStyle(svg) : null;
                  const svgBox = svg ? geometry(svg) : null;
                  const borderAndPadding = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth) + parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
                  const cssTokens = Object.fromEntries(
                    ['--bg', '--ink', '--muted', '--line-dark', '--danger']
                      .map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()]),
                  );
                  return {
                    id: item.id,
                    status: block.dataset.rendered,
                    source: source?.textContent ?? null,
                    db,
                    externalSvgs: [...document.body.querySelectorAll('svg')]
                      .filter((candidate) => !block.contains(candidate))
                      .map((candidate) => ({
                        id: candidate.getAttribute('id'),
                        class: candidate.getAttribute('class'),
                        width: candidate.getAttribute('width'),
                        height: candidate.getAttribute('height'),
                        viewBox: candidate.getAttribute('viewBox'),
                        box: geometry(candidate),
                      })),
                    sourceDisplay: source ? getComputedStyle(source.closest('.mermaid-source')).display : null,
                    errorText: block.querySelector('.mermaid-error')?.textContent ?? null,
                    errorColor: block.querySelector('.mermaid-error') ? getComputedStyle(block.querySelector('.mermaid-error')).color : null,
                    block: {
                      box: geometry(block),
                      background: styles.backgroundColor,
                      borderColor: styles.borderTopColor,
                      borderWidth: styles.borderTopWidth,
                      borderRadius: styles.borderTopLeftRadius,
                      padding: styles.padding,
                      overflowX: styles.overflowX,
                    },
                    figure: figure ? {
                      box: geometry(figure),
                      display: figureStyle.display,
                      fontFamily: figureStyle.fontFamily,
                      fontSize: figureStyle.fontSize,
                      lineHeight: figureStyle.lineHeight,
                      verticalAlign: figureStyle.verticalAlign,
                      contentGapFromSvg: svgBox ? figure.getBoundingClientRect().height - svgBox.height : null,
                      outerContentGapFromSvg: svgBox ? geometry(block).height - borderAndPadding - svgBox.height : null,
                    } : null,
                    cssTokens,
                    svg: svg ? {
                      width: svg.getAttribute('width'),
                      height: svg.getAttribute('height'),
                      viewBox: svg.getAttribute('viewBox'),
                      preserveAspectRatio: svg.getAttribute('preserveAspectRatio'),
                      role: svg.getAttribute('role'),
                      ariaLabel: svg.getAttribute('aria-label'),
                      box: geometry(svg),
                      bbox: box(svg),
                      computed: {
                        color: svgStyle.color,
                        fill: svgStyle.fill,
                        stroke: svgStyle.stroke,
                        fontFamily: svgStyle.fontFamily,
                        fontSize: svgStyle.fontSize,
                        maxWidth: svgStyle.maxWidth,
                        height: svgStyle.height,
                      },
                      texts: [...svg.querySelectorAll('text')].map((element) => {
                        const style = getComputedStyle(element);
                        return {
                          text: element.textContent,
                          class: element.getAttribute('class'),
                          x: element.getAttribute('x'),
                          y: element.getAttribute('y'),
                          fill: element.getAttribute('fill'),
                          color: style.color,
                          computedFill: style.fill,
                          fontFamily: style.fontFamily,
                          fontSize: style.fontSize,
                          fontWeight: style.fontWeight,
                          textAnchor: style.textAnchor,
                          box: geometry(element),
                          bbox: box(element),
                          transformChain: transformChain(element, svg),
                        };
                      }),
                      foreignLabels: [...svg.querySelectorAll('foreignObject')].map((foreignObject) => {
                        const style = getComputedStyle(foreignObject);
                        return {
                          text: foreignObject.textContent,
                          x: foreignObject.getAttribute('x'),
                          y: foreignObject.getAttribute('y'),
                          width: foreignObject.getAttribute('width'),
                          height: foreignObject.getAttribute('height'),
                          box: geometry(foreignObject),
                          bbox: box(foreignObject),
                          transformChain: transformChain(foreignObject, svg),
                          computed: { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor, opacity: style.opacity },
                          textNodes: [...foreignObject.querySelectorAll('*')].filter((node) => !node.children.length && node.textContent.trim()).map((node) => {
                            const nodeStyle = getComputedStyle(node);
                            return { tag: node.tagName.toLowerCase(), class: node.getAttribute('class'), text: node.textContent, box: geometry(node), fontFamily: nodeStyle.fontFamily, fontSize: nodeStyle.fontSize, lineHeight: nodeStyle.lineHeight, color: nodeStyle.color, backgroundColor: nodeStyle.backgroundColor, opacity: nodeStyle.opacity };
                          }),
                        };
                      }),
                      edgeLabelStyles: [...svg.querySelectorAll('.edgeLabel, .labelBkg')].map((element) => {
                        const style = getComputedStyle(element);
                        return {
                          tag: element.tagName.toLowerCase(),
                          class: element.getAttribute('class'),
                          text: element.textContent.trim(),
                          display: style.display,
                          backgroundColor: style.backgroundColor,
                          color: style.color,
                          opacity: style.opacity,
                          box: geometry(element),
                        };
                      }),
                      shapes: [...svg.querySelectorAll('path, rect, polygon, circle, line')].map((element) => {
                        const style = getComputedStyle(element);
                        return {
                          tag: element.tagName.toLowerCase(),
                          class: element.getAttribute('class'),
                          id: element.getAttribute('id'),
                          d: element.getAttribute('d'),
                          points: element.getAttribute('points'),
                          x: element.getAttribute('x'),
                          y: element.getAttribute('y'),
                          width: element.getAttribute('width'),
                          height: element.getAttribute('height'),
                          cx: element.getAttribute('cx'),
                          cy: element.getAttribute('cy'),
                          r: element.getAttribute('r'),
                          fill: element.getAttribute('fill'),
                          computedFill: style.fill,
                          stroke: element.getAttribute('stroke'),
                          computedStroke: style.stroke,
                          strokeWidth: element.getAttribute('stroke-width') ?? style.strokeWidth,
                          opacity: style.opacity,
                          fillOpacity: style.fillOpacity,
                          strokeOpacity: style.strokeOpacity,
                          lineCap: style.strokeLinecap,
                          lineJoin: style.strokeLinejoin,
                          transformChain: transformChain(element, svg),
                          box: geometry(element),
                          bbox: box(element),
                        };
                      }),
                    } : null,
                    consoleErrors,
                  };
                };

                window.captureReady = false;
                window.renderMermaidCase = async (id) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown Mermaid fixture case: ' + id);
                  const html = renderMarkdown(item.source);
                  root.innerHTML = html;
                  const block = root.querySelector('.mermaid-block');
                  if (!block) throw new Error('Markdown did not make a Mermaid block for ' + id);
                  if (!action) action = enhanceMarkdown(root, { html, ready: true });
                  else action.update({ html, ready: true });
                  await waitForDiagram(block);
                  let db;
                  const mermaidSource = block.querySelector('.mermaid-source code')?.textContent ?? '';
                  try {
                    const diagram = await mermaid.mermaidAPI.getDiagramFromText(mermaidSource);
                    const data = diagram.db.getData();
                    const config = mermaid.mermaidAPI.getConfig();
                    const pickConfig = (value, keys) => Object.fromEntries(
                      keys.map((key) => [key, value?.[key] ?? null]),
                    );
                    const styleClasses = diagram.type === 'stateDiagram'
                      && typeof diagram.db.getClasses === 'function'
                      ? Object.fromEntries(
                          [...diagram.db.getClasses()].map(([id, styleClass]) => [
                            id,
                            JSON.parse(JSON.stringify(styleClass)),
                          ]),
                        )
                      : {};
                    db = {
                      accepted: true,
                      type: diagram.type,
                      direction: data.direction,
                      config: {
                        htmlLabels: config.htmlLabels ?? null,
                        er: JSON.parse(JSON.stringify(config.er ?? {})),
                        flowchart: pickConfig(config.flowchart, [
                          'htmlLabels', 'useMaxWidth', 'labelType', 'nodeSpacing',
                          'rankSpacing', 'diagramPadding', 'padding', 'defaultRenderer',
                        ]),
                        effectiveFlowchartHtmlLabels: config.htmlLabels
                          ?? config.flowchart?.htmlLabels
                          ?? true,
                        rendererData: {
                          htmlLabels: data.config?.htmlLabels ?? null,
                          er: JSON.parse(JSON.stringify(data.config?.er ?? {})),
                          flowchart: pickConfig(data.config?.flowchart, [
                            'htmlLabels', 'useMaxWidth', 'labelType', 'nodeSpacing',
                            'rankSpacing', 'diagramPadding', 'padding', 'defaultRenderer',
                          ]),
                        },
                      },
                      nodes: JSON.parse(JSON.stringify(data.nodes)),
                      edges: JSON.parse(JSON.stringify(data.edges)),
                      other: JSON.parse(JSON.stringify(data.other)),
                      entities: [...diagram.db.getEntities()].map(([id, entity]) => [
                        id,
                        JSON.parse(JSON.stringify(entity)),
                      ]),
                      relationships: JSON.parse(JSON.stringify(diagram.db.getRelationships())),
                      styleClasses,
                      accessibleTitle: diagram.db.getAccTitle?.() ?? '',
                      accessibleDescription: diagram.db.getAccDescription?.() ?? '',
                    };
                  } catch (error) {
                    db = {
                      accepted: false,
                      error: error instanceof Error ? error.message.split('\\n')[0] : String(error),
                    };
                  }
                  return snapshot(item, block, [], db);
                };
                await preloadRenderers();
                window.destroyMarkdownEnhancer = () => action?.destroy();
                window.fixtureReady = true;
              </script>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/parity.html', html));
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
  const resultsByTheme = {};
  for (const colorScheme of ['light', 'dark']) {
    const themeResults = [];
    for (const width of fixture.widths) {
      const widthResults = [];
      for (const item of fixture.cases) {
        // A rejected Mermaid parser may append a diagnostic SVG outside the
        // Markdown block. A fresh real app page keeps that case from
        // contaminating screenshots or DOM measurements of later cases.
        const page = await browser.newPage({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: 1,
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
          await page.goto('http://127.0.0.1:18907/parity.html');
          await page.waitForFunction(() => window.fixtureReady);
          const logStart = consoleErrors.length;
          const result = await page.evaluate((id) => window.renderMermaidCase(id), item.id);
          result.consoleErrors = consoleErrors.slice(logStart);
          widthResults.push(result);
          if (badResponses.length) throw new Error(badResponses.join('\n'));
          if (pageErrors.length) throw new Error(pageErrors.join('\n'));
          await page.screenshot({
            path: resolve(out, `mermaid-er-web-${item.id}-${width}-${colorScheme}.png`),
            fullPage: true,
          });
          await page.evaluate(() => window.destroyMarkdownEnhancer?.());
        } finally {
          await page.close();
        }
      }
      themeResults.push({ width, cases: widthResults });
    }
    resultsByTheme[colorScheme] = { widths: themeResults };
  }
  const resultDocument = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    themes: resultsByTheme,
  };
  const expectedPath = resolve(root, 'fixtures/mobile-parity/mermaid-er-expected.json');
  const prettierConfig = await resolvePrettierConfig(expectedPath);
  const json = await formatWithPrettier(JSON.stringify(resultDocument, null, 2), {
    ...prettierConfig,
    filepath: expectedPath,
    parser: 'json',
  });
  await writeFile(resolve(out, 'mermaid-er-web.json'), json);
  await writeFile(resolve(root, 'fixtures/mobile-parity/mermaid-er-expected.json'), json);
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
