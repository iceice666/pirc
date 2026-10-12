/**
 * Golden browser corpus for the Rust port of the node's browser (plans/rust-rewrite.md, M8):
 * runs every case of `crates/pirc-node/tests/fixtures/browser/cases/*.json` through
 * Playwright itself, the way `apps/gateway/src/node/browser.ts` drives it, and writes
 * what Playwright returned to `crates/pirc-node/tests/fixtures/browser/expected/<case>.json`.
 * The case language and the fixture server are described in
 * `crates/pirc-node/tests/fixtures/browser/README.md`.
 *
 * Rerun (Linux, from the repository root, after `bun install --frozen-lockfile`):
 *
 *   nix develop -c bun scripts/browser-reference.ts            # all cases
 *   nix develop -c bun scripts/browser-reference.ts form mutate # some cases
 *   nix develop -c bun scripts/browser-reference.ts --check     # compare, write nothing
 *
 * Chromium is the dev shell's `chromium` (found on PATH like browser.ts does), or
 * PIRC_BROWSER_EXECUTABLE. Playwright is the pinned playwright-core of
 * apps/gateway/node_modules (1.63.0). The browser starts with browser.ts's
 * `launchPersistentContext` options (fresh profile, viewport 1280x800, no downloads,
 * service workers blocked, secret-free environment), its host guard routes
 * (`context.route`, `routeWebSocket`, loopback allowed as with
 * PIRC_BROWSER_ALLOW_PRIVATE=127.0.0.1,localhost) and its action overlay
 * (`page.screencast.showActions({ duration: 600 })`).
 *
 * The pages are served from loopback by this script: two sites on one port,
 * `127.0.0.1:<port>` ({{HOST_A}}) and `localhost:<port>` ({{HOST_B}}), so an iframe of
 * one inside the other is an out-of-process iframe. Ports are written back as
 * those placeholders; nothing else is normalized.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Frame, Locator, Page } from 'playwright-core';
import prettier from 'prettier';
import { chromium } from '../apps/gateway/node_modules/playwright-core/index.js';
import { pageMarkdown, passwordValues } from '../apps/gateway/src/node/browser-extract.js';
import { findBrowserExecutable } from '../apps/gateway/src/node/browser-executable.js';
import { BrowserHostGuard } from '../apps/gateway/src/node/browser-hosts.js';
import { maskPasswords, sensitiveField } from '../apps/gateway/src/node/browser.js';
import { withoutSecrets } from '../apps/gateway/src/node/secrets.js';

const root = path.join(import.meta.dir, '..');
const fixtures = path.join(root, 'crates/pirc-node/tests/fixtures/browser');
const pagesDir = path.join(fixtures, 'pages');
const casesDir = path.join(fixtures, 'cases');
const expectedDir = path.join(fixtures, 'expected');

// browser.ts's defaults (PIRC_BROWSER_VIEWPORT unset, its operation timeouts).
const VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT = 10_000;

interface Step {
  op: string;
  /** Regex matched against the lines of a snapshot; the first matching line's ref is used. */
  target?: string;
  /** Which saved snapshot `target` is matched against (default: the latest). */
  in?: string;
  /** A literal ref instead of `target`. */
  ref?: string;
  /** Snapshot name to save under (snapshot). */
  name?: string;
  url?: string;
  text?: string;
  textGone?: string;
  key?: string;
  values?: string[];
  button?: 'left' | 'right' | 'middle';
  double?: boolean;
  timeout?: number;
  helper?: string;
  expression?: string;
  frames?: 'main' | 'all';
  mask?: boolean;
  /** The step must fail; its cleaned error message is recorded. */
  error?: boolean;
  note?: string;
}

interface Case {
  description: string;
  steps: Step[];
}

// ---- fixture server -------------------------------------------------------------

