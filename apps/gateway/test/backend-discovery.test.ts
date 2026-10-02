import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Api, Model } from '@mariozechner/pi-ai';
import {
  catalogPresets,
  discoverModels,
  parseModelList,
  testConnection,
} from '../src/backends/discovery.js';
import { BackendService } from '../src/backends/service.js';
import { buildDaemonApp } from '../src/daemon/app.js';
import { daemonConfig, headers } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = 'sk-discovery-secret';
const model = (provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> => ({
  id,
  name: `${id} name`,
  api: 'openai-completions',
  provider,
  baseUrl: `https://${provider}.example/v1`,
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 8_000,
  ...extra,
});
const catalogs: Record<string, Model<Api>[]> = {
  router: [
    model('router', 'vendor/known', {
      compat: { thinkingFormat: 'openrouter' } as never,
      headers: { 'x-title': 'pirc' },
    }),
  ],
  openai: [model('openai', 'gpt-x', { api: 'openai-responses' })],
  mixed: [model('mixed', 'a'), model('mixed', 'b', { api: 'anthropic-messages' })],
  templated: [model('templated', 'a', { baseUrl: 'https://x.example/{ACCOUNT}/v1' })],
  'github-copilot': [model('github-copilot', 'a')],
  unsupported: [model('unsupported', 'a', { api: 'google-generative-ai' })],
};
const catalog = (id: string) => catalogs[id] ?? [];

function service(fetcher?: typeof fetch, connectionTester?: typeof testConnection) {
  const backends = new BackendService({
    stateDir: mkdtempSync(path.join(tmpdir(), 'pirc-discovery-')),
    baseline: { providers: {} },
    registry: [],
    catalog,
    catalogProviders: () => Object.keys(catalogs),
    ...(fetcher ? { fetcher } : {}),
    ...(connectionTester ? { connectionTester } : {}),
  });
  cleanups.push(() => backends.close());
  return backends;
}

describe('backend presets', () => {
  test('offer single-endpoint catalog providers first, then local servers', () => {
    const presets = catalogPresets(Object.keys(catalogs), catalog);
    expect(presets.map((preset) => preset.id)).toEqual(['openai', 'router', 'ollama', 'lmstudio']);
    expect(presets[0]).toMatchObject({
      name: 'OpenAI',
      api: 'openai-responses',
      baseUrl: 'https://openai.example/v1',
      catalog: true,
      models: [
        {
          id: 'gpt-x',
          name: 'gpt-x name',
          contextWindow: 64_000,
          maxTokens: 8_000,
          reasoning: true,
          input: ['text', 'image'],
        },
      ],
    });
    expect(presets.at(-1)).toMatchObject({ keyless: true, catalog: false, models: [] });
  });

  test('saving from a preset keeps catalog request metadata gateway-side', async () => {
    const backends = service();
    backends.saveProvider(
      'router',
      {
        api: 'openai-completions',
        baseUrl: 'https://router.example/v1',
        apiKey: SECRET,
        preset: 'router',
        models: [{ id: 'vendor/known' }, { id: 'vendor/custom' }],
      },
      true,
    );
    const resolved = await backends.resolve('router', 'vendor/known');
    expect(resolved.provider.piProvider).toBe('router');
    expect(resolved.model).toMatchObject({
      compat: { thinkingFormat: 'openrouter' },
      headers: { 'x-title': 'pirc' },
    });
    expect((await backends.resolve('router', 'vendor/custom')).model.compat).toEqual({});
    const snapshot = backends.snapshot();
    expect(snapshot.providers[0]).toMatchObject({ id: 'router', preset: 'router' });
    expect(JSON.stringify(snapshot)).not.toContain('x-title');
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    // Editing without the preset drops the catalog metadata.
    backends.saveProvider('router', {
      api: 'openai-completions',
      baseUrl: 'https://router.example/v1',
      models: [{ id: 'vendor/known' }],
    });
    const plain = await backends.resolve('router', 'vendor/known');
    expect(plain.provider.piProvider).toBeUndefined();
    expect(plain.model.compat).toEqual({});
    expect(plain.apiKey).toBe(SECRET);
    for (const preset of ['ollama', 'mixed', 'nope'])
      expect(() =>
        backends.saveProvider(
          `x-${preset}`,
          {
            api: 'openai-completions',
            baseUrl: 'https://a.example',
            preset,
            models: [{ id: 'm' }],
          },
          true,
        ),
      ).toThrow('Unknown backend preset');
    // The preset's API is part of its compatibility contract.
    expect(() =>
      backends.saveProvider(
        'mismatch',
        {
          api: 'anthropic-messages',
          baseUrl: 'https://a.example',
          preset: 'router',
          models: [{ id: 'm' }],
        },
        true,
      ),
    ).toThrow('Unknown backend preset');
  });
});

describe('model discovery', () => {
  test('parses OpenAI, OpenRouter and Ollama lists with size hints', () => {
    expect(
      parseModelList({
        data: [
          { id: 'plain' },
          { id: 'plain' },
          {
            id: 'rich',
            name: 'Rich model',
            context_length: 128_000,
            top_provider: { max_completion_tokens: 16_000 },
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'reasoning'],
          },
          { id: 'bad\u0000id' },
          { id: 42 },
          { id: 'huge', context_length: -1, max_model_len: 32_768 },
        ],
      }),
    ).toEqual([
      { id: 'plain' },
      {
        id: 'rich',
        name: 'Rich model',
        contextWindow: 128_000,
        maxTokens: 16_000,
        reasoning: true,
        input: ['text', 'image'],
      },
      { id: 'huge', contextWindow: 32_768 },
    ]);
    expect(parseModelList({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] })).toEqual([
      { id: 'qwen3:8b' },
    ]);
    expect(() => parseModelList({ error: 'x' })).toThrow('unrecognized model list');
  });

  test('sends the key only as the API expects, refuses redirects and never echoes bodies', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let reply = () =>
      new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'vendor/known', name: 'Known' }] }));
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return reply();
    }) as typeof fetch;
    const known = (id: string) => catalogs.router!.find((entry) => entry.id === id);
    const models = await discoverModels(
      { api: 'openai-completions', baseUrl: 'https://a.example/v1/', apiKey: SECRET },
      known,
      fetcher,
    );
    expect(models).toEqual([
      {
        id: 'vendor/known',
        name: 'Known',
        contextWindow: 64_000,
        maxTokens: 8_000,
        reasoning: true,
        input: ['text', 'image'],
        known: true,
      },
      { id: 'z', known: false },
    ]);
    expect(seen[0]!.url).toBe('https://a.example/v1/models');
    expect(seen[0]!.init.redirect).toBe('manual');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`,
    );
    await discoverModels(
      { api: 'anthropic-messages', baseUrl: 'https://b.example', apiKey: SECRET },
      known,
      fetcher,
    );
    expect(seen[1]!.url).toBe('https://b.example/v1/models?limit=1000');
    expect(seen[1]!.init.headers).toMatchObject({
      'x-api-key': SECRET,
      'anthropic-version': '2023-06-01',
    });
    expect(seen[1]!.init.headers).not.toHaveProperty('authorization');

    const failure = async () => {
      try {
        await discoverModels({ api: 'openai-chat', baseUrl: 'https://a.example' }, known, fetcher);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected failure');
    };
    reply = () => new Response(`bad key ${SECRET}`, { status: 401 });
    expect(await failure()).toBe(
      'The endpoint rejected the API key (HTTP 401). Check the key and try again.',
    );
    reply = () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
    expect(await failure()).toContain('redirected');
    reply = () => new Response(`<html>${SECRET}</html>`);
    expect(await failure()).toBe('The endpoint returned an unrecognized model list.');
    const offline = (async () => {
      throw new TypeError(`fetch failed ${SECRET}`);
    }) as unknown as typeof fetch;
    await expect(
      discoverModels({ api: 'openai-chat', baseUrl: 'https://a.example' }, known, offline),
    ).rejects.toThrow('Cannot reach the endpoint from the gateway. Check the base URL.');
  });

  test('reuses only the edited web backend key unless a key (or none) is typed', async () => {
    const keys: Array<string | undefined> = [];
    const backends = service((async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch);
    backends.saveProvider(
      'saved',
      {
        api: 'openai-completions',
        baseUrl: 'https://a.example',
        apiKey: SECRET,
        models: [{ id: 'm' }],
      },
      true,
    );
    const form = { api: 'openai-completions', baseUrl: 'https://a.example' };
    await backends.discover({ ...form, backendId: 'saved' });
    await backends.discover({ ...form, backendId: 'saved', apiKey: '' });
    await backends.discover({ ...form, backendId: 'saved', apiKey: 'typed' });
    await backends.discover({ ...form, backendId: 'missing' });
    expect(keys).toEqual([`Bearer ${SECRET}`, undefined, 'Bearer typed', undefined]);
    expect(() => backends.discover({ ...form, baseUrl: 'ftp://a.example' })).toThrow(
      'Invalid backend settings',
    );
  });
});

describe('connection test', () => {
  test('runs one small request through the shared inference path', async () => {
    const requests: unknown[] = [];
    const ok = await testConnection(
      {
        provider: {
          api: 'openai-completions',
          baseUrl: 'https://a.example',
          headers: {},
          compat: {},
          models: [],
        },
        model: {
          id: 'm',
          contextWindow: 1,
          maxTokens: 1,
          reasoning: false,
          input: ['text'],
          compat: {},
        },
        apiKey: SECRET,
      },
      (resolver) => ({
        run: async (request) => {
          requests.push({ request, resolved: await resolver.resolve('x', 'm') });
          return { stopReason: 'length' } as never;
        },
      }),
    );
    expect(ok).toMatchObject({ ok: true });
    expect(requests[0]).toMatchObject({
      request: { modelId: 'm', tools: [], thinking: 'off', maxTokens: 32 },
      resolved: { apiKey: SECRET },
    });
    const failed = await testConnection(
      {
        provider: { api: 'openai-chat', baseUrl: 'https://a', headers: {}, compat: {}, models: [] },
        model: {
          id: 'm',
          contextWindow: 1,
          maxTokens: 1,
          reasoning: false,
          input: ['text'],
          compat: {},
        },
      },
      () => ({
        run: async () =>
          ({ stopReason: 'error', errorMessage: 'Model request failed (HTTP 401)' }) as never,
      }),
    );
    expect(failed).toMatchObject({ ok: false, message: 'Model request failed (HTTP 401)' });
  });

  test('the service builds the provider exactly as saving would', async () => {
    const calls: Array<Parameters<typeof testConnection>[0]> = [];
    const backends = service(undefined, async (resolved) => {
      calls.push(resolved);
      return { ok: true, message: 'fine', latencyMs: 1 };
    });
    await backends.testProvider({
      api: 'openai-completions',
      baseUrl: 'https://router.example/v1',
      apiKey: SECRET,
      preset: 'router',
      model: { id: 'vendor/known' },
    });
    expect(calls[0]).toMatchObject({
      apiKey: SECRET,
      provider: { piProvider: 'router' },
      model: { id: 'vendor/known', compat: { thinkingFormat: 'openrouter' } },
    });
    expect(() =>
      backends.testProvider({ api: 'openai-completions', baseUrl: 'https://a' }),
    ).toThrow('Invalid backend settings');
  });
});

test('setup routes require browser auth and Origin, and never cache', async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) =>
      request.headers.get('authorization') === `Bearer ${SECRET}`
        ? Response.json({ data: [{ id: 'served' }] })
        : new Response('no', { status: 401 }),
  });
  cleanups.push(() => upstream.stop(true));
  const { app } = await buildDaemonApp(daemonConfig());
  cleanups.push(() => app.close());
  const presets = await app.inject({ method: 'GET', url: '/api/providers/presets', headers });
  expect(presets.statusCode).toBe(200);
  expect(presets.headers['cache-control']).toBe('no-store');
  const ids = presets.json().presets.map((preset: { id: string }) => preset.id);
  expect(ids.slice(0, 2)).toEqual(['openai', 'anthropic']);
  expect(ids).not.toContain('github-copilot');
  const payload = {
    api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: SECRET,
  };
  const { origin: _origin, ...noOrigin } = headers;
  for (const url of ['/api/providers/discover', '/api/providers/test'])
    expect((await app.inject({ method: 'POST', url, headers: noOrigin, payload })).statusCode).toBe(
      403,
    );
  const found = await app.inject({
    method: 'POST',
    url: '/api/providers/discover',
    headers,
    payload,
  });
  expect(found.json() as unknown).toEqual({ models: [{ id: 'served', known: false }] });
  expect(found.body).not.toContain(SECRET);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/providers/discover',
    headers,
    payload: { ...payload, apiKey: 'wrong' },
  });
  expect(denied.statusCode).toBe(502);
  expect(denied.json().error.message).toContain('rejected the API key');
});
