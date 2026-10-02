/**
 * The node's agent sandbox (node/sandbox.ts, node/runner.ts): how agents are
 * started under srt, the warning when they cannot be, and the approvals the
 * node asks for itself. A fake srt (fixtures/fake-srt.sh) runs everything
 * here; the real one is exercised by sandbox-srt.integration.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import type { NodeConfig } from '../src/config.js';
import { buildNodeApp } from '../src/node/app.js';
import { nodeHeaders as headers, testConfig, waitFor } from './helpers.js';

const fakeSrt = path.resolve('test/fixtures/fake-srt.sh');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setEnv(name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  cleanup.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function session(overrides: Partial<NodeConfig>, agentConfig: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-sbx-config-'));
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(agentConfig));
  setEnv('PIRC_CONFIG_DIR', configDir);
  const config = testConfig(overrides);
  // fixtures/fake-srt.sh writes it next to the settings.
  const log = path.join(config.stateDir, 'sandbox', 'fake-srt.log');
  const { app, services } = await buildNodeApp(config);
  cleanup.push(() => app.close() as Promise<void>);
  const sessionId = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: 'test' },
    })
  ).json().session.id as string;
  const events: Array<{ type: string; payload: any }> = [];
  cleanup.push(
    services.events.subscribe(sessionId, (event: any) =>
      events.push({ type: event.type, payload: event.payload ?? event.data ?? event }),
    ),
  );
  const generation = (
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/control/acquire`,
      headers,
      payload: { clientId: 'browser-1' },
    })
  ).json().lease.generation as number;
  let commands = 0;
  const prompt = (message: string) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: `c${++commands}`,
        clientId: 'browser-1',
        generation,
        payload: { type: 'prompt', message },
      },
    });
  const snapshot = async () =>
    (
      await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
    ).json();
  const lastText = async () => (await snapshot()).history.at(-1)?.content?.[0]?.text as string;
  const answer = async (confirmed: boolean) => {
    await waitFor(async () => (await snapshot()).interactions.length, 1);
    const pending = (await snapshot()).interactions[0];
    const answered = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/interactions/${pending.id}/answer`,
      headers,
      payload: { clientId: 'browser-1', generation, answer: { confirmed } },
    });
    expect(answered.statusCode).toBe(200);
    return pending;
  };
  /** Prompt and wait for the agent's next answer, which starts with `prefix`. */
  const reply = async (message: string, prefix: string) => {
    const before = (await snapshot()).history.length;
    await prompt(message);
    await waitFor(
      async () => {
        const history = (await snapshot()).history;
        return history.length > before && (await lastText())?.startsWith(prefix) === true;
      },
      true,
      10_000,
    );
    return lastText();
  };
  return { config, log, events, prompt, snapshot, lastText, answer, reply };
}

it('starts no agent when the sandbox is unavailable', async () => {
  const s = await session({ sandbox: { srt: path.join(tmpdir(), 'pirc-no-such-srt') } });
  const response = await s.prompt('env PIRC_SANDBOX');
  expect(response.statusCode).toBe(503);
  expect(response.json().error.message).toContain('must run in the sandbox');
  expect(s.events.some((event) => event.type === 'runner_ready')).toBe(false);
  expect((await s.snapshot()).sandbox).toBeNull();
});

it('ignores the removed sandbox.enabled switch, with a warning', async () => {
  const s = await session({ sandbox: { srt: fakeSrt } }, { sandbox: { enabled: false } });
  expect(await s.reply('env PIRC_SANDBOX', 'env:')).toBe('env:PIRC_SANDBOX=srt');
  const warning = s.events.find(
    (event) => event.type === 'notification' && /sandbox\.enabled/.test(event.payload.message),
  );
  expect(warning?.payload.notifyType).toBe('warning');
  expect((await s.snapshot()).sandbox).toEqual({ active: true });
});

