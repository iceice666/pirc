/**
 * With a node inference transport configured, every model call path in the
 * agent (turns, compaction, title, memory, team children) uses the gateway
 * relay rather than a local provider adapter, and the catalog refreshes live.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { emptyUsage } from '../src/agent/messages.js';
import { RpcUi, handleCommand } from '../src/agent/rpc.js';
import { SessionStore } from '../src/agent/session-store.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { publicModels, type ModelsConfig } from '../src/models.js';
import { startNodeInference } from '../src/node/inference.js';
import { testModels } from './agent-harness.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('sends every model call through the node relay and refreshes the catalog live', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-remote-agent-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  // What a node would hold: a public catalog, never a credential.
  let catalog: ModelsConfig = publicModels(testModels('http://127.0.0.1:1'));
  const starts: Array<{ providerName: string; modelId: string }> = [];
  const server = await startNodeInference({
    stateDir: path.join(root, 'state'),
    getModels: () => ({ ...catalog, inference: server.config }),
    send: (message) => {
      if (message.type !== 'model_start') return true;
      starts.push({ providerName: message.request.providerName, modelId: message.request.modelId });
      queueMicrotask(() =>
        server.receive(message.requestId, {
          type: 'model_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'relayed' }],
            api: 'openai-chat',
            provider: message.request.providerName,
            model: message.request.modelId,
            usage: emptyUsage(),
            stopReason: 'stop',
            timestamp: 1,
          },
        }),
      );
      return true;
    },
  });
  cleanups.push(() => server.close());
  const config = loadAgentConfig(
    workspace,
    { ...catalog, inference: server.config },
    {
      PIRC_CONFIG_DIR: path.join(root, 'config'),
    },
  );
  expect(JSON.stringify(config.models)).not.toContain('test-key');
  const agent = new Agent({
    config,
    store: new SessionStore(path.join(root, 'session'), workspace),
    ui: new RpcUi(() => {}),
    hasUI: false,
    tools: builtinTools(),
    emit: () => {},
  });
  cleanups.push(() => agent.shutdown());

  // Any provider (including ones whose api has no local adapter) uses the relay.
  const reply = await agent.streamFunction(config.providers.fakeclaude!)(
    {
      providerName: 'fakeclaude',
      provider: config.providers.fakeclaude!,
      model: config.providers.fakeclaude!.models[0]!,
      apiKey: undefined,
      systemPrompt: 'title please',
      messages: [],
      tools: [],
      thinking: 'off',
      sessionId: 's',
      signal: new AbortController().signal,
    },
    () => {},
  );
  expect(reply.content).toEqual([{ type: 'text', text: 'relayed' }]);
  // Agent.stream is what turns, compaction and cache warming use.
  expect(
    (await agent.stream('system', new AbortController().signal, { emit: false })).stopReason,
  ).toBe('stop');
  expect(starts).toEqual([
    { providerName: 'fakeclaude', modelId: 'claude-x' },
    { providerName: 'fake', modelId: 'fake-model' },
  ]);

  // A backend added on the gateway (e.g. a new subscription login) becomes
  // selectable in this running agent without a restart.
  catalog = publicModels({
    ...testModels('http://127.0.0.1:1'),
    providers: {
      ...testModels('http://127.0.0.1:1').providers,
      'oauth:openai-codex': {
        api: 'openai-codex-responses',
        piProvider: 'openai-codex',
        baseUrl: 'https://secret.invalid',
        headers: {},
        compat: {},
        models: [
          {
            id: 'gpt-x',
            contextWindow: 1000,
            maxTokens: 100,
            reasoning: true,
            input: ['text'],
            compat: {},
          },
        ],
      },
    },
  });
  await handleCommand(agent, {
    type: 'set_model',
    provider: 'oauth:openai-codex',
    modelId: 'gpt-x',
  });
  expect(agent.modelRef).toEqual({ provider: 'oauth:openai-codex', id: 'gpt-x' });
  // Team children are configured from this same object, so they inherit both.
  expect(Object.keys(agent.config.models.providers)).toContain('oauth:openai-codex');
  expect(agent.config.models.inference).toEqual(server.config);
});
