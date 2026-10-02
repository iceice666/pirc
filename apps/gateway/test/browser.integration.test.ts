/**
 * The browser tools through a real node, agent subprocess and Chromium:
 * web_fetch, the live-view stream, and a handoff the user ends from the
 * Browser panel. Skipped without a Chromium (PIRC_BROWSER_EXECUTABLE).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { buildNodeApp } from '../src/node/app.js';
import { defaultAgentCommand } from '../src/config.js';
import { findBrowserExecutable, type BrowserFrame } from '../src/node/browser.js';
import { testModels, writeAgentConfig } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { nodeHeaders as headers, testConfig, waitFor } from './helpers.js';

const executable = findBrowserExecutable(process.env.PIRC_BROWSER_EXECUTABLE);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(browserEnabled = true) {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const site = Bun.serve({
    port: 0,
    fetch: (request) =>
      new Response(
        new URL(request.url).pathname === '/login'
          ? '<!doctype html><title>Login</title><input type=password aria-label=Password>'
          : '<!doctype html><title>Docs</title><main><h1>Install</h1><p>Run <code>pirc node</code>.</p></main>',
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  cleanup.push(() => site.stop(true));
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-browser-config-'));
  writeAgentConfig(configDir);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const base = testConfig(defaultAgentCommand({}));
  const config = {
    ...base,
    browser: {
      ...base.browser,
      enabled: browserEnabled,
      executable,
      viewport: { width: 800, height: 600 },
      // The test page is on loopback, which agents' browsers refuse by default.
      allowPrivateHosts: ['127.0.0.1'],
    },
  };
  const { app, services } = await buildNodeApp(config);
  services.models.set(testModels(llm.url));
  cleanup.push(() => app.close() as Promise<void>);
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    payload: { workspaceId: 'test' },
  });
  const sessionId = created.json().session.id as string;
  const lease = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/control/acquire`,
    headers,
    payload: { clientId: 'browser-1' },
  });
  const generation = lease.json().lease.generation as number;
  const prompt = (message: string, commandId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId,
        clientId: 'browser-1',
        generation,
        payload: { type: 'prompt', message },
      },
    });
  const snapshot = async () =>
    (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    ).json();
  return {
    llm,
    app,
    services,
    sessionId,
    generation,
    prompt,
    snapshot,
    url: `http://127.0.0.1:${site.port}`,
  };
}

it.skipIf(!executable)(
  'fetches a page, streams it to the panel, and resumes after the user returns control',
  async () => {
    const { llm, services, sessionId, generation, prompt, snapshot, url } = await setup();
    const frames: BrowserFrame[] = [];
    const stream = services.browserStreams.open(
      { user: headers['x-pirc-user'], sessionId },
      (frame) => frames.push(frame),
    );
    cleanup.push(() => stream.detach());
    expect(frames[0]).toMatchObject({ type: 'state', state: { active: false } });

    llm.push(
      { tool: { id: 'c1', name: 'web_fetch', args: { url: `${url}/` } } },
      { tool: { id: 'c2', name: 'browser_handoff', args: { reason: '請登入' } } },
      { text: 'Done.' },
    );
    expect((await prompt('read the docs', 'cmd-1')).statusCode).toBe(202);

    // The handoff shows up as a dialog and as user mode in the panel.
    await waitFor(async () => (await snapshot()).interactions.length, 1, 20_000);
    await waitFor(
      () =>
        frames.some(
          (f) => f.type === 'state' && f.state.mode === 'user' && f.state.handoff === '請登入',
        ),
      true,
    );
    // Without the control lease, the panel cannot act.
    stream.input({ type: 'release', clientId: 'someone-else', generation });
    await waitFor(() => frames.some((f) => f.type === 'error' && f.code === 'lost_control'), true);
    // The user navigates while in control, then returns it from the panel.
    stream.input({ type: 'navigate', url: `${url}/login`, clientId: 'browser-1', generation });
    await waitFor(
      () => frames.some((f) => f.type === 'state' && f.state.url.endsWith('/login')),
      true,
      10_000,
    );
    stream.input({ type: 'release', clientId: 'browser-1', generation });

    await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 20_000);
    const history = (await snapshot()).history;
    const results = history.filter((m: any) => m.role === 'toolResult');
    expect(results[0].content[0].text).toContain('# Install');
    expect(results[0].content[0].text).toContain('`pirc node`');
    expect(results[1].content[0].text).toContain('The user returned control');
    expect(results[1].content[0].text).toContain('/login');
    // The dialog was withdrawn when the panel ended the handoff.
    expect((await snapshot()).interactions).toEqual([]);
    expect(frames.some((f) => f.type === 'frame')).toBe(true);
    // The tools and their prompt reached the model.
    const request = llm.requests[0]!.body;
    expect(JSON.stringify(request)).toContain('browser_snapshot');
    expect(JSON.stringify(request)).toContain('## Browser');
  },
  60_000,
);

it('offers no browser tools when the node has no browser', async () => {
  const { llm, prompt, snapshot } = await setup(false);
  llm.push({ text: 'ok' });
  await prompt('hi', 'cmd-1');
  await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 10_000);
  const request = JSON.stringify(llm.requests[0]!.body);
  expect(request).not.toContain('web_fetch');
  expect(request).not.toContain('## Browser');
}, 30_000);