it('starts agents under srt with a per-session policy', async () => {
  const s = await session(
    { sandbox: { srt: fakeSrt } },
    { sandbox: { network: { allowedDomains: ['api.internal.test'] } } },
  );
  expect(await s.reply('env PIRC_SANDBOX', 'env:')).toBe('env:PIRC_SANDBOX=srt');
  expect((await s.snapshot()).sandbox).toEqual({ active: true });
  const settings = readFileSync(s.log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('settings '))
    .map((line) => JSON.parse(line.slice('settings '.length)))
    .find((item) => item.filesystem.allowWrite.length);
  expect(settings.network.allowedDomains).toEqual(
    expect.arrayContaining(['github.com', 'registry.npmjs.org', 'api.internal.test']),
  );
  const state = s.config.stateDir;
  const real = (p: string) => p.replace(/^\/private/, '');
  expect(settings.filesystem.denyRead.map(real)).toContain(real(state));
  expect(settings.filesystem.allowWrite.map(real)).toContain(real(path.join(state, 'workspace')));
  expect(
    settings.filesystem.allowRead.some((item: string) =>
      real(item).startsWith(real(s.config.sessionsDir)),
    ),
  ).toBe(true);
  expect(settings.filesystem.denyWrite.map(real)).toContain(
    real(path.join(state, 'workspace', '.pirc')),
  );
  // No complaint about the settings (Linux keeps test state under /tmp, which
  // the sandbox may write: the node rightly warns about that there).
  expect(
    s.events.some(
      (event) => event.type === 'notification' && !/pirc's state lies/.test(event.payload.message),
    ),
  ).toBe(false);
});

it('asks the human before widening the network or running outside the sandbox', async () => {
  const s = await session({ sandbox: { srt: fakeSrt } });
  // Network: approved domains reach srt through the control channel.
  await s.prompt('sandbox network {"domains":["api.example.com"],"reason":"fetch the schema"}');
  const asked = await s.answer(true);
  expect(asked.request.title).toBe('Allow network access?');
  expect(asked.request.message).toContain('api.example.com');
  expect(asked.request.message).toContain('fetch the schema');
  await waitFor(
    async () => (await s.lastText())?.includes('"granted":["api.example.com"]') ?? false,
    true,
  );
  await waitFor(
    () =>
      readFileSync(s.log, 'utf8').includes('control ') &&
      readFileSync(s.log, 'utf8').includes('api.example.com'),
    true,
  );
  // Already allowed: no second question.
  expect(await s.reply('sandbox network {"domains":["github.com"]}', 'sandbox:')).toContain(
    '"granted":["github.com"]',
  );
  // Declined.
  await s.prompt('sandbox network {"domains":["evil.example.net"],"reason":"x"}');
  await s.answer(false);
  await waitFor(async () => (await s.lastText())?.includes('evil.example.net') ?? false, true);
  expect(await s.lastText()).toContain('"granted":[]');

  // Unsandboxed exec: runs only after a yes, without the node's secrets.
  const workspace = path.join(s.config.stateDir, 'workspace');
  await s.prompt(
    'sandbox exec {"command":"echo ran > out.txt; echo token=${PIRC_NODE_TOKEN:-none}","reason":"nix build"}',
  );
  const exec = await s.answer(true);
  expect(exec.request.message).toContain('$ echo ran > out.txt');
  await waitFor(async () => (await s.lastText())?.includes('token=') ?? false, true, 10_000);
  const ran = await s.lastText();
  expect(ran).toContain('token=none');
  expect(ran).toContain('"exitCode":0');
  expect(readFileSync(path.join(workspace, 'out.txt'), 'utf8')).toBe('ran\n');

  await s.prompt('sandbox exec {"command":"touch denied.txt","reason":"x"}');
  await s.answer(false);
  await waitFor(async () => (await s.lastText())?.includes('"code":"denied"') ?? false, true);
  expect(existsSync(path.join(workspace, 'denied.txt'))).toBe(false);

  // cwd must stay in the workspace.
  expect(await s.reply('sandbox exec {"command":"true","cwd":"/"}', 'sandbox:')).toContain(
    'invalid_input',
  );
});

it("ignores the agent's attempts to open or cancel the node's dialogs", async () => {
  const s = await session({ sandbox: { srt: fakeSrt } });
  expect(await s.reply('forge', 'forged')).toBe('forged');
  expect((await s.snapshot()).interactions).toEqual([]);
});