function startServer() {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const host = `127.0.0.1:${server.port}`;
      const other = `localhost:${server.port}`;
      if (url.pathname === '/slow') {
        const ms = Math.min(Number(url.searchParams.get('ms') ?? 0) || 0, 10_000);
        await Bun.sleep(ms);
        return new Response(url.searchParams.get('text') ?? '', {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (url.pathname === '/redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: url.searchParams.get('to') ?? '/' },
        });
      }
      const status = /^\/status\/(\d{3})$/.exec(url.pathname);
      if (status) {
        const code = Number(status[1]);
        return new Response(`<!doctype html><title>Status ${code}</title><p>Status ${code}</p>`, {
          status: code,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const name = url.pathname.slice(1);
      if (/^[a-z0-9-]+\.html$/.test(name)) {
        try {
          const html = readFileSync(path.join(pagesDir, name), 'utf8')
            .replaceAll('{{HOST_A}}', host)
            .replaceAll('{{HOST_B}}', other);
          return new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        } catch {
          /* fall through */
        }
      }
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    },
  });
  return server;
}

// ---- browser.ts mirrors ------------------------------------------------------------

/**
 * The Playwright methods each op calls. Playwright prefixes an error's message
 * with the api name it reads from the caller's stack (`goto: …` when this
 * script runs from source under Bun, `page.goto: …` under V8). The production
 * TS node (`bun build --compile --minify`, apps/gateway/dist) gets no prefix,
 * and that is what agents see and the Rust node reproduces: the recorder
 * strips exactly that prefix, for the method the failing step called.
 */
const API_NAMES: Record<string, string[]> = {
  goto: ['goto'],
  back: ['goBack'],
  snapshot: ['ariaSnapshot'],
  click: ['click'],
  hover: ['hover'],
  fill: ['fill'],
  type: ['fill', 'pressSequentially'],
  press: ['press'],
  select: ['selectOption'],
  keyboard: ['press'],
  insertText: ['insertText'],
  waitFor: ['waitFor'],
  evaluate: ['evaluate'],
};

function withoutApiPrefix(op: string, message: string): string {
  for (const name of API_NAMES[op] ?? []) {
    const prefix = new RegExp(`^(?:[A-Za-z]+\\.)?${name}: `);
    if (prefix.test(message)) return message.replace(prefix, '');
  }
  return message;
}

/** browser.ts's `cleanError`, of the message as the compiled TS node sees it. */
function cleanError(op: string, error: unknown): string {
  const text = withoutApiPrefix(op, error instanceof Error ? error.message : String(error));
  return text.split('\nCall log:')[0]!.split('\n').slice(0, 4).join('\n').slice(0, 1_000);
}

/** browser.ts's `settle`. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

/** browser.ts's `guardContext`, with loopback allowed (PIRC_BROWSER_ALLOW_PRIVATE). */
async function guardContext(context: BrowserContext) {
  const hosts = new BrowserHostGuard({
    allowPrivateHosts: ['127.0.0.1', 'localhost'],
    gatewayHost: undefined,
    blockedHosts: undefined,
  });
  await context.route('**/*', async (route) => {
    const reason = await hosts.blockedReason(route.request().url());
    if (reason) await route.abort('blockedbyclient').catch(() => undefined);
    else await route.continue().catch(() => undefined);
  });
  await context.routeWebSocket(
    () => true,
    async (ws) => {
      const reason = await hosts.blockedReason(ws.url());
      if (reason) await ws.close({ code: 1008, reason: 'blocked by pirc' }).catch(() => undefined);
      else ws.connectToServer();
    },
  );
}

// ---- runner ------------------------------------------------------------------------

class Runner {
  snapshots = new Map<string, string>();
  latest = '';
  constructor(
    readonly page: Page,
    readonly expand: (text: string) => string,
  ) {}

  ref(step: Step): string {
    if (step.ref) return step.ref;
    if (!step.target) throw new Error(`step ${step.op} needs target or ref`);
    const snapshot = step.in ? this.snapshots.get(step.in) : this.latest;
    if (snapshot === undefined) throw new Error(`no snapshot named ${step.in}`);
    const pattern = new RegExp(step.target);
    for (const line of snapshot.split('\n')) {
      if (!pattern.test(line)) continue;
      const match = /\[ref=([a-z0-9]+)\]/.exec(line);
      if (match) return match[1]!;
    }
    throw new Error(`no snapshot line with a ref matches /${step.target}/`);
  }

  locator(ref: string): Locator {
    return this.page.locator(`aria-ref=${ref}`);
  }

  async run(step: Step): Promise<Record<string, unknown>> {
    const page = this.page;
    const out: Record<string, unknown> = {};
    const timeout = step.timeout ?? ACTION_TIMEOUT;
    switch (step.op) {
      case 'goto': {
        // browser.ts's goto, without the host check before navigating.
        const response = await page.goto(this.expand(step.url!), {
          waitUntil: 'domcontentloaded',
          timeout: step.timeout ?? 30_000,
        });
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
        out.status = response?.status() ?? null;
        out.title = await page.title();
        break;
      }
      case 'back': {
        const response = await page.goBack({ timeout: 15_000, waitUntil: 'domcontentloaded' });
        out.response = response ? response.status() : null;
        break;
      }
      case 'snapshot': {
        let snapshot = await page.ariaSnapshot({ mode: 'ai', timeout });
        if (step.mask) {
          const values = await Promise.all(
            page
              .frames()
              .map((frame) => frame.evaluate(passwordValues).catch(() => [] as string[])),
          );
          snapshot = maskPasswords(snapshot, values.flat());
        }
        this.latest = snapshot;
        if (step.name) this.snapshots.set(step.name, snapshot);
        out.snapshot = snapshot;
        break;
      }
      case 'click': {
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).click({
          timeout,
          button: step.button ?? 'left',
          clickCount: step.double ? 2 : 1,
        });
        await settle(page);
        break;
      }
      case 'hover': {
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).hover({ timeout });
        break;
      }
      case 'fill': {
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).fill(step.text ?? '', { timeout });
        await settle(page);
        break;
      }
      case 'type': {
        // browser.ts's `type` with slowly: clear, then key by key.
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).fill('', { timeout });
        await this.locator(ref).pressSequentially(step.text ?? '', {
          timeout: step.timeout ?? 30_000,
          delay: 20,
        });
        await settle(page);
        break;
      }
      case 'press': {
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).press(step.key!, { timeout });
        await settle(page);
        break;
      }
      case 'select': {
        const ref = (out.ref = this.ref(step));
        await this.locator(ref).selectOption(step.values ?? [], { timeout });
        await settle(page);
        break;
      }
      case 'keyboard':
        await page.keyboard.press(step.key!);
        await settle(page);
        break;
      case 'insertText':
        await page.keyboard.insertText(step.text ?? '');
        break;
      case 'waitFor':
        if (step.text)
          await page.getByText(step.text).first().waitFor({ state: 'visible', timeout });
        else if (step.textGone)
          await page.getByText(step.textGone).first().waitFor({ state: 'hidden', timeout });
        else throw new Error('waitFor needs text or textGone');
        break;
      case 'evaluate':
        out.result = await this.evaluate(step);
        break;
      case 'frames':
        out.frames = page.frames().map((frame) => ({
          url: frame.url(),
          name: frame.name(),
          parent: frame.parentFrame() ? page.frames().indexOf(frame.parentFrame()!) : null,
        }));
        break;
      case 'targets': {
        // Out-of-process iframes are targets of their own (type "iframe").
        const cdp = await page.context().newCDPSession(page);
        try {
          const { targetInfos } = (await cdp.send('Target.getTargets')) as {
            targetInfos: Array<{ type: string; url: string }>;
          };
          out.iframeTargets = targetInfos
            .filter((info) => info.type === 'iframe')
            .map((info) => info.url)
            .sort();
        } finally {
          await cdp.detach().catch(() => undefined);
        }
        break;
      }
      case 'wait':
        await page.waitForTimeout(step.timeout ?? 0);
        break;
      default:
        throw new Error(`unknown op ${step.op}`);
    }
    return out;
  }

  async evaluate(step: Step): Promise<unknown> {
    const page = this.page;
    if (step.expression) return page.evaluate(step.expression);
    const perFrame = async <T>(fn: (frame: Frame) => Promise<T>, fallback: T) =>
      step.frames === 'all'
        ? Promise.all(page.frames().map((frame) => fn(frame).catch(() => fallback)))
        : fn(page.mainFrame());
    switch (step.helper) {
      case 'pageMarkdown':
        return page.evaluate(pageMarkdown);
      case 'innerText':
        // web_fetch's text format.
        return page.evaluate(() => (globalThis as any).document.body?.innerText ?? '');
      case 'content':
        // web_fetch's html format.
        return page.content();
      case 'passwordValues':
        return perFrame((frame) => frame.evaluate(passwordValues), [] as string[]);
      case 'sensitiveField':
        if (step.target || step.ref) {
          const ref = this.ref(step);
          return this.locator(ref).evaluate(sensitiveField, undefined, {
            timeout: step.timeout ?? ACTION_TIMEOUT,
          });
        }
        return perFrame((frame) => frame.evaluate(sensitiveField), false);
      default:
        throw new Error(`unknown helper ${step.helper}`);
    }
  }
}

