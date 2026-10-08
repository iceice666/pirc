/**
 * Browsers for the agent's web tools (docs/history/browser.md). The node owns one
 * Chromium per workspace, with a persistent profile, so a login made once
 * serves every session of the workspace (Chromium locks a profile to one
 * process, and agents come and go). Each session gets its own tab group.
 *
 * Viewers (the web and Android side panel) watch a session's active page as
 * a JPEG screencast. With the control lease a viewer can take over: the tab
 * switches to user mode, the agent's browser tools wait, and mouse/keyboard
 * input is forwarded until control is returned.
 *
 * Not a sandbox: the browser has the node account's network access and the
 * workspace profile's logins. It may only reach public hosts: loopback,
 * private and link-local addresses, local names and the gateway itself are
 * refused (node/browser-hosts.ts) unless the node allows them
 * (PIRC_BROWSER_ALLOW_PRIVATE). Never log into the pirc web UI inside an
 * agent's browser profile: a later agent could drive it with those cookies.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { ApiError } from '../errors.js';
import { pageMarkdown, passwordValues } from './browser-extract.js';
import { BrowserHostGuard, blockedError, type Resolver } from './browser-hosts.js';
import { withoutSecrets } from './secrets.js';

export interface BrowserSettings {
  /** Agent browser tools and the Browser panel (PIRC_BROWSER, default on when a browser is found). */
  enabled: boolean;
  /** Chromium executable (PIRC_BROWSER_EXECUTABLE, else found on PATH / in /Applications). */
  executable?: string | undefined;
  /** ffmpeg for recordings (PIRC_FFMPEG, default `ffmpeg`). */
  ffmpeg: string;
  /**
   * An on-disk playwright-core package directory (PIRC_PLAYWRIGHT_CORE). It
   * reads its own files by computed paths, which `bun build --compile` cannot
   * bundle, so packaged builds ship it next to the binary.
   */
  playwrightCore?: string | undefined;
  /** One profile directory per workspace lives here. */
  profilesDir: string;
  /** Close a session's tabs after this long without activity or viewers. */
  idleMs: number;
  viewport: { width: number; height: number };
  /**
   * Private hosts the browser may reach anyway (PIRC_BROWSER_ALLOW_PRIVATE):
   * host names, `*.suffix`, IP addresses, CIDR ranges, or `*` for all.
   */
  allowPrivateHosts?: string[] | undefined;
  /** Host of the gateway this node connects to; always refused unless allowed above. */
  gatewayHost?: string | undefined;
  /** The gateway's other (public) host names (PIRC_BROWSER_BLOCK_HOSTS), refused likewise. */
  blockedHosts?: string[] | undefined;
  /** For tests: replace DNS resolution for the host check. */
  resolveHost?: Resolver;
  /** For tests: replace Playwright's launcher. */
  launch?: (profileDir: string, settings: BrowserSettings) => Promise<BrowserContext>;
}

export interface BrowserTarget {
  sessionId: string;
  workspaceId: string;
  /** The session's working directory; recordings go under `.pirc/recordings`. */
  root: string;
}

export interface BrowserViewState {
  active: boolean;
  url: string;
  title: string;
  mode: 'agent' | 'user';
  /** Why the agent asked the user to take over (browser_handoff). */
  handoff: string | null;
  /** An agent tool is waiting for the user to return control. */
  agentWaiting: boolean;
  /** What the agent is doing right now. */
  action: string | null;
  recording: { path: string; startedAt: number } | null;
  tabs: Array<{ index: number; url: string; title: string; active: boolean }>;
  viewport: { width: number; height: number };
}

export interface BrowserLogEntry {
  index: number;
  at: number;
  actor: 'agent' | 'user';
  action: string;
  url: string;
  image: boolean;
}

/** A frame sent to the side panel's browser socket. */
export type BrowserFrame =
  | { type: 'state'; state: BrowserViewState }
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'log'; entries: BrowserLogEntry[] }
  | { type: 'log_entry'; entry: BrowserLogEntry }
  | { type: 'log_image'; index: number; data: string | null }
  | { type: 'error'; code: string; message: string };

type Viewer = (frame: BrowserFrame) => void;

const FRAME_INTERVAL_MS = 80;
const LOG_LIMIT = 150;
const SNAPSHOT_CHARS = 30_000;
const FETCH_CHARS = 40_000;
const MAX_CHARS = 200_000;
const RECORD_FPS = 10;
const RECORD_MAX_MS = 30 * 60_000;
const AGENT_WAIT_MS = 5 * 60_000;
const TABS_PER_SESSION = 8;
const MASK = '••••••';

interface Recording {
  proc: ChildProcessWithoutNullStreams;
  file: string;
  relative: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  limit: NodeJS.Timeout;
  blocked: boolean;
  failed: string | null;
  exited: Promise<number | null>;
}

interface Tab {
  target: BrowserTarget;
  pages: Page[];
  active: Page | undefined;
  mode: 'agent' | 'user';
  handoff: string | null;
  waiting: number;
  modeWaiters: Set<(error?: Error) => void>;
  action: string | null;
  screencast: { page: Page } | null;
  /** Serializes screencast start/stop. */
  screencastChain: Promise<void>;
  lastFrame: { data: Buffer; width: number; height: number } | null;
  frameTimer: NodeJS.Timeout | null;
  lastSent: number;
  recording: Recording | null;
  log: Array<BrowserLogEntry & { jpeg: Buffer | null }>;
  logCount: number;
  lastActivity: number;
  closed: boolean;
  /** Agent operations run one at a time: they share the active page. */
  busy: Promise<void>;
}

interface WorkspaceBrowser {
  context: Promise<BrowserContext>;
  sessions: Set<string>;
}

export { findBrowserExecutable } from './browser-executable.js';

