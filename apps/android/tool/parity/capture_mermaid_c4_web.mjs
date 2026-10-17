import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_mermaid_c4_web.mjs
// Captures real Chrome output from the pinned Pirc Markdown + Mermaid path.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/mermaid-c4-parser-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.webRevision !== 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c') {
  throw new Error('Unexpected pinned web revision: ' + fixture.webRevision);
}
if (fixture.mermaidVersion !== '11.17.2') {
  throw new Error('Expected Mermaid 11.17.2; found ' + fixture.mermaidVersion);
}
execFileSync(
  'git',
  ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web/src', 'apps/web/package.json'],
  { cwd: root },
);

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const out = resolve('/private/tmp', 'pirc-mermaid-c4-parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-mermaid-c4'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18914,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'mermaid-c4-parity-fixture',
      configureServer(server) {
        server.middlewares.use('/parity.html', async (_, res, next) => {
          try {
            const bootstrapSource = [
              "import '/src/app.css';",
              "import '/src/markdown.css';",
              "import { preloadRenderers, renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';",
              "import mermaid from 'mermaid';",
              'const fixture = ' + fixtureSource + ';',
              '(' +
                browserBootstrap.toString() +
                ')(fixture, preloadRenderers, renderMarkdown, enhanceMarkdown, mermaid);',
            ].join('\n');
            const html =
              '<!doctype html><html><head>' +
              '<link rel="icon" href="data:,">' +
              '<meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<style>body{overflow:auto!important}#fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}.mermaid-case{margin:0}</style>' +
              '</head><body><main id="fixture" class="markdown"></main>' +
              '<script type="module">' +
              bootstrapSource +
              '</script></body></html>';
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

function browserBootstrap(fixture, preloadRenderers, renderMarkdown, enhanceMarkdown, mermaid) {
  const root = document.querySelector('#fixture');
  let action;

  const box = (element) => {
    if (!element) return null;
    try {
      const value = element.getBBox();
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
      };
    } catch {
      return null;
    }
  };
  const geometry = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
  };
  const transformChain = (element, svg) => {
    const chain = [];
    for (let node = element; node && node !== svg; node = node.parentElement) {
      const transform = node.getAttribute?.('transform');
      if (transform) chain.push(transform);
    }
    return chain.reverse();
  };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const textMetric = (value) => {
    if (!value) return null;
    return {
      text: value.text ?? '',
      width: value.width ?? null,
      height: value.height ?? null,
      textLines: value.textLines ?? null,
      x: value.x ?? null,
      y: value.y ?? null,
      Y: value.Y ?? null,
    };
  };
  const nodeText = (element, svg) => {
    const style = getComputedStyle(element);
    return {
      text: element.textContent ?? '',
      class: element.getAttribute('class'),
      x: element.getAttribute('x'),
      y: element.getAttribute('y'),
      fill: element.getAttribute('fill'),
      dominantBaseline: element.getAttribute('dominant-baseline'),
      textAnchor: style.textAnchor,
      computed: {
        color: style.color,
        fill: style.fill,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      },
      box: geometry(element),
      bbox: box(element),
      lines: [...element.querySelectorAll('tspan')].map((span) => {
        const lineStyle = getComputedStyle(span);
        return {
          text: span.textContent ?? '',
          attrs: Object.fromEntries(
            ['x', 'y', 'dx', 'dy', 'text-anchor', 'dominant-baseline'].flatMap((name) => {
              const value = span.getAttribute(name);
              return value === null ? [] : [[name, value]];
            }),
          ),
          computed: {
            color: lineStyle.color,
            fill: lineStyle.fill,
            fontFamily: lineStyle.fontFamily,
            fontSize: lineStyle.fontSize,
            fontWeight: lineStyle.fontWeight,
            lineHeight: lineStyle.lineHeight,
          },
          box: geometry(span),
          bbox: box(span),
        };
      }),
      transformChain: transformChain(element, svg),
    };
  };
  const elementEvidence = (element, svg) => {
    const style = getComputedStyle(element);
    const attrs = {};
    for (const name of [
      'id',
      'class',
      'd',
      'points',
      'x',
      'y',
      'width',
      'height',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'fill',
      'stroke',
      'stroke-width',
      'marker-start',
      'marker-end',
    ]) {
      const value = element.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    return {
      tag: element.tagName.toLowerCase(),
      attrs,
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
      box: geometry(element),
      bbox: box(element),
      transformChain: transformChain(element, svg),
    };
  };
  const waitForDiagram = async (block) => {
    for (let i = 0; i < 300; i++) {
      if (block.dataset.rendered === 'ok' || block.dataset.rendered === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for Mermaid: ' + block.textContent.slice(0, 100));
  };
  const rendererDb = (db) => {
    if (!db) return null;
    const shapes = db.getC4ShapeArray();
    const boundaries = db.getBoundaries();
    const rels = db.getRels();
    return {
      type: db.getC4Type(),
      title: db.getTitle(),
      shapeInRow: db.getC4ShapeInRow(),
      boundaryInRow: db.getC4BoundaryInRow(),
      shapes: shapes.map((shape) => ({
        raw: plain(shape),
        wrapState: {
          ownsWrapField: Object.hasOwn(shape, 'wrap'),
          value: shape.wrap === undefined ? 'undefined' : shape.wrap,
        },
        hasIntersectionFunction: typeof shape.intersect === 'function',
        geometry: {
          x: shape.x ?? null,
          y: shape.y ?? null,
          width: shape.width ?? null,
          height: shape.height ?? null,
          margin: shape.margin ?? null,
        },
        labelMetrics: textMetric(shape.label),
        technologyMetrics: textMetric(shape.techn),
        descriptionMetrics: textMetric(shape.descr),
      })),
      boundaries: boundaries.map((boundary) => ({
        raw: plain(boundary),
        wrapState: {
          ownsWrapField: Object.hasOwn(boundary, 'wrap'),
          value: boundary.wrap === undefined ? 'undefined' : boundary.wrap,
        },
        geometry: {
          x: boundary.x ?? null,
          y: boundary.y ?? null,
          width: boundary.width ?? null,
          height: boundary.height ?? null,
        },
        labelMetrics: textMetric(boundary.label),
        typeMetrics: textMetric(boundary.type),
        descriptionMetrics: textMetric(boundary.descr),
      })),
      rels: rels.map((rel) => ({
        raw: plain(rel),
        wrapState: {
          ownsWrapField: Object.hasOwn(rel, 'wrap'),
          value: rel.wrap === undefined ? 'undefined' : rel.wrap,
        },
        endpoints: {
          startPoint: rel.startPoint ?? null,
          endPoint: rel.endPoint ?? null,
        },
        labelMetrics: textMetric(rel.label),
        technologyMetrics: textMetric(rel.techn),
        descriptionMetrics: textMetric(rel.descr),
      })),
    };
  };
  const snapshot = (item, block, api, consoleErrors) => {
    const svg = block.querySelector('svg');
    const figure = block.querySelector('.mermaid-figure');
    const source = block.querySelector('.mermaid-source code');
    const blockStyle = getComputedStyle(block);
    const figureStyle = figure ? getComputedStyle(figure) : null;
    const svgStyle = svg ? getComputedStyle(svg) : null;
    const svgBox = svg ? geometry(svg) : null;
    const renderedDb = rendererDb(api?.db ?? null);
    const allTextElements = svg ? [...svg.querySelectorAll('text')] : [];
    const texts = allTextElements.map((element) => nodeText(element, svg));
    const nodeGroups = svg
      ? [...svg.querySelectorAll('g.node')].map((group) => ({
          id: group.getAttribute('id'),
          class: group.getAttribute('class'),
          box: geometry(group),
          bbox: box(group),
          labelGroup: (() => {
            const label = group.querySelector('.label');
            if (!label) return null;
            const style = getComputedStyle(label);
            return {
              tag: label.tagName.toLowerCase(),
              class: label.getAttribute('class'),
              box: geometry(label),
              bbox: box(label),
              transformChain: transformChain(label, svg),
              computed: {
                color: style.color,
                fill: style.fill,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
              },
            };
          })(),
          texts: [...group.querySelectorAll('text')].map((element) => nodeText(element, svg)),
        }))
      : [];
    const shapeLabels = (renderedDb?.shapes ?? []).map((shape) => {
      const alias = shape.raw.alias;
      const group = nodeGroups.find((candidate) => candidate.id?.endsWith('-' + alias)) ?? null;
      return {
        alias,
        labelMetrics: shape.labelMetrics,
        technologyMetrics: shape.technologyMetrics,
        descriptionMetrics: shape.descriptionMetrics,
        domGroupId: group?.id ?? null,
        domBox: group?.box ?? null,
        domBbox: group?.bbox ?? null,
        domLabelGroup: group?.labelGroup ?? null,
        domTexts: group?.texts ?? [],
      };
    });
    const boundaryLabels = (renderedDb?.boundaries ?? [])
      .map((boundary) => {
        const rawLabel = boundary.raw.label?.text ?? '';
        const rawType = boundary.raw.type?.text ?? '';
        const rawDescription = boundary.raw.descr?.text ?? '';
        const matches = (value) =>
          texts.filter((node) => {
            const text = node.text.trim();
            return value && text && (text === value || value.includes(text) || text.includes(value));
          });
        return {
          alias: boundary.raw.alias,
          labelText: rawLabel,
          labelMetrics: boundary.labelMetrics,
          labelDomTexts: matches(rawLabel),
          typeText: rawType,
          typeMetrics: boundary.typeMetrics,
          typeDomTexts: matches(rawType),
          descriptionText: rawDescription,
          descriptionMetrics: boundary.descriptionMetrics,
          descriptionDomTexts: matches(rawDescription),
          geometry: boundary.geometry,
        };
      });
    const c4Config = mermaid.mermaidAPI.getConfig?.() ?? {};
    const svgDom = svg
      ? {
          attrs: {
            id: svg.getAttribute('id'),
            width: svg.getAttribute('width'),
            height: svg.getAttribute('height'),
            viewBox: svg.getAttribute('viewBox'),
            preserveAspectRatio: svg.getAttribute('preserveAspectRatio'),
            role: svg.getAttribute('role'),
            ariaLabel: svg.getAttribute('aria-label'),
          },
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
          texts,
          nodeGroups,
          shapeLabels,
          boundaryLabels,
          shapeElements: [
            ...svg.querySelectorAll('path, rect, polygon, circle, line, ellipse'),
          ].map((element) => elementEvidence(element, svg)),
        }
      : null;
    return {
      id: item.id,
      status: block.dataset.rendered,
      sourceExpected: item.source,
      sourceRendered: source?.textContent ?? null,
      parserApi: api
        ? {
            accepted: api.accepted,
            diagramType: api.diagramType,
            c4Type: api.c4Type,
            error: api.error ?? null,
          }
        : { accepted: false, diagramType: null, c4Type: null, error: null },
      rendererDb: renderedDb,
      securityLevel: c4Config.securityLevel ?? null,
      markdown: {
        sourceDisplay: source ? getComputedStyle(source.closest('.mermaid-source')).display : null,
        errorText: block.querySelector('.mermaid-error')?.textContent ?? null,
        errorColor: block.querySelector('.mermaid-error')
          ? getComputedStyle(block.querySelector('.mermaid-error')).color
          : null,
        block: {
          box: geometry(block),
          fontFamily: blockStyle.fontFamily,
          fontSize: blockStyle.fontSize,
          lineHeight: blockStyle.lineHeight,
          color: blockStyle.color,
          background: blockStyle.backgroundColor,
          borderColor: blockStyle.borderTopColor,
          borderWidth: blockStyle.borderTopWidth,
          borderRadius: blockStyle.borderTopLeftRadius,
          padding: blockStyle.padding,
          overflowX: blockStyle.overflowX,
        },
        figure: figure
          ? {
              box: geometry(figure),
              display: figureStyle.display,
              fontFamily: figureStyle.fontFamily,
              fontSize: figureStyle.fontSize,
              lineHeight: figureStyle.lineHeight,
              verticalAlign: figureStyle.verticalAlign,
              svgHeight: svgBox?.height ?? null,
              contentGapFromSvg: svgBox ? figure.getBoundingClientRect().height - svgBox.height : null,
            }
          : null,
      },
      mermaid: {
        version: mermaid.version ?? null,
        theme: c4Config.theme ?? null,
        fontFamily: c4Config.fontFamily ?? null,
        c4: {
          wrap: c4Config.c4?.wrap ?? null,
          c4ShapeInRow: c4Config.c4?.c4ShapeInRow ?? null,
          c4BoundaryInRow: c4Config.c4?.c4BoundaryInRow ?? null,
        },
      },
      cssTokens: Object.fromEntries(
        ['--bg', '--ink', '--muted', '--line-dark', '--danger'].map((name) => [
          name,
          getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
        ]),
      ),
      svg: svgDom,
      environment: {
        userAgent: navigator.userAgent,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        screen: {
          width: window.screen.width,
          height: window.screen.height,
          availWidth: window.screen.availWidth,
          availHeight: window.screen.availHeight,
        },
      },
      consoleErrors,
    };
  };

  window.renderMermaidCase = async (id) => {
    const item = [...fixture.cases, ...fixture.invalidCases].find((candidate) => candidate.id === id);
    if (!item) throw new Error('Unknown C4 fixture case: ' + id);

    let api = null;
    try {
      const parsed = await mermaid.parse(item.source);
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(item.source);
      api = {
        accepted: true,
        diagramType: parsed?.diagramType ?? diagram.type ?? null,
        c4Type: diagram.db?.getC4Type?.() ?? null,
        db: diagram.db ?? null,
        error: null,
      };
    } catch (error) {
      api = {
        accepted: false,
        diagramType: null,
        c4Type: null,
        db: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const fence = String.fromCharCode(96).repeat(3);
    const markdownSource = fence + 'mermaid\n' + item.source + '\n' + fence;
    const html = renderMarkdown(markdownSource);
    root.innerHTML = html;
    const block = root.querySelector('.mermaid-block');
    if (!block) throw new Error('Markdown did not make a Mermaid block for ' + id);
    if (!action) action = enhanceMarkdown(root, { html, ready: true });
    else action.update({ html, ready: true });
    await waitForDiagram(block);
    return snapshot(item, block, api, []);
  };

  preloadRenderers().then(() => {
    window.destroyMarkdownEnhancer = () => action?.destroy();
    window.fixtureReady = true;
  });
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const browserVersion = browser.version();
  const responsiveIds = new Set([
    'container-db-queue-nested-boundaries',
    'dynamic-relindex-source-order',
    'wrap-layout-update',
    'element-and-relation-style-offsets',
  ]);
  const renderPlans = [
    {
      width: 390,
      height: 900,
      colorScheme: 'light',
      items: [...fixture.cases, ...fixture.invalidCases],
    },
    {
      width: 768,
      height: 900,
      colorScheme: 'dark',
      items: fixture.cases.filter((item) => responsiveIds.has(item.id)),
    },
  ];
  const results = { light: [], dark: [] };

  for (const plan of renderPlans) {
    for (const item of plan.items) {
      const context = await browser.newContext({
        viewport: { width: plan.width, height: plan.height },
        screen: { width: plan.width, height: plan.height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        colorScheme: plan.colorScheme,
      });
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      const badResponses = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() >= 400) badResponses.push(response.status() + ' ' + response.url());
      });
      try {
        await page.goto('http://127.0.0.1:18914/parity.html');
        await page.waitForFunction(() => window.fixtureReady);
        const logStart = consoleErrors.length;
        const result = await page.evaluate((id) => window.renderMermaidCase(id), item.id);
        result.consoleErrors = consoleErrors.slice(logStart);
        result.pageErrors = pageErrors.slice();
        result.badResponses = badResponses.slice();
        result.capture = {
          width: plan.width,
          height: plan.height,
          colorScheme: plan.colorScheme,
          browserVersion,
          playwrightScreen: { width: plan.width, height: plan.height },
          renderPath: 'Pirc renderMarkdown + enhanceMarkdown + Mermaid render inside Chrome',
        };
        const shouldRender = item.db !== undefined;
        const expectedStatus = shouldRender ? 'ok' : 'error';
        if (result.status !== expectedStatus) {
          throw new Error(
            'Unexpected Chrome render status for ' + item.id + ': ' + result.status +
              ' (expected ' + expectedStatus + ')',
          );
        }
        if (pageErrors.length) throw new Error(pageErrors.join('\n'));
        if (badResponses.length) throw new Error(badResponses.join('\n'));
        if (plan.colorScheme === 'light') results.light.push(result);
        else results.dark.push(result);
        await page.evaluate(() => window.destroyMarkdownEnhancer?.());
      } finally {
        await context.close();
      }
    }
  }

  const resultDocument = {
    fixture: 'mermaid-c4-web-v1',
    parserFixture: fixture.fixture,
    webRevision: fixture.webRevision,
    mermaidVersion: fixture.mermaidVersion,
    oracle:
      'Real Chrome render through Pirc Markdown enhancement and pinned Mermaid. SVG DOM text, shapes, computed styles and geometry, plus the actual C4 DB after renderer layout are recorded. Per-item wrapState preserves undefined separately from c4.wrap renderer config. Node DOMPurify stubs are not used in this browser capture.',
    browserVersion,
    rendererConfig: {
      securityLevel: 'strict',
      theme: 'base for light and dark for dark, selected by the actual Pirc matchMedia path',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      deviceScaleFactor: 1,
      c4Wrap: 'true in Pirc Mermaid renderer config; item wrap comes from the separate top-level Mermaid wrap setting and is undefined for these sources.',
      screen: 'Playwright screen emulation uses the same CSS width and height as the viewport; each capture records measured screen and availWidth.',
    },
    captures: {
      light390: results.light,
      dark768: results.dark,
    },
  };
  const json = JSON.stringify(resultDocument, null, 2) + '\n';
  const output = resolve(root, 'fixtures/mobile-parity/mermaid-c4-web-expected.json');
  await writeFile(output, json);
  process.stdout.write(
    'Wrote ' + (results.light.length + results.dark.length) + ' actual Chrome C4 captures to ' + output + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
