/**
 * Providers and keys live only on the gateway: a real `pirc agent` on a node
 * sends model requests through the node link, and the gateway calls the model.
 * A reload therefore reaches running sessions on their next request.
 */
import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultAgentCommand } from '../src/config.js';
import { writeAgentConfig } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it('routes node agents through gateway inference; reloads reach running sessions', async () => {
  const llm = startFakeLlm();
  cleanup.push(() => llm.stop());
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-models-e2e-'));
  // The node's own config.json has no providers (a stale one would be ignored).
  const configDir = path.join(dir, 'node-config');
  writeAgentConfig(configDir);
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const modelsFile = path.join(dir, 'models.json');
  process.env.PIRC_TEST_GATEWAY_KEY = 'first-key';
  cleanup.push(() => void delete process.env.PIRC_TEST_GATEWAY_KEY);
  const writeModels = (ids: string[], defaultId: string) =>
    writeFileSync(
      modelsFile,
      JSON.stringify({
        providers: {
          gw: {
            api: 'openai-chat',
            baseUrl: `${llm.url}/v1`,
            apiKeyEnv: 'PIRC_TEST_GATEWAY_KEY',
            models: ids.map((id) => ({ id, contextWindow: 100_000, maxTokens: 1000 })),
          },
        },
        defaultModel: { provider: 'gw', id: defaultId },
      }),
    );
  writeModels(['model-a'], 'model-a');
  const cluster: Cluster = await startCluster([{ nodeId: 'test', ...defaultAgentCommand({}) }], {
    modelsFile,
  });
  cleanup.push(() => cluster.close());
  const { app, services } = cluster;

  const openSession = async () => {
    const sessionId = (
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers,
        payload: { workspaceId: 'test:test' },
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
    let commands = 0;
    const prompt = async (message: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/commands`,
        headers,
        payload: {
          commandId: `${sessionId}-${++commands}`,
          clientId: 'browser-1',
          generation,
          payload: { type: 'prompt', message },
        },
      });
      expect(response.statusCode).toBe(202);
      const snapshot = async () =>
        (
          await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/snapshot`, headers })
        ).json();
      await waitFor(async () => (await snapshot()).run?.status, 'succeeded', 10_000);
    };
    return { sessionId, prompt };
  };

  const first = await openSession();
  llm.push({ text: 'one' });
  await first.prompt('hello');
  expect(llm.requests[0]!.body.model).toBe('model-a');
  expect(llm.requests[0]!.headers.authorization).toBe('Bearer first-key');

  // Rotate the key and add a model. Only the gateway ever holds the key.
  writeModels(['model-a', 'model-b'], 'model-b');
  process.env.PIRC_TEST_GATEWAY_KEY = 'second-key';
  services.reloadModels();
  expect(
    (await app.inject({ method: 'GET', url: '/api/models', headers }))
      .json()
      .models.map((model: { id: string }) => model.id),
  ).toEqual(['model-a', 'model-b']);
  await Bun.sleep(100);

  // The running agent keeps its chosen model but its next request uses the new key.
  llm.push({ text: 'two' });
  await first.prompt('again');
  expect(llm.requests[1]!.body.model).toBe('model-a');
  expect(llm.requests[1]!.headers.authorization).toBe('Bearer second-key');

  const second = await openSession();
  llm.push({ text: 'three' });
  await second.prompt('new session');
  expect(llm.requests[2]!.body.model).toBe('model-b');
  expect(llm.requests[2]!.headers.authorization).toBe('Bearer second-key');
});