// ---- main ----------------------------------------------------------------------------

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.filter((arg) => !arg.startsWith('--'));
const executable = findBrowserExecutable(process.env.PIRC_BROWSER_EXECUTABLE);
if (!executable) {
  console.error('No Chromium found: run inside `nix develop` or set PIRC_BROWSER_EXECUTABLE');
  process.exit(1);
}
const names = readdirSync(casesDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .filter((name) => !only.length || only.includes(name))
  .sort();

const server = startServer();
const port = String(server.port);
const hostA = `127.0.0.1:${port}`;
const hostB = `localhost:${port}`;
const expand = (text: string) =>
  text.replaceAll('{{HOST_A}}', hostA).replaceAll('{{HOST_B}}', hostB);
const normalize = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value.replaceAll(hostA, '{{HOST_A}}').replaceAll(hostB, '{{HOST_B}}');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
};

const profile = mkdtempSync(path.join(tmpdir(), 'pirc-browser-reference-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: executable,
  headless: true,
  viewport: VIEWPORT,
  acceptDownloads: false,
  serviceWorkers: 'block',
  env: withoutSecrets(process.env),
});
let failed = false;
try {
  await guardContext(context);
  for (const name of names) {
    const spec = JSON.parse(readFileSync(path.join(casesDir, `${name}.json`), 'utf8')) as Case;
    const page = await context.newPage();
    await page.screencast.showActions({ duration: 600 });
    const runner = new Runner(page, expand);
    const steps: unknown[] = [];
    try {
      for (const [index, step] of spec.steps.entries()) {
        let entry: Record<string, unknown>;
        try {
          const result = await runner.run(step);
          if (step.error) throw new Error(`step ${index} (${step.op}) should have failed`);
          entry = { op: step.op, ...result };
        } catch (error) {
          if (!step.error || String(error).includes('should have failed')) throw error;
          entry = { op: step.op, error: cleanError(step.op, error) };
          // The ref the failing step used, when it resolved one.
          if (step.target || step.ref)
            try {
              entry.ref = runner.ref(step);
            } catch {
              /* none */
            }
        }
        // Where a failed navigation leaves the page (an error page, committed
        // asynchronously) is a race: not recorded.
        if (!('error' in entry && (step.op === 'goto' || step.op === 'back')))
          entry.url = page.url();
        steps.push(entry);
      }
    } catch (error) {
      failed = true;
      console.error(`${name}: ${(error as Error).stack ?? error}`);
      continue;
    } finally {
      await page.close().catch(() => undefined);
    }
    const file = path.join(expectedDir, `${name}.json`);
    // Formatted as `bun run format` would, so format:check leaves it alone.
    const text = await prettier.format(JSON.stringify(normalize({ case: name, steps })), {
      ...(await prettier.resolveConfig(file)),
      parser: 'json',
    });
    if (check) {
      let previous = '';
      try {
        previous = readFileSync(file, 'utf8');
      } catch {
        /* missing */
      }
      if (previous !== text) {
        failed = true;
        console.error(`${name}: differs from expected/${name}.json`);
      } else console.log(`${name}: same`);
    } else {
      writeFileSync(file, text);
      console.log(`${name}: wrote expected/${name}.json`);
    }
  }
} finally {
  await context.close().catch(() => undefined);
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
const version = await (async () => {
  const proc = Bun.spawn([executable, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  return (await new Response(proc.stdout).text()).trim();
})();
console.log(`Chromium: ${version} (${executable})`);
process.exit(failed ? 1 : 0);
