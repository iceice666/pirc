import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_app_status_web.mjs
// Mounts pinned App.svelte: status states, or populated screens with --conversation.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const interactive = process.argv.includes('--interactive');
const populated = interactive || process.argv.includes('--conversation');
const captureKind = interactive
  ? 'conversation-interaction-screen'
  : populated
    ? 'conversation-screen'
    : 'app-status';
const fixturePath = resolve(root, `fixtures/mobile-parity/${captureKind}.json`);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
for (const [name, key] of [
  ['PARITY_CAPTURE_WIDTHS', 'widths'],
  ['PARITY_CAPTURE_SCALES', 'textScales'],
]) {
  if (process.env[name]) fixture[key] = process.env[name].split(',').map(Number);
}
if (fixture.webRevision !== pinnedRevision)
  throw new Error('app-status fixture must use pinned web revision ' + pinnedRevision);
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-app-status'),
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
      name: 'app-status-parity',
      configureServer(server) {
        server.middlewares.use('/parity.html', async (_, res, next) => {
          const lines = [
            '<!doctype html>',
            '<html><head>',
            '<link rel="icon" href="data:,">',
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
            '</head><body><div id="app"></div>',
            '<script type="module">',
            'import "/src/app.css";',
            populated ? 'import "/src/markdown.css";' : '',
            'import { mount, tick } from "svelte";',
            'import App from "/src/App.svelte";',
            'import { app } from "/src/lib/app.svelte";',
            'import { fromSnapshot } from "/src/lib/state.ts";',
            populated ? 'import { preloadRenderers } from "/src/lib/markdown.ts";' : '',
            'const fixture = __APP_STATUS_FIXTURE__;',
            'const params = new URLSearchParams(location.search);',
            'const scenario = fixture.cases.find((item) => item.id === params.get("case"));',
            'if (!scenario) throw new Error("Unknown app-status case: " + params.get("case"));',
            'document.documentElement.style.setProperty("font-family", fixture.fontOverride.fontFamily, "important");',
            'document.documentElement.style.setProperty("--font-mono", fixture.fontOverride.mono, "important");',
            'window.__appStatusNetworkCalls = [];',
            'window.__appStatusFetch = window.fetch.bind(window);',
            'window.fetch = (input, init) => {',
            '  const url = typeof input === "string" ? input : input.url;',
            '  const pathname = new URL(url, location.href).pathname;',
            '  const body = init?.body ? JSON.parse(init.body) : undefined;',
            '  const isAnswer = fixture.state && pathname === "/api/sessions/" + fixture.session.id + "/interactions/" + fixture.state.interactions[0].id + "/answer";',
            '  if (isAnswer && (init?.method !== "POST" || body?.generation !== 7 || typeof body?.clientId !== "string" || body.answer?.value !== scenario.answer?.value)) throw new Error("Unexpected outgoing answer: " + JSON.stringify(body));',
            '  const response = isAnswer ? {} : fixture.directory && pathname === "/api/sessions/" + fixture.session.id + "/files" ? fixture.directory : fixture.panel && pathname === "/api/sessions/" + fixture.session.id + "/panel/state" ? fixture.panel : undefined;',
            '  window.__appStatusNetworkCalls.push({ kind: "fetch", url, method: init?.method ?? "GET", fixtureResponse: response !== undefined, ...(body ? {body} : {}) });',
            '  if (response !== undefined) return Promise.resolve(new Response(JSON.stringify(response), { headers: {"Content-Type":"application/json"} }));',
            '  return Promise.reject(new Error("Network access is disabled in app-status capture: " + url));',
            '};',
            'window.WebSocket = class {',
            '  constructor(url) {',
            '    window.__appStatusNetworkCalls.push({ kind: "websocket", url: String(url) });',
            '    throw new Error("WebSocket access is disabled in app-status capture: " + url);',
            '  }',
            '};',
            'window.requestIdleCallback = () => 0;',
            'for (const name of fixture.runtimeStubs.singletonMethods) {',
            '  app[name] = async () => undefined;',
            '}',
            'app.view = fixture.ui.view;',
            'app.workspaces = scenario.hasSession ? fixture.workspaces : [];',
            'app.nodes = scenario.hasSession ? fixture.nodes : [];',
            'app.sessions = scenario.hasSession ? [fixture.session] : [];',
            'app.models = scenario.hasSession ? fixture.models : [];',
            'app.activeSessionId = scenario.hasSession ? fixture.session.id : undefined;',
            'app.sessionState = scenario.hasSession ? fromSnapshot({',
            '  session: fixture.session,',
            '  runnerStatus: fixture.session.runnerStatus,',
            '  run: fixture.state?.run ?? null,',
            '  messages: fixture.messages ?? [],',
            '  interactions: fixture.state?.interactions ?? [],',
            '  queue: fixture.state?.queue ?? [],',
            '  control: {',
            '    heldByCurrentClient: scenario.controlHeld,',
            '    holderName: scenario.holderName ?? undefined,',
            '    generation: 7',
            '  },',
            '  cursor: "1:1",',
            '  runnerEpoch: "status-fixture",',
            '  selectedModelId: fixture.models[0].id,',
            '  selectedModelProvider: fixture.models[0].provider,',
            '  thinkingLevel: "medium",',
            '  widgets: fixture.state?.widgets ?? {},',
            '  statuses: fixture.state?.statuses ?? {}',
            '}) : undefined;',
            'app.loading = scenario.loading;',
            'app.connection = scenario.connection;',
            'app.pageError = scenario.pageError;',
            'app.demo = undefined;',
            'app.draft = fixture.draft ?? "";',
            'app.uploads = fixture.attachments ?? [];',
            'if (fixture.panel) app.panel.reset(fixture.session.id, fixture.panel);',
            'app.hiddenMessages = 0;',
            'app.commandBusy = false;',
            'app.bootstrap = async () => undefined;',
            'window.__appStatusScenario = scenario;',
            'window.__appStatusInstance = app;',
            populated ? 'await preloadRenderers();' : '',
            'mount(App, { target: document.querySelector("#app") });',
            'await tick();',
            'await document.fonts.ready;',
            'await new Promise((resolve) => setTimeout(resolve, 350));',
            'await tick();',
            'window.captureAppStatus = () => {',
            '  const selectors = [',
            '    ["appShell", ".app-shell"],',
            '    ["sidebarScrim", ".sidebar-scrim"],',
            '    ["sidebar", ".sidebar"],',
            '    ["sidebarBrand", ".sidebar .brand-row"],',
            '    ["sidebarNewSession", ".sidebar .new-session"],',
            '    ["sidebarSearch", ".sidebar .search"],',
            '    ["sidebarSearchInput", ".sidebar .search input"],',
            '    ["sidebarScroll", ".sidebar .sidebar-scroll"],',
            '    ["sidebarEmptyNote", ".sidebar .sidebar-scroll > .empty-note"],',
            '    ["sidebarFooterSettings", ".sidebar .sidebar-footer > .settings-entry"],',
            '    ["mobileTabs", ".mobile-tabs"],',
            '    ["workspace", ".workspace"],',
            '    ["loadingState", ".workspace > .loading-state"],',
            '    ["topbar", ".workspace > .topbar"],',
            '    ["breadcrumb", ".topbar .breadcrumb"],',
            '    ["sessionTitle", ".topbar h1"],',
            '    ["connectionPill", ".connection-pill"],',
            '    ["errorBanner", ".error-banner"],',
            '    ["errorDismiss", ".error-banner button"],',
            '    ["viewerBanner", ".viewer-banner"],',
            '    ["contentGrid", ".content-grid"],',
            '    ["conversation", ".conversation"],',
            '    ["timeline", ".timeline"],',
            '    ["timelineInner", ".timeline-inner"],',
            '    ["emptyConversation", ".empty-conversation"],',
            '    ["emptyConversationMark", ".empty-conversation > span"],',
            '    ["emptyConversationIcon", ".empty-conversation > span svg"],',
            '    ["emptyConversationHeading", ".empty-conversation h2"],',
            '    ["emptyConversationDescription", ".empty-conversation p"],',
            '    ["loadingStateMark", ".loading-state .large-mark"],',
            '    ["loadingStateIcon", ".loading-state > svg, .loading-state .large-mark > svg"],',
            '    ["loadingStateText", ".loading-state p"],',
            '    ["composer", ".composer"],',
            '    ["messages", ".message"],',
            '    ["interactionCards", ".interaction-card"],',
            '    ["interactionParts", ".interaction-card .eyebrow, .interaction-card h3, .interaction-card header p, .interaction-card strong, .interaction-card small, .interaction-card footer button"],',
            '    ["composerDock", ".composer-dock"],',
            '    ["queuedPrompts", ".queue-dock-text"],',
            '    ["runCards", ".run-card"],',
            '    ["runFiles", ".run-files code, .run-files span"],',
            '    ["codeBlocks", ".conversation pre"],',
            '    ["attachments", ".attachment-preview"],',
            '    ["sidePanel", ".side-panel"],',
            '    ["fileRows", ".side-panel .file-row"],',
            '    ["statusIcons", ".connection-pill svg, .error-banner svg, .viewer-banner svg"]',
            '  ];',
            '  const styleNames = [',
            '    "display", "position", "boxSizing", "width", "height", "minWidth", "minHeight",',
            '    "maxWidth", "marginTop", "marginRight", "marginBottom", "marginLeft",',
            '    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",',
            '    "backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight",',
            '    "borderTopWidth", "borderTopStyle", "borderTopColor", "borderRadius",',
            '    "gap", "alignItems", "justifyContent", "flexDirection", "gridTemplateColumns",',
            '    "overflow", "overflowX", "opacity", "visibility", "transform", "zIndex"',
            '  ];',
            '  const box = (element) => {',
            '    const r = element.getBoundingClientRect();',
            '    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };',
            '  };',
            '  const inspect = (element) => {',
            '    const style = getComputedStyle(element);',
            '    const computed = Object.fromEntries(styleNames.map((name) => [name, style[name]]));',
            '    return {',
            '      tag: element.tagName.toLowerCase(),',
            '      className: typeof element.className === "string" ? element.className : element.getAttribute("class"),',
            '      text: (element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 500),',
            '      box: box(element),',
            '      computed,',
            '      attributes: {',
            '        ariaLabel: element.getAttribute("aria-label"),',
            '        ariaExpanded: element.getAttribute("aria-expanded"),',
            '        ariaCurrent: element.getAttribute("aria-current"),',
            '        disabled: element.hasAttribute("disabled"),',
            '        inert: element.hasAttribute("inert"),',
            '        dataMode: element.getAttribute("data-mode"),',
            '        placeholder: element.getAttribute("placeholder")',
            '      }',
            '    };',
            '  };',
            '  const elements = Object.fromEntries(selectors.map(([name, selector]) => [',
            '    name, [...document.querySelectorAll(selector)].map(inspect)',
            '  ]));',
            '  const sidebar = document.querySelector(".sidebar");',
            '  const workspace = document.querySelector(".workspace");',
            '  const topbar = document.querySelector(".topbar");',
            '  const error = document.querySelector(".error-banner");',
            '  const pill = document.querySelector(".connection-pill");',
            '  const errorIcon = error?.querySelector("svg");',
            '  const dismissIcon = error?.querySelector("button svg");',
            '  return {',
            '    id: scenario.id,',
            '    url: location.pathname + location.search,',
            '    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },',
            '    appState: { loading: app.loading, hasSession: !!app.sessionState, connection: app.connection, pageError: app.pageError, controlHeld: app.hasControl, messageIds: app.sessionState?.messages.map(message => message.id) ?? [], draft: app.draft, uploadIds: app.uploads.map(upload => upload.id) },',
            '    initialPhoneNavigation: {',
            '      sidebarOpenClass: sidebar?.classList.contains("open") ?? false,',
            '      sidebarVisibility: sidebar ? getComputedStyle(sidebar).visibility : null,',
            '      sidebarScrimDisplay: document.querySelector(".sidebar-scrim") ? getComputedStyle(document.querySelector(".sidebar-scrim")).display : null,',
            '      workspaceInert: workspace?.hasAttribute("inert") ?? false,',
            '      mobileTabsPresent: !!document.querySelector(".mobile-tabs")',
            '    },',
            '    geometryRelations: {',
            '      errorBannerTopAfterHeaderBottom: topbar && error ? error.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom : null,',
            '      connectionPillCenterYFromHeaderTop: topbar && pill ? pill.getBoundingClientRect().top + pill.getBoundingClientRect().height / 2 - topbar.getBoundingClientRect().top : null,',
            '      errorIconBox: errorIcon ? box(errorIcon) : null,',
            '      dismissIconBox: dismissIcon ? box(dismissIcon) : null',
            '    },',
            '    cssTokens: Object.fromEntries(["--bg", "--bg-sidebar", "--ink", "--muted", "--line", "--line-dark", "--danger", "--danger-soft"].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),',
            '    bodyText: document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").trim(),',
            '    elements,',
            '    activeElement: document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), className: document.activeElement.className, ariaLabel: document.activeElement.getAttribute("aria-label") } : null,',
            '    networkCalls: window.__appStatusNetworkCalls',
            '  };',
            '};',
            'window.captureReady = true;',
            '</script></body></html>',
          ];
          const html = lines.join('\n').replace('__APP_STATUS_FIXTURE__', fixtureSource);
          try {
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
      for (const textScale of fixture.textScales ?? [1]) {
        for (const item of fixture.cases) {
          const page = await browser.newPage({
            viewport: { width, height: fixture.height },
            deviceScaleFactor: fixture.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
            locale: 'en-US',
            colorScheme,
          });
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const pageErrors = [];
          const consoleErrors = [];
          const badResponses = [];
          page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          page.on('response', (response) => {
            if (response.status() >= 400)
              badResponses.push(response.status() + ' ' + response.url());
          });
          try {
            await page.goto('http://127.0.0.1:18908/parity.html' + item.query, {
              waitUntil: 'networkidle',
            });
            await page.waitForFunction(
              () => window.captureReady && typeof window.captureAppStatus === 'function',
            );
            if (item.panelOpen) {
              await page.getByRole('button', { name: 'Show side panel', exact: true }).tap();
              await page.waitForSelector('.side-panel .file-row');
            }
            if (textScale !== 1) {
              await page.evaluate((scale) => {
                // Controlled text-only scaling at the same CSS viewport. Capture
                // original font/line sizes before changing any inherited styles.
                const entries = [...document.querySelectorAll('.app-shell, .app-shell *')]
                  .filter((node) => node instanceof HTMLElement)
                  .map((node) => {
                    const style = getComputedStyle(node);
                    return [node, parseFloat(style.fontSize), style.lineHeight];
                  });
                for (const [node, size, line] of entries) {
                  node.style.setProperty('font-size', size * scale + 'px', 'important');
                  if (line !== 'normal')
                    node.style.setProperty(
                      'line-height',
                      parseFloat(line) * scale + 'px',
                      'important',
                    );
                }
              }, textScale);
            }
            if (interactive) {
              const submit = page.getByRole('button', { name: 'Submit', exact: true });
              if (!(await submit.isDisabled()))
                throw new Error('Unselected question must be disabled');
              if (item.choice || item.answer) {
                await page.getByRole('radio', { name: /^Tablet/ }).tap();
                if (await submit.isDisabled()) throw new Error('Selected question must be enabled');
                if (
                  (await page
                    .getByRole('radio', { name: /^Tablet/ })
                    .getAttribute('aria-checked')) !== 'true'
                )
                  throw new Error('Selected radio state must be exposed');
              }
              if (item.answer) {
                await submit.tap();
                await page.waitForFunction(
                  () => window.__appStatusInstance.pendingInteractions.length === 0,
                );
              }
            }
            if (interactive) {
              // End sticky touch hover on a neutral outer gutter; the native
              // capture performs the same gesture before measuring.
              await page.touchscreen.tap(width - 1, fixture.height - 1);
            }
            if (populated) {
              await page.waitForTimeout(100);
              await page.evaluate((atEnd) => {
                const transcript = document.querySelector('.timeline');
                transcript.scrollTop = atEnd ? transcript.scrollHeight : 0;
              }, interactive);
              await page.waitForTimeout(100);
              if (
                !interactive &&
                (await page.locator('.timeline').evaluate((node) => node.scrollTop)) !== 0
              )
                throw new Error('Transcript did not retain the shared top reading position');
            }
            const result = await page.evaluate(() => window.captureAppStatus());
            // Preserve the existing status-oracle schema; these fields describe
            // the populated conversation mode only.
            if (!populated) {
              for (const key of ['messageIds', 'draft', 'uploadIds']) delete result.appState[key];
              for (const key of [
                'timeline',
                'timelineInner',
                'messages',
                'runCards',
                'runFiles',
                'codeBlocks',
                'attachments',
                'interactionCards',
                'interactionParts',
                'composerDock',
                'queuedPrompts',
                'sidePanel',
                'fileRows',
              ])
                delete result.elements[key];
            }
            if (populated) {
              result.textScale = textScale;
              if (interactive) {
                result.interactionEvidence = await page.evaluate(() => ({
                  selectedLabels: [
                    ...document.querySelectorAll(
                      '.interaction-card .option[aria-checked="true"] strong',
                    ),
                  ].map((node) => node.textContent),
                  hoveredOptions: [
                    ...document.querySelectorAll('.interaction-card .option:hover'),
                  ].map((node) => node.textContent.trim()),
                  pendingIds: window.__appStatusInstance.pendingInteractions.map((item) => item.id),
                  queueIds: window.__appStatusInstance.sessionState.queue.map((item) => item.id),
                  runStatus: window.__appStatusInstance.sessionState.run.status,
                }));
                if (result.interactionEvidence.hoveredOptions.length)
                  throw new Error('Canonical snapshot must not retain sticky option hover');
                const expectedQuestions = item.answer ? 0 : fixture.state.interactions.length;
                if (
                  result.elements.interactionCards.length !== expectedQuestions ||
                  result.elements.queuedPrompts.length !== fixture.state.queue.length
                )
                  throw new Error('Question/queue render mismatch');
                const answers = result.networkCalls.filter((call) => call.url.endsWith('/answer'));
                if (answers.length !== (item.answer ? 1 : 0))
                  throw new Error('Answer must be sent exactly once');
              }
              result.syntaxHighlight = await page
                .locator('.code-block code.hljs [class*="hljs-"]')
                .evaluateAll((nodes) =>
                  nodes.map((node) => ({
                    token: node.className,
                    text: node.textContent,
                    color: getComputedStyle(node).color,
                    fontWeight: getComputedStyle(node).fontWeight,
                  })),
                );
              if (
                !result.syntaxHighlight.some((node) => node.token.includes('hljs-keyword')) ||
                !result.syntaxHighlight.some((node) => node.token.includes('hljs-string'))
              )
                throw new Error(
                  'Populated code must retain actual keyword and string highlighting',
                );
              if (
                result.elements.messages.length !== 2 ||
                result.elements.runCards.length !== 1 ||
                result.elements.codeBlocks.length !== 1 ||
                result.elements.attachments.length !== 1
              )
                throw new Error(
                  'Populated capture must retain both message bubbles, the tool run, code and attachment',
                );
              if (
                JSON.stringify(result.appState.messageIds) !==
                  JSON.stringify(fixture.messages.map((message) => message.id)) ||
                result.appState.draft !== fixture.draft
              )
                throw new Error('Rendered App state does not match the shared snapshot/draft');
              if (
                item.panelOpen &&
                result.elements.fileRows.length !== fixture.directory.entries.length
              )
                throw new Error('Files panel does not show all shared directory entries');
            }
            result.colorScheme = colorScheme;
            result.width = width;
            result.fontOverride = fixture.fontOverride;
            result.networkStub = fixture.runtimeStubs.description;
            result.pageErrors = pageErrors;
            result.consoleErrors = consoleErrors;
            result.badResponses = badResponses;
            if (result.networkCalls.some((call) => !call.fixtureResponse))
              throw new Error(
                item.id +
                  ' unexpectedly attempted gateway/network access: ' +
                  JSON.stringify(result.networkCalls),
              );
            if (badResponses.length) throw new Error(badResponses.join('\n'));
            if (pageErrors.length) throw new Error(pageErrors.join('\n'));
            if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
            const screenshot =
              captureKind +
              '-web-' +
              item.id +
              '-' +
              width +
              '-' +
              colorScheme +
              (populated ? '-scale' + textScale : '') +
              '.png';
            result.screenshot = screenshot;
            widthResults.push(result);
            await page.screenshot({ path: resolve(out, screenshot), fullPage: true });
          } finally {
            await page.close();
          }
        }
      }
      themeResults.push({ width, cases: widthResults });
    }
    resultsByTheme[colorScheme] = { widths: themeResults };
  }
  const resultDocument = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    fontOverride: fixture.fontOverride,
    runtimeStubs: fixture.runtimeStubs,
    themes: resultsByTheme,
  };
  const json = JSON.stringify(resultDocument, null, 2) + '\n';
  await writeFile(resolve(out, captureKind + '-web.json'), json);
  if (!populated)
    await writeFile(resolve(root, 'fixtures/mobile-parity/app-status-expected.json'), json);
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
