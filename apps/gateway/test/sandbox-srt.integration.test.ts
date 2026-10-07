/**
 * A real `pirc-node agent` under the real srt (plans/sandbox.md). Runs only where
 * srt works (not inside another sandbox: macOS sandboxes do not nest): set
 * PIRC_TEST_SRT to `embedded` for the srt built into pirc (node/srt.ts), or to
 * the path of an external one.
 * PIRC_TEST_AGENT_COMMAND runs a built binary (e.g. the Nix package's
 * `bin/pirc-node`) as the agent instead of the sources.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { defaultAgentCommand } from '../src/config.js';
import { buildNodeApp } from '../src/node/app.js';
import { startNodeInference } from '../src/node/inference.js';
import { GatewayInference } from '../src/backends/inference.js';
import { publicModels } from '../src/models.js';
import { testModels, writeAgentConfig } from './agent-harness.js';
import { ptcCall, startFakeLlm } from './fixtures/fake-llm.js';
import { nodeHeaders as headers, testConfig, waitFor } from './helpers.js';

const srt = process.env.PIRC_TEST_SRT || undefined;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it.skipIf(!srt)(
  'confines a real agent: private state and home stay out of reach, the workspace works',
  async () => {
    const llm = startFakeLlm();
    cleanup.push(() => llm.stop());
    const configDir = mkdtempSync(path.join(tmpdir(), 'pirc-srt-config-'));
    // The fake model listens on loopback; the proxy only dials literal loopback allowances.
    writeAgentConfig(configDir, {
      // The sandbox, not auto mode, is under test: no confirmations.
      features: { autoMode: { enabled: false } },
      sandbox: { network: { allowedDomains: [`127.0.0.1:${new URL(llm.url).port}`] } },
    });
    const previous = process.env.PIRC_CONFIG_DIR;
    process.env.PIRC_CONFIG_DIR = configDir;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
      else process.env.PIRC_CONFIG_DIR = previous;
    });
    const agent = process.env.PIRC_TEST_AGENT_COMMAND
      ? { agentCommand: process.env.PIRC_TEST_AGENT_COMMAND, agentArgs: ['agent'] }
      : defaultAgentCommand({});
    const config = testConfig({ ...agent, sandbox: srt === 'embedded' ? {} : { srt } });
    writeFileSync(path.join(config.stateDir, 'secret.txt'), 'node secret');
    const { app, services } = await buildNodeApp(config);
    // Match production's secret-free Unix inference transport. Direct loopback HTTP
    // cannot reach the host fake provider from Linux's unshared network namespace.
    const privateModels = testModels(llm.url);
    const catalog = publicModels(privateModels);
    const gateway = new GatewayInference({
      async resolve(providerName, modelId) {
        const provider = privateModels.providers[providerName];
        const model = provider?.models.find((candidate) => candidate.id === modelId);
        if (!provider || !model) throw new Error('Unknown test model');
        return { provider, model, apiKey: provider.apiKey };
      },
    });
    const requests = new Map<string, AbortController>();
    const inference = await startNodeInference({
      stateDir: config.stateDir,
      getModels: () => catalog,
      send(message) {
        if (message.type === 'model_cancel') {
          requests.get(message.requestId)?.abort();
          return true;
        }
        const controller = new AbortController();
        requests.set(message.requestId, controller);
        void gateway
          .run(
            message.request,
            controller.signal,
            (delta) => inference.receive(message.requestId, { type: 'model_delta', delta }),
            'sandbox-test',
          )
          .then((result) =>
            inference.receive(message.requestId, { type: 'model_end', message: result }),
          )
          .finally(() => requests.delete(message.requestId));
        return true;
      },
    });
    services.models.set({ ...catalog, inference: inference.config });
    cleanup.push(async () => {
      await app.close();
      gateway.cancelAll();
      await inference.close();
    });
    const sessionId = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { workspaceId: 'test' },
      })
    ).json().session.id as string;
    const generation = (
      await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/control/acquire`,
        headers,
        payload: { clientId: 'browser-1' },
      })
    ).json().lease.generation as number;
    const probe = path.join(os.homedir(), `.pirc-sandbox-probe-${Date.now()}`);
    cleanup.push(() => void (existsSync(probe) && Bun.file(probe).delete()));
    // Every operation runs from a ptc script, in its QuickJS process inside the sandbox.
    llm.push(
      {
        tool: ptcCall('a', 'bash', { command: `cat ${path.join(config.stateDir, 'secret.txt')}` }),
      },
      { tool: ptcCall('b', 'bash', { command: 'echo inside > ok.txt && cat ok.txt' }) },
      { tool: ptcCall('c', 'bash', { command: `touch ${probe}` }) },
      { tool: ptcCall('d', 'read', { path: path.join(config.stateDir, 'secret.txt') }) },
      // Not on the allowlist.
      {
        tool: ptcCall('e', 'bash', {
          command: 'curl -sS -m 10 -o /dev/null https://example.com/ 2>&1; echo "curl=$?"',
        }),
      },
      // A script with its own logic: the script process starts inside srt with no environment.
      {
        tool: {
          id: 'f',
          name: 'ptc',
          args: {
            code: "const r = await tools.bash({ command: 'echo from-ptc' }); return r.text + ' ' + typeof (globalThis as any).process;",
          },
        },
      },
      // Pseudo-terminals (background_task tty:true needs them too).
      {
        tool: ptcCall('g', 'bash', {
          command:
            "if [ \"$(uname)\" = Darwin ]; then script -q /dev/null sh -c 'tty; echo pty-ok'; else script -qc 'tty; echo pty-ok' /dev/null; fi",
        }),
      },
      // Outside the sandbox, after the human says yes (answered below).
      {
        tool: ptcCall('i', 'unsandboxed_bash', {
          command: `touch ${probe} && echo outside-ok`,
          reason: 'test',
        }),
      },
      { text: 'done' },
    );
    const sent = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers,
      payload: {
        commandId: 'c1',
        clientId: 'browser-1',
        generation,
        payload: { type: 'prompt', message: 'probe the sandbox' },
      },
    });
    expect(sent.statusCode).toBe(202);
    const snapshot = async () =>
      (
        await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
      ).json();
    await waitFor(async () => (await snapshot()).interactions.length, 1, 60_000);
    const asked = (await snapshot()).interactions[0];
    expect(asked.request.title).toBe('Run a command outside the sandbox?');
    const answered = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/interactions/${asked.id}/answer`,
      headers,
      payload: { clientId: 'browser-1', generation, answer: { confirmed: true } },
    });
    expect(answered.statusCode).toBe(200);
    await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 60_000);
    const results = (await snapshot()).history
      // The script results; history also lists each script's operations before it.
      .filter((m: any) => m.role === 'toolResult' && !m.parentToolCallId)
      .map((m: any) => m.content[0].text as string);
    expect(results[0]).toMatch(
      /Operation not permitted|Permission denied|No such file or directory/,
    );
    expect(results[0]).not.toContain('node secret');
    expect(results[1]).toContain('inside');
    expect(results[2]).toMatch(/Operation not permitted|Permission denied|Read-only file system/);
    expect(results[3]).toContain('is private');
    expect(results[4]).toMatch(/403|curl=[1-9]/);
    expect(results[5]).toContain('from-ptc');
    expect(results[5]).toContain('undefined');
    expect(results[6]).toContain('pty-ok');
    expect(results[6]).toMatch(/\/dev\/(pts|ttys)/);
    expect(results[7]).toContain('outside-ok');
    expect(existsSync(probe)).toBe(true);
  },
  90_000,
);