async function defaultLaunch(profileDir: string, settings: BrowserSettings) {
  const { chromium } = (
    settings.playwrightCore
      ? await import(path.join(settings.playwrightCore, 'index.js'))
      : await import('playwright-core')
  ) as typeof import('playwright-core');
  return chromium.launchPersistentContext(profileDir, {
    ...(settings.executable ? { executablePath: settings.executable } : {}),
    headless: true,
    viewport: settings.viewport,
    // The node account's own browser: keep downloads inside the profile.
    acceptDownloads: false,
    // Requests a service worker makes would bypass the host check (context.route).
    serviceWorkers: 'block',
    // Pages run untrusted code; the browser needs none of the node's secrets.
    env: withoutSecrets(process.env),
  });
}

/** Only web pages: file:// would bypass the agent's path guard. */
export function checkUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 8192)
    throw new ApiError(400, 'invalid_input', 'url must be a non-empty string');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new ApiError(400, 'invalid_input', `Not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ApiError(400, 'invalid_input', 'Only http and https URLs can be opened');
  return url.href;
}

/**
 * In-page: whether a field takes a secret (audit M9), for `el` or else the
 * focused element (through shadow roots). Password inputs, and editable fields
 * whose name, id, aria-label, autocomplete, placeholder or label mentions a
 * password, secret, one-time code or card security code: a "show password"
 * toggle turns the input into type=text but leaves those in place.
 * Self-contained, because Playwright serializes it into the page.
 */
export function sensitiveField(target?: unknown): boolean {
  let el: any = target ?? (globalThis as any).document?.activeElement;
  if (target === undefined) while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName).toUpperCase();
  const type = String(el.type ?? '').toLowerCase();
  if (tag === 'INPUT' && type === 'password') return true;
  const editable =
    (tag === 'INPUT' &&
      ![
        'checkbox',
        'radio',
        'submit',
        'button',
        'reset',
        'image',
        'file',
        'range',
        'color',
      ].includes(type)) ||
    tag === 'TEXTAREA' ||
    el.isContentEditable === true;
  if (!editable) return false;
  const pattern = /pass(word)?|secret|otp|one-time|cvc|cvv|csc/i;
  const names = ['name', 'id', 'aria-label', 'autocomplete', 'placeholder'].map(
    (name) => el.getAttribute?.(name) ?? '',
  );
  const labels = Array.from((el.labels ?? []) as ArrayLike<any>).map(
    (label: any) => label.textContent ?? '',
  );
  return [...names, ...labels].some((text) => pattern.test(String(text)));
}

/** Keys the agent may press on a secret field: they move focus or submit, never insert text. */
const SAFE_KEYS_ON_SECRET = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape']);

const passwordFieldError = () =>
  new ApiError(
    403,
    'password_field',
    'The agent does not type into password or other secret fields. Use browser_handoff so the user can enter it.',
  );

export function maskPasswords(snapshot: string, values: string[]): string {
  let out = snapshot;
  for (const value of new Set(values)) {
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`: ${escaped}$`, 'gm'), `: ${MASK}`);
    // Quoted values (for example a textbox's value in `- textbox "x": "secret"`).
    out = out.replace(new RegExp(`: "${escaped}"$`, 'gm'), `: "${MASK}"`);
  }
  return out;
}

function clip(text: string, offset: number, max: number) {
  const start = Math.max(0, Math.min(offset, text.length));
  const content = text.slice(start, start + max);
  return {
    content,
    offset: start,
    totalChars: text.length,
    truncated: start + max < text.length,
  };
}

const str = (value: unknown, name: string, max = 10_000): string => {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new ApiError(400, 'invalid_input', `${name} must be a non-empty string`);
  return value;
};
const ref = (value: unknown) => {
  const text = str(value, 'ref', 40);
  if (!/^[a-z0-9]+$/i.test(text))
    throw new ApiError(400, 'invalid_input', 'ref must come from browser_snapshot');
  return text;
};
const int = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;

export class BrowserManager {
  private readonly workspaces = new Map<string, WorkspaceBrowser>();
  private readonly tabs = new Map<string, Tab>();
  private readonly viewers = new Map<string, Set<Viewer>>();
  /** Browser requests accepted before a session is closed must drain first. */
  private readonly sessionOperations = new Map<string, number>();
  private readonly sessionOperationWaiters = new Map<string, Set<() => void>>();
  private readonly closingSessions = new Set<string>();
  private readonly sessionClosures = new Map<string, Promise<void>>();
  private readonly idleTimer: NodeJS.Timeout;
  private closing = false;
  /** Which hosts pages may reach (audit M8). */
  readonly hosts: BrowserHostGuard;

  constructor(readonly settings: BrowserSettings) {
    this.hosts = new BrowserHostGuard(
      {
        allowPrivateHosts: settings.allowPrivateHosts,
        gatewayHost: settings.gatewayHost,
        blockedHosts: settings.blockedHosts,
      },
      settings.resolveHost,
    );
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    this.idleTimer.unref();
  }

  get enabled(): boolean {
    return this.settings.enabled && Boolean(this.settings.executable);
  }

  private require(): void {
    if (!this.settings.enabled)
      throw new ApiError(403, 'forbidden', 'The browser is disabled on this node (PIRC_BROWSER)');
    if (!this.settings.executable)
      throw new ApiError(
        503,
        'runner_unavailable',
        'No Chromium found on this node; set PIRC_BROWSER_EXECUTABLE',
      );
    if (this.closing) throw new ApiError(503, 'runner_unavailable', 'The node is shutting down');
  }

  /**
   * Take a lease for the full lifetime of an accepted browser request. A
   * session close fences new requests and waits for these leases before
   * disposing its tab or workspace context.
   */
  private beginSessionOperation(sessionId: string): () => void {
    if (this.closing) throw new ApiError(503, 'runner_unavailable', 'The node is shutting down');
    if (this.closingSessions.has(sessionId))
      throw new ApiError(409, 'conflict', 'The browser session is closing');
    this.sessionOperations.set(sessionId, (this.sessionOperations.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.sessionOperations.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.sessionOperations.set(sessionId, remaining);
        return;
      }
      this.sessionOperations.delete(sessionId);
      const waiters = this.sessionOperationWaiters.get(sessionId);
      this.sessionOperationWaiters.delete(sessionId);
      for (const wake of waiters ?? []) wake();
    };
  }

  private async waitForSessionOperations(sessionId: string): Promise<void> {
    if (!this.sessionOperations.get(sessionId)) return;
    await new Promise<void>((resolve) => {
      let waiters = this.sessionOperationWaiters.get(sessionId);
      if (!waiters) this.sessionOperationWaiters.set(sessionId, (waiters = new Set()));
      waiters.add(resolve);
    });
  }

  // ---- lifecycle ------------------------------------------------------------

  private async context(workspaceId: string): Promise<BrowserContext> {
    let entry = this.workspaces.get(workspaceId);
    if (!entry) {
      const profileDir = path.join(
        this.settings.profilesDir,
        workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      );
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      const launch = this.settings.launch ?? defaultLaunch;
      const context = launch(profileDir, this.settings).then(async (context) => {
        await this.guardContext(context);
        context.on('close', () => {
          if (this.workspaces.get(workspaceId)?.context !== contextPromise) return;
          this.workspaces.delete(workspaceId);
          for (const tab of this.tabs.values())
            if (tab.target.workspaceId === workspaceId) this.dropTab(tab);
        });
        return context;
      });
      const contextPromise = context;
      entry = { context, sessions: new Set() };
      this.workspaces.set(workspaceId, entry);
      context.catch(() => {
        if (this.workspaces.get(workspaceId) === entry) this.workspaces.delete(workspaceId);
      });
    }
    try {
      return await entry.context;
    } catch (error) {
      throw new ApiError(
        503,
        'runner_unavailable',
        `Could not start the browser: ${(error as Error).message.split('\n')[0]}`,
      );
    }
  }

  /**
   * Refuse every request and WebSocket of every page to a host the guard
   * blocks: subresources, form posts, script navigations and popups. Redirect
   * hops are not routed by Playwright; `assertAllowed` catches a page that
   * ended up on a blocked host before the agent sees any of it.
   */
  private async guardContext(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const reason = await this.hosts.blockedReason(route.request().url());
      if (reason) await route.abort('blockedbyclient').catch(() => undefined);
      else await route.continue().catch(() => undefined);
    });
    await context.routeWebSocket(
      () => true,
      async (ws) => {
        const reason = await this.hosts.blockedReason(ws.url());
        if (reason)
          await ws.close({ code: 1008, reason: 'blocked by pirc' }).catch(() => undefined);
        else ws.connectToServer();
      },
    );
  }

  /**
   * Throws (after leaving the page) when any frame of `page` is on a blocked
   * host, e.g. after a redirect: the agent never reads such a page.
   */
  private async assertAllowed(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      const url = frame.url();
      const reason = await this.hosts.blockedReason(url);
      if (!reason) continue;
      await page.goto('about:blank', { timeout: 10_000 }).catch(() => undefined);
      throw blockedError(url, reason);
    }
  }

  private async tab(target: BrowserTarget, create = true): Promise<Tab | undefined> {
    const existing = this.tabs.get(target.sessionId);
    if (existing && !existing.closed) {
      if (!existing.active && create) await this.newPage(existing);
      return existing;
    }
    if (!create) return undefined;
    this.require();
    // Reserve the session before awaiting the shared launch. Closing another
    // session in this workspace must not dispose a context that this request
    // is still waiting to use.
    const contextPromise = this.context(target.workspaceId);
    const workspace = this.workspaces.get(target.workspaceId)!;
    workspace.sessions.add(target.sessionId);
    let tab: Tab | undefined;
    try {
      const context = await contextPromise;
      // closeSession fences work accepted earlier as well as later requests:
      // a pending launch must not install a tab after deletion has started.
      if (this.closing || this.closingSessions.has(target.sessionId))
        throw new ApiError(409, 'conflict', 'The browser session is closing');
      const again = this.tabs.get(target.sessionId);
      if (again && !again.closed) return again;
      tab = {
        target,
        pages: [],
        active: undefined,
        mode: 'agent',
        handoff: null,
        waiting: 0,
        modeWaiters: new Set(),
        action: null,
        screencast: null,
        screencastChain: Promise.resolve(),
        lastFrame: null,
        frameTimer: null,
        lastSent: 0,
        recording: null,
        log: [],
        logCount: 0,
        lastActivity: Date.now(),
        closed: false,
        busy: Promise.resolve(),
      };
      this.tabs.set(target.sessionId, tab);
      // A fresh persistent context opens with one blank page nobody owns.
      const owned = new Set([...this.tabs.values()].flatMap((t) => t.pages));
      const spare = context
        .pages()
        .find((page) => !owned.has(page) && page.url() === 'about:blank');
      if (spare) this.adopt(tab, spare);
      else await this.newPage(tab);
      return tab;
    } catch (error) {
      // A failed initial page creation must not leave an empty tab registered.
      if (tab && this.tabs.get(target.sessionId) === tab && !tab.pages.length) this.dropTab(tab);
      if (!this.tabs.has(target.sessionId)) {
        workspace.sessions.delete(target.sessionId);
        if (
          workspace.sessions.size === 0 &&
          this.workspaces.get(target.workspaceId) === workspace
        ) {
          this.workspaces.delete(target.workspaceId);
          await closeContext(workspace.context);
        }
      }
      throw error;
    }
  }

  private async newPage(tab: Tab): Promise<Page> {
    if (tab.pages.length >= TABS_PER_SESSION)
      throw new ApiError(409, 'conflict', `At most ${TABS_PER_SESSION} tabs per session`);
    const context = await this.context(tab.target.workspaceId);
    const page = await context.newPage();
    this.adopt(tab, page);
    return page;
  }

  private adopt(tab: Tab, page: Page): void {
    tab.pages.push(page);
    tab.active = page;
    void page.screencast?.showActions?.({ duration: 600 }).catch(() => undefined);
    page.on('popup', (popup) => {
      if (tab.closed || tab.pages.includes(popup)) return;
      if (tab.pages.length >= TABS_PER_SESSION) return void popup.close().catch(() => undefined);
      this.adopt(tab, popup);
      this.log(tab, 'agent', `Popup opened: ${popup.url()}`);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.emitState(tab);
    });
    page.on('load', () => this.emitState(tab));
    page.on('close', () => {
      tab.pages = tab.pages.filter((p) => p !== page);
      if (tab.active === page) tab.active = tab.pages.at(-1);
      this.syncScreencast(tab);
      this.emitState(tab);
    });
    this.syncScreencast(tab);
    this.emitState(tab);
  }

  private dropTab(tab: Tab): void {
    if (tab.closed) return;
    tab.closed = true;
    tab.pages = [];
    tab.active = undefined;
    if (tab.frameTimer) clearTimeout(tab.frameTimer);
    if (tab.recording) void this.stopRecording(tab).catch(() => undefined);
    tab.mode = 'agent';
    for (const wake of tab.modeWaiters) wake();
    if (this.tabs.get(tab.target.sessionId) === tab) this.tabs.delete(tab.target.sessionId);
    this.workspaces.get(tab.target.workspaceId)?.sessions.delete(tab.target.sessionId);
    this.broadcast(tab.target.sessionId, { type: 'state', state: this.view(undefined) });
  }

  async closeSession(sessionId: string): Promise<void> {
    const existing = this.sessionClosures.get(sessionId);
    if (existing) return existing;
    this.closingSessions.add(sessionId);
    // Cancel control-lease waits before draining. Waking them as successful
    // would let a queued action start after close was requested.
    const current = this.tabs.get(sessionId);
    const closingError = new ApiError(409, 'conflict', 'The browser session is closing');
    for (const cancel of current?.modeWaiters ?? []) cancel(closingError);
    const closing = (async () => {
      await this.waitForSessionOperations(sessionId);
      const tab = this.tabs.get(sessionId);
      const workspaceIds = new Set<string>();
      if (tab) workspaceIds.add(tab.target.workspaceId);
      for (const [workspaceId, workspace] of this.workspaces)
        if (workspace.sessions.has(sessionId)) workspaceIds.add(workspaceId);
      const pages = [...(tab?.pages ?? [])];
      if (tab?.recording) await this.stopRecording(tab).catch(() => undefined);
      if (tab) this.dropTab(tab);
      await Promise.allSettled(pages.map((page) => page.close()));

      // The session may have only reserved a workspace while its tab launch
      // was pending. Remove that reservation too, then close an unused context.
      for (const workspaceId of workspaceIds) {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace) continue;
        workspace.sessions.delete(sessionId);
        if (workspace.sessions.size !== 0) continue;
        if (this.workspaces.get(workspaceId) === workspace) this.workspaces.delete(workspaceId);
        await closeContext(workspace.context);
      }
    })().finally(() => {
      this.sessionClosures.delete(sessionId);
      this.closingSessions.delete(sessionId);
    });
    this.sessionClosures.set(sessionId, closing);
    return closing;
  }

  private reapIdle(): void {
    const cutoff = Date.now() - this.settings.idleMs;
    for (const tab of [...this.tabs.values()])
      if (
        tab.lastActivity < cutoff &&
        !tab.recording &&
        tab.mode === 'agent' &&
        !this.viewers.get(tab.target.sessionId)?.size
      )
        void this.closeSession(tab.target.sessionId);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.idleTimer);
    const sessionIds = new Set([
      ...this.tabs.keys(),
      ...this.sessionOperations.keys(),
      ...[...this.workspaces.values()].flatMap((workspace) => [...workspace.sessions]),
    ]);
    await Promise.allSettled([...sessionIds].map((sessionId) => this.closeSession(sessionId)));
    const contexts = [...this.workspaces.values()].map((entry) => entry.context);
    this.workspaces.clear();
    await Promise.allSettled(contexts.map(closeContext));
  }

  // ---- screencast -------------------------------------------------------------

  private syncScreencast(tab: Tab): void {
    tab.screencastChain = tab.screencastChain.then(async () => {
      const want =
        !tab.closed &&
        tab.active &&
        (Boolean(this.viewers.get(tab.target.sessionId)?.size) || Boolean(tab.recording))
          ? tab.active
          : undefined;
      if (tab.screencast?.page === want) return;
      if (tab.screencast) {
        const { page } = tab.screencast;
        tab.screencast = null;
        await page.screencast.stop().catch(() => undefined);
      }
      if (!want) return;
      tab.screencast = { page: want };
      try {
        await want.screencast.start({
          size: this.settings.viewport,
          quality: 60,
          onFrame: (frame) => {
            if (tab.screencast?.page !== want) return;
            tab.lastFrame = {
              data: frame.data,
              width: frame.viewportWidth,
              height: frame.viewportHeight,
            };
            this.scheduleFrame(tab);
          },
        });
      } catch {
        if (tab.screencast?.page === want) tab.screencast = null;
      }
    });
  }

  /** At most one frame per FRAME_INTERVAL_MS to viewers; the latest always goes out. */
  private scheduleFrame(tab: Tab): void {
    if (tab.frameTimer) return;
    const wait = Math.max(0, tab.lastSent + FRAME_INTERVAL_MS - Date.now());
    tab.frameTimer = setTimeout(() => {
      tab.frameTimer = null;
      tab.lastSent = Date.now();
      const frame = tab.lastFrame;
      if (!frame || !this.viewers.get(tab.target.sessionId)?.size) return;
      this.broadcast(tab.target.sessionId, {
        type: 'frame',
        data: frame.data.toString('base64'),
        width: frame.width,
        height: frame.height,
      });
    }, wait);
  }

  // ---- viewers -------------------------------------------------------------------

  /** Watch a session's browser. Nothing is launched until the agent or the user opens a page. */
  attach(sessionId: string, viewer: Viewer): () => void {
    let set = this.viewers.get(sessionId);
    if (!set) this.viewers.set(sessionId, (set = new Set()));
    set.add(viewer);
    const tab = this.tabs.get(sessionId);
    viewer({ type: 'state', state: this.view(tab) });
    viewer({ type: 'log', entries: (tab?.log ?? []).map(({ jpeg: _jpeg, ...entry }) => entry) });
    if (tab) {
      tab.lastActivity = Date.now();
      this.syncScreencast(tab);
      if (tab.lastFrame)
        viewer({
          type: 'frame',
          data: tab.lastFrame.data.toString('base64'),
          width: tab.lastFrame.width,
          height: tab.lastFrame.height,
        });
    }
    return () => {
      set.delete(viewer);
      if (!set.size) this.viewers.delete(sessionId);
      const current = this.tabs.get(sessionId);
      if (current) this.syncScreencast(current);
    };
  }

  private broadcast(sessionId: string, frame: BrowserFrame): void {
    for (const viewer of this.viewers.get(sessionId) ?? [])
      try {
        viewer(frame);
      } catch {
        /* a failing viewer detaches itself */
      }
  }

  private view(tab: Tab | undefined): BrowserViewState {
    const page = tab?.active;
    return {
      active: Boolean(tab && !tab.closed && page),
      url: page?.url() ?? '',
      title: '',
      mode: tab?.mode ?? 'agent',
      handoff: tab?.handoff ?? null,
      agentWaiting: Boolean(tab?.waiting),
      action: tab?.action ?? null,
      recording: tab?.recording
        ? { path: tab.recording.relative, startedAt: tab.recording.startedAt }
        : null,
      tabs: (tab?.pages ?? []).map((p, index) => ({
        index,
        url: p.url(),
        title: '',
        active: p === page,
      })),
      viewport: this.settings.viewport,
    };
  }

  private emitState(tab: Tab): void {
    if (!this.viewers.get(tab.target.sessionId)?.size) return;
    const state = this.view(tab);
    // Titles need a round trip to the page; fill them in without blocking.
    void Promise.all(tab.pages.map((page) => page.title().catch(() => ''))).then((titles) => {
      titles.forEach((title, i) => {
        if (state.tabs[i]) state.tabs[i]!.title = title;
      });
      state.title = state.tabs.find((t) => t.active)?.title ?? '';
      this.broadcast(tab.target.sessionId, { type: 'state', state });
    });
  }

  private log(tab: Tab, actor: 'agent' | 'user', action: string, jpeg: Buffer | null = null) {
    const entry = {
      index: tab.logCount++,
      at: Date.now(),
      actor,
      action: action.slice(0, 300),
      url: tab.active?.url() ?? '',
      image: Boolean(jpeg),
      jpeg,
    };
    tab.log.push(entry);
    while (tab.log.length > LOG_LIMIT) tab.log.shift();
    const { jpeg: _jpeg, ...view } = entry;
    this.broadcast(tab.target.sessionId, { type: 'log_entry', entry: view });
  }

  private async thumbnail(page: Page | undefined): Promise<Buffer | null> {
    if (!page) return null;
    return page
      .screenshot({ type: 'jpeg', quality: 45, scale: 'css', timeout: 3_000 })
      .catch(() => null);
  }

  // ---- control -------------------------------------------------------------------

  private setMode(tab: Tab, mode: 'agent' | 'user', handoff: string | null = null): void {
    tab.mode = mode;
    tab.handoff = mode === 'user' ? handoff : null;
    if (mode === 'agent') {
      for (const wake of tab.modeWaiters) wake();
      tab.modeWaiters.clear();
    }
    this.emitState(tab);
  }

  private waitForAgentMode(tab: Tab, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) return Promise.reject(new ApiError(499, 'aborted', 'Aborted'));
    if (this.closingSessions.has(tab.target.sessionId))
      return Promise.reject(new ApiError(409, 'conflict', 'The browser session is closing'));
    if (tab.mode === 'agent') return Promise.resolve();
    tab.waiting++;
    this.emitState(tab);
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        tab.modeWaiters.delete(wake);
        tab.waiting--;
        this.emitState(tab);
        if (error) reject(error);
        else resolve();
      };
      const wake = (error?: Error) => done(error);
      const onAbort = () => done(new ApiError(499, 'aborted', 'Aborted'));
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () =>
                done(
                  new ApiError(
                    409,
                    'user_in_control',
                    'The user still controls the browser. Wait, or ask them to return control.',
                  ),
                ),
              timeoutMs,
            )
          : undefined;
      tab.modeWaiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---- agent operations ---------------------------------------------------------

  /** One `browser_request` from a session's agent. */
  async handle(
    target: BrowserTarget,
    op: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.require();
    if (op === 'close') {
      await this.closeSession(target.sessionId);
      return { closed: true };
    }
    const release = this.beginSessionOperation(target.sessionId);
    try {
      const tab = (await this.tab(target, op !== 'status'))!;
      if (this.closingSessions.has(target.sessionId))
        throw new ApiError(409, 'conflict', 'The browser session is closing');
      if (op === 'status') return this.view(tab);
      tab.lastActivity = Date.now();
      switch (op) {
        case 'handoff': {
          const reason = str(args.reason, 'reason', 2_000);
          this.setMode(tab, 'user', reason);
          this.log(tab, 'agent', `Handed control to the user: ${reason}`);
          return this.view(tab);
        }
        case 'wait_control':
          await this.waitForAgentMode(tab, signal, 0);
          return await this.pageSummary(tab, true);
        case 'release':
          if (tab.mode === 'user') {
            this.setMode(tab, 'agent');
            this.log(tab, 'agent', 'Took back control');
          }
          return this.view(tab);
        case 'record':
          return await this.record(tab, args);
      }
      const previous = tab.busy;
      let unlock!: () => void;
      tab.busy = new Promise<void>((resolve) => (unlock = resolve));
      try {
        await previous;
        if (this.closingSessions.has(target.sessionId))
          throw new ApiError(409, 'conflict', 'The browser session is closing');
        signal.throwIfAborted();
        await this.waitForAgentMode(tab, signal, int(args.waitMs, AGENT_WAIT_MS, 0, 30 * 60_000));
        return await this.run(tab, op, args);
      } finally {
        unlock();
      }
    } finally {
      release();
    }
  }

  private async run(tab: Tab, op: string, args: Record<string, unknown>): Promise<unknown> {
    if (!tab.active) await this.newPage(tab);
    const label = describe(op, args);
    tab.action = label;
    this.emitState(tab);
    try {
      const result = await this.operate(tab, op, args);
      this.log(tab, 'agent', label, await this.thumbnail(tab.active));
      return result;
    } catch (error) {
      this.log(tab, 'agent', `${label} (failed)`);
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'browser_error', cleanError(error));
    } finally {
      tab.action = null;
      tab.lastActivity = Date.now();
      this.emitState(tab);
    }
  }

  private async operate(tab: Tab, op: string, args: Record<string, unknown>): Promise<unknown> {
    const page = tab.active!;
    switch (op) {
      case 'fetch': {
        const response = await this.goto(page, checkUrl(args.url));
        const format = args.format === 'text' || args.format === 'html' ? args.format : 'markdown';
        const raw =
          format === 'html'
            ? await page.content()
            : format === 'text'
              ? await page.evaluate(() => (globalThis as any).document.body?.innerText ?? '')
              : await page.evaluate(pageMarkdown);
        return {
          url: page.url(),
          title: await page.title(),
          status: response?.status() ?? null,
          format,
          ...clip(
            raw,
            int(args.offset, 0, 0, 1e9),
            int(args.maxChars, FETCH_CHARS, 1_000, MAX_CHARS),
          ),
        };
      }
      case 'navigate': {
        if (args.url === 'back') {
          await page.goBack({ timeout: 15_000, waitUntil: 'domcontentloaded' });
          await settle(page);
          return this.pageSummary(tab, true);
        }
        const response = await this.goto(page, checkUrl(args.url));
        return { status: response?.status() ?? null, ...(await this.pageSummary(tab, true)) };
      }
      case 'back':
        await page.goBack({ timeout: 15_000, waitUntil: 'domcontentloaded' });
        return this.pageSummary(tab, true);
      case 'snapshot':
        return this.pageSummary(tab, true, args);
      case 'click': {
        const locator = page.locator(`aria-ref=${ref(args.ref)}`);
        await locator.click({
          timeout: 10_000,
          button: args.button === 'right' || args.button === 'middle' ? args.button : 'left',
          clickCount: args.double === true ? 2 : 1,
        });
        await settle(page);
        return this.pageSummary(tab, args.snapshot !== false);
      }
      case 'hover':
        await page.locator(`aria-ref=${ref(args.ref)}`).hover({ timeout: 10_000 });
        return this.pageSummary(tab, args.snapshot !== false);
      case 'type': {
        const locator = page.locator(`aria-ref=${ref(args.ref)}`);
        const text = typeof args.text === 'string' ? args.text : '';
        if (text.length > 20_000) throw new ApiError(400, 'invalid_input', 'text is too long');
        if (await locator.evaluate(sensitiveField, undefined, { timeout: 10_000 }))
          throw passwordFieldError();
        if (args.slowly === true) {
          if (args.clear !== false) await locator.fill('', { timeout: 10_000 });
          await locator.pressSequentially(text, { timeout: 30_000, delay: 20 });
        } else await locator.fill(text, { timeout: 10_000 });
        if (args.submit === true) await locator.press('Enter', { timeout: 10_000 });
        await settle(page);
        return this.pageSummary(tab, args.snapshot !== false);
      }
      case 'select': {
        const values = Array.isArray(args.values)
          ? args.values.filter((v): v is string => typeof v === 'string').slice(0, 50)
          : [];
        if (!values.length) throw new ApiError(400, 'invalid_input', 'values must list options');
        await page.locator(`aria-ref=${ref(args.ref)}`).selectOption(values, { timeout: 10_000 });
        await settle(page);
        return this.pageSummary(tab, args.snapshot !== false);
      }
      case 'press': {
        const key = str(args.key, 'key', 100);
        // After a click into a password field, keys would type the secret one by one.
        if (!SAFE_KEYS_ON_SECRET.has(key))
          for (const frame of page.frames())
            if (await frame.evaluate(sensitiveField).catch(() => false)) throw passwordFieldError();
        await page.keyboard.press(key);
        await settle(page);
        return this.pageSummary(tab, args.snapshot !== false);
      }
      case 'wait_for': {
        const timeout = int(args.timeoutMs, 10_000, 0, 60_000);
        if (typeof args.text === 'string' && args.text)
          await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
        else if (typeof args.textGone === 'string' && args.textGone)
          await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
        else await page.waitForTimeout(Math.min(timeout, 30_000));
        return this.pageSummary(tab, args.snapshot !== false);
      }
      case 'screenshot': {
        await this.assertAllowed(page);
        const jpeg = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          scale: 'css',
          fullPage: args.fullPage === true,
          timeout: 15_000,
        });
        return {
          url: page.url(),
          title: await page.title(),
          image: jpeg.toString('base64'),
          mimeType: 'image/jpeg',
        };
      }
      case 'tabs': {
        const action = args.action ?? 'list';
        if (action === 'new') {
          const created = await this.newPage(tab);
          if (typeof args.url === 'string' && args.url)
            await this.goto(created, checkUrl(args.url));
        } else if (action === 'select' || action === 'close') {
          const index = int(args.index, -1, -1, TABS_PER_SESSION);
          const chosen = tab.pages[index];
          if (!chosen) throw new ApiError(404, 'not_found', `No tab ${String(args.index)}`);
          if (action === 'select') {
            tab.active = chosen;
            await chosen.bringToFront().catch(() => undefined);
            this.syncScreencast(tab);
          } else await chosen.close();
        } else if (action !== 'list')
          throw new ApiError(400, 'invalid_input', 'action is list, new, select or close');
        this.emitState(tab);
        return { tabs: await this.tabList(tab) };
      }
      default:
        throw new ApiError(400, 'invalid_input', `Unknown browser operation ${op}`);
    }
  }

  private async goto(page: Page, url: string) {
    await this.hosts.check(url);
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      if (/ERR_BLOCKED_BY_CLIENT/.test(String((error as Error)?.message)))
        throw blockedError(url, 'it (or a page it loads) is on a blocked host');
      throw error;
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    await this.assertAllowed(page);
    return response;
  }

  private async tabList(tab: Tab) {
    return Promise.all(
      tab.pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: page === tab.active,
      })),
    );
  }

  /** URL, title and (optionally) an AI snapshot of the active page, with passwords masked. */
  private async pageSummary(tab: Tab, withSnapshot: boolean, args: Record<string, unknown> = {}) {
    const page = tab.active;
    if (!page) return { url: '', title: '', tabs: [] };
    await this.assertAllowed(page);
    const summary: Record<string, unknown> = {
      url: page.url(),
      title: await page.title().catch(() => ''),
      ...(tab.pages.length > 1 ? { tabs: await this.tabList(tab) } : {}),
    };
    if (!withSnapshot) return summary;
    const [snapshot, passwords] = await Promise.all([
      page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }),
      Promise.all(
        page.frames().map((frame) => frame.evaluate(passwordValues).catch(() => [] as string[])),
      ),
    ]);
    const masked = maskPasswords(snapshot, passwords.flat());
    Object.assign(
      summary,
      (({ content, ...rest }) => ({ snapshot: content, ...rest }))(
        clip(
          masked,
          int(args.offset, 0, 0, 1e9),
          int(args.maxChars, SNAPSHOT_CHARS, 1_000, MAX_CHARS),
        ),
      ),
    );
    return summary;
  }

  // ---- recording -----------------------------------------------------------------

  private async record(tab: Tab, args: Record<string, unknown>) {
    const action = args.action;
    if (action === 'start') {
      if (tab.recording) throw new ApiError(409, 'conflict', 'Already recording');
      await this.startRecording(tab, typeof args.name === 'string' ? args.name : '');
      this.log(tab, 'agent', 'Started recording');
      return { recording: true, path: tab.recording!.relative };
    }
    if (action === 'stop') {
      if (!tab.recording) throw new ApiError(409, 'conflict', 'Not recording');
      const result = await this.stopRecording(tab);
      this.log(tab, 'agent', `Saved recording ${result.path}`);
      return result;
    }
    throw new ApiError(400, 'invalid_input', 'action is start or stop');
  }

  private async startRecording(tab: Tab, name: string): Promise<void> {
    if (!tab.active) await this.newPage(tab);
    const dir = path.join(tab.target.root, '.pirc', 'recordings');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'recording';
    const file = path.join(dir, `${safe}-${stamp}.webm`);
    const proc = spawn(
      this.settings.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        String(RECORD_FPS),
        '-c:v',
        'mjpeg',
        '-i',
        '-',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-b:v',
        '0',
        '-crf',
        '38',
        '-pix_fmt',
        'yuv420p',
        '-y',
        file,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: withoutSecrets(process.env) },
    );
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    proc.stdout.resume();
    proc.stdin.on('error', () => undefined);
    const exited = new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
      proc.once('error', (error) => {
        recording.failed =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `ffmpeg not found (${this.settings.ffmpeg}); set PIRC_FFMPEG`
            : error.message;
        resolve(null);
      });
    });
    const recording: Recording = {
      proc,
      file,
      relative: path.relative(tab.target.root, file).split(path.sep).join('/'),
      startedAt: Date.now(),
      blocked: false,
      failed: null,
      exited,
      // Screencast frames only arrive when the page changes: repeat the latest
      // at a fixed rate so the video plays in real time.
      timer: setInterval(() => {
        const frame = tab.lastFrame?.data;
        if (!frame || recording.blocked || recording.failed) return;
        if (!proc.stdin.write(frame)) {
          recording.blocked = true;
          proc.stdin.once('drain', () => (recording.blocked = false));
        }
      }, 1000 / RECORD_FPS),
      limit: setTimeout(() => {
        if (tab.recording === recording) void this.stopRecording(tab).catch(() => undefined);
      }, RECORD_MAX_MS),
    };
    void exited.then(() => {
      if (!recording.failed && stderr && tab.recording === recording) recording.failed = stderr;
    });
    tab.recording = recording;
    // Seed a frame so the video starts with the current page.
    if (!tab.lastFrame && tab.active) {
      const seed = await tab.active
        .screenshot({ type: 'jpeg', quality: 60, scale: 'css', timeout: 5_000 })
        .catch(() => null);
      if (seed && !tab.lastFrame) tab.lastFrame = { data: seed, ...this.settings.viewport };
    }
    this.syncScreencast(tab);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (recording.failed) {
      tab.recording = null;
      clearInterval(recording.timer);
      clearTimeout(recording.limit);
      this.syncScreencast(tab);
      throw new ApiError(503, 'runner_unavailable', recording.failed);
    }
    this.emitState(tab);
  }

  private async stopRecording(tab: Tab) {
    const recording = tab.recording!;
    tab.recording = null;
    clearInterval(recording.timer);
    clearTimeout(recording.limit);
    recording.proc.stdin.end();
    const code = await Promise.race([
      recording.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);
    if (code === 'timeout') recording.proc.kill('SIGKILL');
    this.syncScreencast(tab);
    this.emitState(tab);
    if (code !== 0 || recording.failed)
      throw new ApiError(
        500,
        'browser_error',
        `Recording failed: ${recording.failed ?? `ffmpeg exited with ${String(code)}`}`,
      );
    return {
      recording: false,
      path: recording.relative,
      bytes: statSync(recording.file).size,
      durationMs: Date.now() - recording.startedAt,
    };
  }

  // ---- user input (side panel) ---------------------------------------------------

  /**
   * A message from a viewer. The caller has checked the control lease (all
   * of these act on the browser); input events need user mode first.
   */
  async input(
    target: BrowserTarget,
    message: Record<string, unknown>,
  ): Promise<BrowserFrame | void> {
    const type = message.type;
    if (type === 'log_image') {
      const tab = this.tabs.get(target.sessionId);
      const index = int(message.index, -1, -1, Number.MAX_SAFE_INTEGER);
      const entry = tab?.log.find((e) => e.index === index);
      return { type: 'log_image', index, data: entry?.jpeg?.toString('base64') ?? null };
    }
    const release = this.beginSessionOperation(target.sessionId);
    try {
      return await this.handleInput(target, message);
    } finally {
      release();
    }
  }

  private async handleInput(
    target: BrowserTarget,
    message: Record<string, unknown>,
  ): Promise<BrowserFrame | void> {
    const type = message.type;
    const creates = type === 'takeover' || type === 'navigate';
    const tab = await this.tab(target, creates);
    if (this.closingSessions.has(target.sessionId))
      throw new ApiError(409, 'conflict', 'The browser session is closing');
    if (!tab)
      return { type: 'error', code: 'not_found', message: 'No browser is open for this session' };
    tab.lastActivity = Date.now();
    switch (type) {
      case 'takeover':
        if (tab.mode !== 'user') {
          this.setMode(tab, 'user', null);
          this.log(tab, 'user', 'User took control');
        }
        return;
      case 'release':
        if (tab.mode === 'user') {
          this.setMode(tab, 'agent');
          this.log(tab, 'user', 'User returned control', await this.thumbnail(tab.active));
        }
        return;
      case 'record':
        if (message.action === 'start' && !tab.recording) {
          await this.startRecording(tab, 'recording');
          this.log(tab, 'user', 'Started recording');
        } else if (message.action === 'stop' && tab.recording) {
          const result = await this.stopRecording(tab);
          this.log(tab, 'user', `Saved recording ${result.path}`);
        }
        return;
    }
    if (tab.mode !== 'user')
      return { type: 'error', code: 'agent_in_control', message: 'Take over the browser first' };
    if (!tab.active) await this.newPage(tab);
    const page = tab.active!;
    const num = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    switch (type) {
      case 'navigate': {
        const url = checkUrl(message.url);
        this.log(tab, 'user', `Navigate to ${url}`);
        await this.goto(page, url);
        return;
      }
      case 'back':
        await page.goBack({ timeout: 15_000 }).catch(() => undefined);
        return;
      case 'forward':
        await page.goForward({ timeout: 15_000 }).catch(() => undefined);
        return;
      case 'reload':
        await page.reload({ timeout: 30_000 }).catch(() => undefined);
        return;
      case 'tab':
        if (tab.pages[num(message.index)]) {
          tab.active = tab.pages[num(message.index)];
          this.syncScreencast(tab);
          this.emitState(tab);
        }
        return;
      case 'mouse': {
        const x = num(message.x);
        const y = num(message.y);
        const button =
          message.button === 'right' || message.button === 'middle' ? message.button : 'left';
        if (message.action === 'move') await page.mouse.move(x, y);
        else if (message.action === 'down') {
          await page.mouse.move(x, y);
          await page.mouse.down({ button, clickCount: Math.max(1, num(message.clickCount)) });
        } else if (message.action === 'up')
          await page.mouse.up({ button, clickCount: Math.max(1, num(message.clickCount)) });
        return;
      }
      case 'wheel':
        await page.mouse.move(num(message.x), num(message.y));
        await page.mouse.wheel(num(message.dx), num(message.dy));
        return;
      case 'key': {
        const key = typeof message.key === 'string' ? message.key.slice(0, 60) : '';
        if (key) await page.keyboard.press(key).catch(() => undefined);
        return;
      }
      case 'text': {
        const text = typeof message.text === 'string' ? message.text.slice(0, 10_000) : '';
        if (text) await page.keyboard.insertText(text);
        return;
      }
      default:
        return { type: 'error', code: 'invalid_input', message: `Unknown message ${String(type)}` };
    }
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function closeContext(context: Promise<BrowserContext>): Promise<void> {
  try {
    const resolved = await context;
    await Promise.race([resolved.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  } catch {
    /* never started, or already gone */
  }
}

function describe(op: string, args: Record<string, unknown>): string {
  const target = typeof args.ref === 'string' ? ` ${args.ref}` : '';
  switch (op) {
    case 'fetch':
      return `Fetch ${String(args.url ?? '')}`;
    case 'navigate':
      return `Navigate to ${String(args.url ?? '')}`;
    case 'type':
      return `Type into${target}`;
    case 'press':
      return `Press ${String(args.key ?? '')}`;
    case 'wait_for':
      return 'Wait';
    default:
      return `${op[0]!.toUpperCase()}${op.slice(1).replace('_', ' ')}${target}`;
  }
}

function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Playwright appends a long call log; the first lines say what went wrong.
  return text.split('\nCall log:')[0]!.split('\n').slice(0, 4).join('\n').slice(0, 1_000);
}
