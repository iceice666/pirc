import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_mermaid_requirement_web.mjs
// Captures the pinned production Markdown + Mermaid requirement render in Chrome.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/mermaid-requirement-parser-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const webRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
assert.equal(fixture.webRevision, webRevision);
assert.equal(fixture.mermaidVersion, '11.17.2');
assert.equal(fixture.cases.length, 6);
execFileSync(
  'git',
  ['diff', '--exit-code', webRevision, '--', 'apps/web/src', 'apps/web/package.json'],
  { cwd: root },
);

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve('/private/tmp', 'pirc-mermaid-requirement-web');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');

const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18922,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'mermaid-requirement-parity-fixture',
      configureServer(vite) {
        vite.middlewares.use('/requirement.html', async (_, res, next) => {
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
            res.end(await vite.transformIndexHtml('/requirement.html', html));
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
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const box = (element) => {
    if (!element) return null;
    try {
      const value = element.getBBox();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    } catch {
      return null;
    }
  };
  const geometry = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  };
  const attrs = (element, names) =>
    Object.fromEntries(
      names.flatMap((name) => {
        const value = element.getAttribute(name);
        return value === null ? [] : [[name, value]];
      }),
    );
  const computed = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      color: style.color,
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      textAlign: style.textAlign,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
    };
  };
  const parserDb = (db) => {
    if (!db) return null;
    const raw = {
      requirements: clone([...db.getRequirements().entries()]),
      elements: clone([...db.getElements().entries()]),
      relations: clone(db.getRelationships()),
      direction: db.getDirection() ?? null,
      title: db.getDiagramTitle() ?? '',
      accTitle: db.getAccTitle() ?? '',
      accDescription: db.getAccDescription() ?? '',
      classes: clone([...db.getClasses().entries()]),
    };
    const data = db.getData();
    return {
      raw,
      graphData: {
        nodes: clone(data.nodes),
        edges: clone(data.edges),
        other: clone(data.other),
        direction: data.direction ?? null,
      },
      enumerations: {
        requirementTypes: clone(db.RequirementType),
        risks: clone(db.RiskLevel),
        verificationMethods: clone(db.VerifyType),
        relationships: clone(db.Relationships),
      },
    };
  };
  const fieldLabel = (group) => {
    const foreignObject = group.querySelector('foreignObject');
    const content = foreignObject?.querySelector('div') ?? null;
    return {
      text: group.textContent?.trim() ?? '',
      transform: group.getAttribute('transform'),
      box: geometry(group),
      bbox: box(group),
      foreignObject: foreignObject
        ? {
            attrs: attrs(foreignObject, ['x', 'y', 'width', 'height']),
            box: geometry(foreignObject),
            bbox: box(foreignObject),
          }
        : null,
      content: content
        ? {
            text: content.textContent?.trim() ?? '',
            box: geometry(content),
            computed: computed(content),
          }
        : null,
    };
  };
  const captureSvg = (svg, graphData) => {
    if (!svg) return null;
    const nodeGroups = [...svg.querySelectorAll('g.node')].map((group, index) => {
      const node = graphData?.nodes?.[index] ?? null;
      const outer = group.querySelector('.outer-path, .label-container');
      const divider = group.querySelector('.divider');
      const outerStyle = outer ? computed(outer) : null;
      const paintedPaths = outer
        ? [...outer.querySelectorAll('path')].map((path) => ({
            attrs: attrs(path, [
              'class',
              'fill',
              'stroke',
              'stroke-width',
              'style',
            ]),
            computed: computed(path),
          }))
        : [];
      return {
        index,
        graphNode: node
          ? {
              id: node.id ?? null,
              name: node.name ?? null,
              type: node.type ?? null,
              requirementId: node.requirementId ?? null,
              text: node.text ?? null,
              risk: node.risk ?? null,
              verifyMethod: node.verifyMethod ?? null,
              elementType: node.type ?? null,
              docRef: node.docRef ?? null,
              cssClasses: node.cssClasses ?? null,
              cssStyles: node.cssStyles ?? [],
              colorIndex: node.colorIndex ?? null,
              shape: node.shape ?? null,
              direction: node.direction ?? null,
              x: node.x ?? null,
              y: node.y ?? null,
              width: node.width ?? null,
              height: node.height ?? null,
            }
          : null,
        id: group.getAttribute('id'),
        class: group.getAttribute('class'),
        data: attrs(group, ['data-id', 'data-look', 'data-color-id']),
        transform: group.getAttribute('transform'),
        box: geometry(group),
        bbox: box(group),
        computed: computed(group),
        outerShape: outer
          ? {
              tag: outer.tagName.toLowerCase(),
              attrs: attrs(outer, ['class', 'x', 'y', 'width', 'height', 'fill', 'stroke', 'style']),
              box: geometry(outer),
              bbox: box(outer),
              computed: outerStyle,
              paintedPaths,
            }
          : null,
        divider: divider
          ? {
              tag: divider.tagName.toLowerCase(),
              attrs: attrs(divider, ['class', 'x1', 'y1', 'x2', 'y2', 'stroke', 'style']),
              box: geometry(divider),
              bbox: box(divider),
              computed: computed(divider),
            }
          : null,
        fields: [...group.querySelectorAll('g.label')].map(fieldLabel),
      };
    });
    const edgeGroups = [...svg.querySelectorAll('.relationshipLine')].map((path) => ({
      id: path.getAttribute('id'),
      class: path.getAttribute('class'),
      parentId: path.parentElement?.getAttribute('id') ?? null,
      parentClass: path.parentElement?.getAttribute('class') ?? null,
      parentTransform: path.parentElement?.getAttribute('transform') ?? null,
      box: geometry(path),
      bbox: box(path),
      attrs: attrs(path, [
        'd',
        'points',
        'x1',
        'y1',
        'x2',
        'y2',
        'stroke',
        'stroke-width',
        'fill',
        'marker-start',
        'marker-end',
      ]),
      computed: computed(path),
    }));
    const edgeLabels = [...svg.querySelectorAll('g.edgeLabel')].map((group) => ({
      id: group.getAttribute('id'),
      class: group.getAttribute('class'),
      transform: group.getAttribute('transform'),
      text: group.textContent?.trim() ?? '',
      box: geometry(group),
      bbox: box(group),
      fields: [...group.querySelectorAll('foreignObject')].map((foreignObject) => {
        const content = foreignObject.querySelector('div');
        return {
          attrs: attrs(foreignObject, ['x', 'y', 'width', 'height']),
          box: geometry(foreignObject),
          content: content
            ? { text: content.textContent?.trim() ?? '', box: geometry(content), computed: computed(content) }
            : null,
        };
      }),
    }));
    const markers = [...svg.querySelectorAll('defs marker')].map((marker) => ({
      id: marker.getAttribute('id'),
      attrs: attrs(marker, [
        'class',
        'viewBox',
        'refX',
        'refY',
        'markerWidth',
        'markerHeight',
        'orient',
        'markerUnits',
      ]),
      computed: computed(marker),
      shapes: [...marker.querySelectorAll('path, polygon, circle')].map((shape) => ({
        tag: shape.tagName.toLowerCase(),
        attrs: attrs(shape, ['d', 'points', 'fill', 'stroke', 'stroke-width']),
        bbox: box(shape),
        computed: computed(shape),
      })),
    }));
    const styles = mermaid.mermaidAPI.getConfig?.() ?? {};
    const themeVariables = styles.themeVariables ?? {};
    const elementClassCounts = {};
    for (const element of svg.querySelectorAll('[class]')) {
      const key = element.tagName.toLowerCase() + '.' + element.getAttribute('class').trim().replace(/\s+/g, '.');
      elementClassCounts[key] = (elementClassCounts[key] ?? 0) + 1;
    }
    return {
      attrs: attrs(svg, [
        'id',
        'width',
        'height',
        'viewBox',
        'preserveAspectRatio',
        'role',
        'aria-label',
        'aria-labelledby',
        'aria-describedby',
      ]),
      title: svg.querySelector(':scope > title')?.textContent ?? '',
      description: svg.querySelector(':scope > desc')?.textContent ?? '',
      box: geometry(svg),
      bbox: box(svg),
      computed: computed(svg),
      nodes: nodeGroups,
      edges: edgeGroups,
      edgeLabels,
      markers,
      elementClassCounts,
      theme: {
        name: styles.theme ?? null,
        requirementBackground: themeVariables.requirementBackground ?? null,
        requirementBorderColor: themeVariables.requirementBorderColor ?? null,
        requirementBorderSize: themeVariables.requirementBorderSize ?? null,
        requirementTextColor: themeVariables.requirementTextColor ?? null,
        relationColor: themeVariables.relationColor ?? null,
        relationLabelBackground: themeVariables.relationLabelBackground ?? null,
        relationLabelColor: themeVariables.relationLabelColor ?? null,
      },
    };
  };
  const waitForDiagram = async (block) => {
    for (let i = 0; i < 300; i++) {
      if (block.dataset.rendered === 'ok' || block.dataset.rendered === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for Mermaid requirement rendering.');
  };
  const snapshot = async (item, block) => {
    const apiDiagram = await mermaid.mermaidAPI.getDiagramFromText(item.source);
    const apiConfig = mermaid.mermaidAPI.getConfig?.() ?? {};
    const svg = block.querySelector('.mermaid-figure svg');
    const figure = block.querySelector('.mermaid-figure');
    const source = block.querySelector('.mermaid-source code');
    const blockStyle = getComputedStyle(block);
    const figureStyle = figure ? getComputedStyle(figure) : null;
    const cssTokens = Object.fromEntries(
      ['--bg', '--ink', '--muted', '--line-dark', '--danger'].map((name) => [
        name,
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      ]),
    );
    const db = parserDb(apiDiagram.db);
    const result = {
      id: item.id,
      status: block.dataset.rendered,
      sourceExpected: item.source,
      sourceRendered: source?.textContent ?? null,
      diagramType: apiDiagram.type ?? null,
      parserDb: db,
      markdown: {
        sourceDisplay: source ? getComputedStyle(source.closest('.mermaid-source')).display : null,
        errorText: block.querySelector('.mermaid-error')?.textContent ?? null,
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
            }
          : null,
      },
      mermaid: {
        version: mermaid.version ?? null,
        theme: apiConfig.theme ?? null,
        fontFamily: apiConfig.fontFamily ?? null,
        requirement: apiConfig.requirement ?? null,
      },
      cssTokens,
      svg: captureSvg(svg, db?.graphData ?? null),
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
    };
    return result;
  };

  window.renderRequirementCase = async (id) => {
    const item = fixture.cases.find((candidate) => candidate.id === id);
    if (!item) throw new Error('Unknown requirement case: ' + id);
    const fence = String.fromCharCode(96).repeat(3);
    const markdownSource = fence + 'mermaid\n' + item.source + '\n' + fence;
    const html = renderMarkdown(markdownSource);
    root.innerHTML = html;
    const block = root.querySelector('.mermaid-block');
    if (!block) throw new Error('Markdown did not make a Mermaid block for ' + id);
    if (!action) action = enhanceMarkdown(root, { html, ready: true });
    else action.update({ html, ready: true });
    await waitForDiagram(block);
    if (block.dataset.rendered !== 'ok') {
      throw new Error('Production Markdown Mermaid render failed for ' + id);
    }
    return snapshot(item, block);
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
  const darkIds = new Set([
    'all-requirement-types-risks-verification-methods',
    'classes-styles-duplicates-default-class',
  ]);
  const renderPlans = [
    { width: 390, height: 900, colorScheme: 'light', items: fixture.cases },
    {
      width: 768,
      height: 900,
      colorScheme: 'dark',
      items: fixture.cases.filter((item) => darkIds.has(item.id)),
    },
  ];
  const captures = { light390: [], dark768: [] };

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
        await page.goto('http://127.0.0.1:18922/requirement.html');
        await page.waitForFunction(() => window.fixtureReady);
        const errorStart = consoleErrors.length;
        const result = await page.evaluate(
          (id) => window.renderRequirementCase(id),
          item.id,
        );
        result.consoleErrors = consoleErrors.slice(errorStart);
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
        assert.equal(result.status, 'ok', 'unexpected render status for ' + item.id);
        assert.equal(result.environment.colorScheme, plan.colorScheme);
        assert.equal(result.svg?.nodes?.length, result.parserDb.graphData.nodes.length);
        assert.equal(
          result.svg?.edges?.length,
          result.parserDb.graphData.edges.length,
          JSON.stringify(result.svg?.elementClassCounts),
        );
        assert.deepEqual(pageErrors, [], 'page errors for ' + item.id);
        assert.deepEqual(badResponses, [], 'failed responses for ' + item.id);
        if (plan.colorScheme === 'light') captures.light390.push(result);
        else captures.dark768.push(result);
        await page.evaluate(() => window.destroyMarkdownEnhancer?.());
      } finally {
        await context.close();
      }
    }
  }

  const resultDocument = {
    fixture: 'mermaid-requirement-web-v1',
    parserFixture: fixture.fixture,
    webRevision,
    mermaidVersion: fixture.mermaidVersion,
    oracle:
      'Eight independent real Chrome captures through Pirc Markdown enhancement and pinned Mermaid. Per-capture data includes the RequirementDB raw projection and Mermaid graph input, SVG node field/foreignObject bounds and computed styles, divider geometry, edge paths and labels, markers, viewBox, and light/dark theme values.',
    browserVersion,
    productionInitialization: {
      source: 'apps/web/src/lib/markdown.ts loadMermaid()',
      securityLevel: 'strict',
      theme: 'base for light and dark for dark, selected by the production matchMedia path',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      deviceScaleFactor: 1,
      productionCss: 'apps/web/src/app.css and apps/web/src/markdown.css',
      screen: 'Playwright screen emulation uses the same CSS width and height as the viewport; each capture records measured screen and availWidth.',
    },
    captures,
  };
  const output = resolve(root, 'fixtures/mobile-parity/mermaid-requirement-web-expected.json');
  await writeFile(output, JSON.stringify(resultDocument, null, 2) + '\n');
  process.stdout.write(
    'Wrote ' +
      (captures.light390.length + captures.dark768.length) +
      ' actual Chrome requirement captures to ' +
      output +
      '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
