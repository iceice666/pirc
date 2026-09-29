/**
 * BrowserManager against a real Chromium (skipped when none is installed;
 * set PIRC_BROWSER_EXECUTABLE to point at one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BrowserManager,
  checkUrl,
  findBrowserExecutable,
  maskPasswords,
  type BrowserFrame,
  type BrowserTarget,
} from '../src/node/browser.js';
import { waitFor } from './helpers.js';

describe('browser helpers', () => {
  it('only opens http(s) URLs and adds a scheme to bare hosts', () => {
    expect(checkUrl('example.com/a')).toBe('https://example.com/a');
    expect(checkUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/');
    expect(() => checkUrl('file:///etc/passwd')).toThrow('Only http and https');
    expect(() => checkUrl('javascript:alert(1)')).toThrow('Only http and https');
    expect(() => checkUrl('')).toThrow();
  });

  it('masks password values in snapshots', () => {
    const snapshot = '- textbox "User" [ref=e3]: alice\n- textbox "Pass" [ref=e4]: s3cr.t\n';
    expect(maskPasswords(snapshot, ['s3cr.t'])).toBe(
      '- textbox "User" [ref=e3]: alice\n- textbox "Pass" [ref=e4]: ••••••\n',
    );
    // A short password does not blank unrelated text.
    expect(maskPasswords('- text: a b a', ['a'])).toBe('- text: a b a');
  });

  it('finds a browser on PATH before the macOS app bundles', () => {
    expect(findBrowserExecutable('/x/chrome')).toBe('/x/chrome');
    expect(
      findBrowserExecutable(undefined, (name) => (name === 'chromium' ? '/bin/c' : null)),
    ).toBe('/bin/c');
  });
});

const executable = findBrowserExecutable(process.env.PIRC_BROWSER_EXECUTABLE);
const ffmpeg = Bun.which('ffmpeg');

describe.skipIf(!executable)('BrowserManager (real Chromium)', () => {
  let server: ReturnType<typeof Bun.serve>;
  let manager: BrowserManager;
  let base: string;
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-browser-root-'));
  const target: BrowserTarget = { sessionId: 's1', workspaceId: 'w1', root };
  const signal = new AbortController().signal;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const html =
          url.pathname === '/login'
            ? `<!doctype html><title>Login</title><form><label>User <input name=u></label><label>Password <input type=password name=p value="hunter2"></label></form>`
            : url.pathname === '/done'
              ? `<!doctype html><title>Done</title><h1>Thanks ${url.searchParams.get('q') ?? ''}</h1>`
              : `<!doctype html><title>Home</title><main><h1>Hello</h1><p>Some <b>bold</b> text and a <a href="/done?q=link">link</a>.</p>
<ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
<form action="/done"><input name=q aria-label=Query><select name=s aria-label=Size><option>S</option><option>M</option></select><button>Go</button></form>
<script>document.querySelector('h1').insertAdjacentHTML('afterend','<p id=js>Rendered by JS</p>')</script></main>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    manager = new BrowserManager({
      enabled: true,
      executable,
      ffmpeg: ffmpeg ?? 'ffmpeg',
      profilesDir: mkdtempSync(path.join(tmpdir(), 'pirc-browser-profiles-')),
      idleMs: 60_000,
      viewport: { width: 800, height: 600 },
    });
  });
  afterAll(async () => {
    await manager.shutdown();
    server.stop(true);
  });

  it('fetches a JS-rendered page as markdown', async () => {
    const result = (await manager.handle(target, 'fetch', { url: `${base}/` }, signal)) as any;
    expect(result.title).toBe('Home');
    expect(result.status).toBe(200);
    expect(result.content).toContain('# Hello');
    expect(result.content).toContain('Rendered by JS');
    expect(result.content).toContain('**bold**');
    expect(result.content).toContain(`[link](${base}/done?q=link)`);
    expect(result.content).toContain('- one');
    expect(result.content).toContain('| a | b |');
    const clipped = (await manager.handle(
      target,
      'fetch',
      { url: `${base}/`, maxChars: 1000, offset: 5, format: 'text' },
      signal,
    )) as any;
    expect(clipped.offset).toBe(5);
    expect(clipped.format).toBe('text');
  }, 30_000);

  it('drives a form through snapshot refs', async () => {
    const snap = (await manager.handle(target, 'snapshot', {}, signal)) as any;
    const query = /textbox "Query" \[ref=(\w+)\]/.exec(snap.snapshot)?.[1];
    const size = /combobox "Size" \[ref=(\w+)\]/.exec(snap.snapshot)?.[1];
    expect(query).toBeTruthy();
    await manager.handle(target, 'select', { ref: size, values: ['M'], snapshot: false }, signal);
    const after = (await manager.handle(
      target,
      'type',
      { ref: query, text: '你好', submit: true },
      signal,
    )) as any;
    expect(after.url).toContain('/done?q=%E4%BD%A0%E5%A5%BD&s=M');
    expect(after.snapshot).toContain('Thanks 你好');
    const shot = (await manager.handle(target, 'screenshot', {}, signal)) as any;
    expect(shot.mimeType).toBe('image/jpeg');
    expect(Buffer.from(shot.image, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30_000);

  it('masks passwords and refuses to type them', async () => {
    const result = (await manager.handle(
      target,
      'navigate',
      { url: `${base}/login` },
      signal,
    )) as any;
    expect(result.snapshot).not.toContain('hunter2');
    expect(result.snapshot).toContain('••••••');
    const pass = /textbox "Password" \[ref=(\w+)\]/.exec(result.snapshot)?.[1];
    await expect(
      manager.handle(target, 'type', { ref: pass, text: 'x' }, signal),
    ).rejects.toMatchObject({ code: 'password_field' });
  }, 30_000);

  it('streams frames to viewers, and makes the agent wait while the user has control', async () => {
    const frames: BrowserFrame[] = [];
    const detach = manager.attach('s1', (frame) => frames.push(frame));
    expect(frames[0]).toMatchObject({ type: 'state', state: { active: true } });
    expect(frames.some((f) => f.type === 'log')).toBe(true);

    // Agent actions still refused user-only input.
    expect(await manager.input(target, { type: 'text', text: 'x' })).toMatchObject({
      code: 'agent_in_control',
    });
    await manager.input(target, { type: 'takeover' });
    await manager.input(target, { type: 'navigate', url: `${base}/` });
    // The user types into the query box by clicking its coordinates.
    const pending = manager.handle(target, 'snapshot', {}, signal);
    await waitFor(
      () =>
        frames.some((f) => f.type === 'state' && f.state.mode === 'user' && f.state.agentWaiting),
      true,
    );
    await manager.input(target, { type: 'release' });
    const snap = (await pending) as any;
    expect(snap.title).toBe('Home');
    await waitFor(() => frames.some((f) => f.type === 'frame' && f.width === 800), true);
    const entry = frames.findLast((f) => f.type === 'log_entry' && f.entry.image);
    expect(entry).toBeTruthy();
    const image = await manager.input(target, {
      type: 'log_image',
      index: (entry as any).entry.index,
    });
    expect((image as any).data).toBeTruthy();
    detach();
  }, 30_000);

  it('hands off to the user and resumes when control returns', async () => {
    await manager.handle(target, 'handoff', { reason: 'Please log in' }, signal);
    const waiting = manager.handle(target, 'wait_control', {}, signal);
    let done = false;
    void waiting.then(() => (done = true));
    await Bun.sleep(100);
    expect(done).toBe(false);
    const status = (await manager.handle(target, 'status', {}, signal)) as any;
    expect(status).toMatchObject({ mode: 'user', handoff: 'Please log in' });
    await manager.input(target, { type: 'release' });
    await waiting;
    expect(done).toBe(true);
    // Timeouts give the agent a clear error.
    await manager.input(target, { type: 'takeover' });
    await expect(manager.handle(target, 'snapshot', { waitMs: 50 }, signal)).rejects.toMatchObject({
      code: 'user_in_control',
    });
    await manager.input(target, { type: 'release' });
  }, 30_000);

  it.skipIf(!ffmpeg)(
    'records a paced webm into .pirc/recordings',
    async () => {
      const started = (await manager.handle(
        target,
        'record',
        { action: 'start', name: 'demo' },
        signal,
      )) as any;
      expect(started.path).toMatch(/^\.pirc\/recordings\/demo-.*\.webm$/);
      await manager.handle(target, 'navigate', { url: `${base}/done?q=rec` }, signal);
      await Bun.sleep(1200);
      const stopped = (await manager.handle(target, 'record', { action: 'stop' }, signal)) as any;
      expect(stopped.bytes).toBeGreaterThan(500);
      expect(stopped.durationMs).toBeGreaterThan(1000);
      expect(existsSync(path.join(root, stopped.path))).toBe(true);
      const probe = Bun.spawnSync([
        'ffprobe',
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        path.join(root, stopped.path),
      ]);
      if (probe.exitCode === 0)
        // Paced at a fixed rate: about as long as the wall-clock recording.
        expect(Number(probe.stdout.toString())).toBeGreaterThan(0.8);
    },
    30_000,
  );

  it('shares one profile per workspace and closes cleanly', async () => {
    const other: BrowserTarget = { sessionId: 's2', workspaceId: 'w1', root };
    const result = (await manager.handle(
      other,
      'navigate',
      { url: `${base}/done?q=2` },
      signal,
    )) as any;
    expect(result.title).toBe('Done');
    // Session 1's page is untouched.
    expect(((await manager.handle(target, 'status', {}, signal)) as any).url).not.toContain('q=2');
    await manager.handle(other, 'close', {}, signal);
    expect(((await manager.handle(other, 'status', {}, signal)) as any).active).toBe(false);
  }, 30_000);
});
