import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Api, Model } from '@mariozechner/pi-ai';
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@mariozechner/pi-ai/oauth';
import { BackendService } from '../src/backends/service.js';
import { workerLogin } from '../src/backends/oauth-worker.js';
import { buildDaemonApp } from '../src/daemon/app.js';
import type { ModelsConfig } from '../src/models.js';
import { daemonConfig, headers } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = 'fake-secret-token';
const fake = (id: string): OAuthProviderInterface => ({
  id,
  name: `Fake ${id}`,
  login: async () => {
    throw new Error('the service must use its injected isolated runner');
  },
  refreshToken: async (credentials) => credentials,
  getApiKey: (credentials) => `${credentials.access}`,
  modifyModels: (models, credentials) =>
    models.map((model) => ({
      ...model,
      baseUrl: `https://${String(credentials.host ?? 'api')}.example`,
    })),
});
const catalog = (id: string): Model<Api>[] => [
  {
    id: `${id}-model`,
    name: 'Catalog model',
    api: id === 'openai-codex' ? 'openai-codex-responses' : 'anthropic-messages',
    provider: id,
    baseUrl: 'https://catalog.example',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    headers: { 'x-required': 'catalog-header' },
  },
];
const baseline: ModelsConfig = {
  providers: {
    file: {
      api: 'openai-chat',
      baseUrl: 'https://file-backend.example/v1',
      apiKey: 'file-secret',
      headers: { authorization: 'file-header-secret' },
      compat: {},
      models: [
        {
          id: 'file-model',
          contextWindow: 1000,
          maxTokens: 100,
          reasoning: false,
          input: ['text'],
          compat: {},
        },
      ],
    },
  },
  defaultModel: { provider: 'file', id: 'file-model' },
};

type Runner = (providerId: string, callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
function service(
  options: {
    runner?: Runner;
    refresh?: (id: string, c: OAuthCredentials) => Promise<OAuthCredentials>;
    dir?: string;
    onChange?: () => void;
  } = {},
) {
  const stateDir = options.dir ?? mkdtempSync(path.join(tmpdir(), 'pirc-backends-'));
  const backends = new BackendService({
    stateDir,
    baseline,
    registry: ['anthropic', 'github-copilot', 'openai-codex'].map(fake),
    catalog,
    loginRunner:
      options.runner ??
      (async () => {
        throw new Error('unused');
      }),
    refreshRunner: async (id, credentials) =>
      options.refresh ? options.refresh(id, credentials) : credentials,
    ...(options.onChange ? { onChange: options.onChange } : {}),
  });
  cleanups.push(() => backends.close());
  return { backends, stateDir };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};
/** A Codex-style flow: authorization URL, then a pasted localhost callback URL. */
const callbackRunner =
  (hold?: Promise<void>): Runner =>
  async (_id, callbacks) => {
    callbacks.onAuth({
      url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc',
      instructions: `Sign in Bearer ${SECRET}`,
    });
    const input = await callbacks.onManualCodeInput!();
    expect(new URL(input).searchParams.get('code')).toBe('the-code');
    await hold;
    return { access: SECRET, refresh: 'refresh-secret', expires: Date.now() + 3_600_000 };
  };
const CALLBACK = 'http://localhost:1455/auth/callback?code=the-code&state=abc';

describe('BackendService', () => {
  test('persists and edits OpenCode Go compatibility without replacing saved credentials', async () => {
    const { backends, stateDir } = service();
    const input = {
      api: 'openai-completions',
      baseUrl: 'https://proxy.example/v1',
      models: [{ id: 'glm' }],
      opencodeGo: true,
    };
    backends.saveProvider('go', { ...input, apiKey: SECRET }, true);
    expect(backends.snapshot().providers.find((p) => p.id === 'go')?.opencodeGo).toBe(true);
    await backends.close();
    const reopened = service({ dir: stateDir }).backends;
    expect((await reopened.resolve('go', 'glm')).provider.opencodeGo).toBe(true);
    reopened.saveProvider('go', { ...input, opencodeGo: false });
    const resolved = await reopened.resolve('go', 'glm');
    expect(resolved.provider.opencodeGo).toBe(false);
    expect(resolved.apiKey).toBe(SECRET);
  });

  test('lists every registry login without leaking file credentials or endpoints', () => {
    const { backends } = service();
    const snapshot = backends.snapshot();
    expect(snapshot.oauthProviders.map((p) => p.id)).toEqual([
      'anthropic',
      'github-copilot',
      'openai-codex',
    ]);
    expect(
      snapshot.oauthProviders.find((p) => p.id === 'github-copilot')!.requiresPolicyConsent,
    ).toBe(true);
    expect(snapshot.providers).toEqual([
      expect.objectContaining({ id: 'file', source: 'file', readOnly: true, hasApiKey: true }),
    ]);
    const text = JSON.stringify([snapshot, backends.models]);
    for (const secret of ['file-secret', 'file-header-secret', 'file-backend.example'])
      expect(text).not.toContain(secret);
  });

  test('persists UI backends privately; file backends are read-only and keys are write-only', async () => {
    const changes: string[] = [];
    const { backends, stateDir } = service({ onChange: () => changes.push('change') });
    const model = { id: 'local-model' };
    backends.saveProvider(
      'lan',
      {
        api: 'openai-completions',
        baseUrl: 'http://192.168.1.5:8080/v1',
        apiKey: 'ui-secret',
        models: [model],
      },
      true,
    );
    expect(() =>
      backends.saveProvider(
        'file',
        { api: 'openai-chat', baseUrl: 'https://x.example', models: [model] },
        true,
      ),
    ).toThrow('read-only');
    expect(() =>
      backends.saveProvider(
        'bad',
        { api: 'openai-chat', baseUrl: 'https://u:p@x.example', models: [model] },
        true,
      ),
    ).toThrow();
    expect(() =>
      backends.saveProvider(
        'cmd',
        {
          api: 'openai-chat',
          baseUrl: 'https://x.example',
          apiKeyCommand: ['cat'],
          models: [model],
        },
        true,
      ),
    ).toThrow();
    // Omitting the key keeps it; an empty string clears it (keyless LAN servers).
    backends.saveProvider('lan', {
      api: 'openai-completions',
      baseUrl: 'http://192.168.1.5:8080/v1',
      models: [model],
    });
    expect((await backends.resolve('lan', 'local-model')).apiKey).toBe('ui-secret');
    const file = path.join(stateDir, 'backends', 'settings.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(backends.snapshot())).not.toContain('ui-secret');
    expect(backends.snapshot().providers.find((p) => p.id === 'lan')).toMatchObject({
      source: 'ui',
      hasApiKey: true,
      baseUrl: 'http://192.168.1.5:8080/v1',
    });
    backends.saveProvider('lan', {
      api: 'openai-completions',
      baseUrl: 'http://192.168.1.5:8080/v1',
      apiKey: '',
      models: [model],
    });
    expect((await backends.resolve('lan', 'local-model')).apiKey).toBeUndefined();
    backends.setDefault({ provider: 'lan', id: 'local-model' });
    expect(backends.models.defaultModel).toEqual({ provider: 'lan', id: 'local-model' });
    expect(changes.length).toBe(4);
    // Survives a restart; deleting a backend drops a default that pointed to it.
    await backends.close();
    const reopened = service({ dir: stateDir }).backends;
    expect(reopened.models.defaultModel).toEqual({ provider: 'lan', id: 'local-model' });
    reopened.deleteProvider('lan');
    expect(reopened.models.defaultModel).toEqual(baseline.defaultModel);
    expect(readFileSync(file, 'utf8')).not.toContain('lan');
  });

  test('completes a login from a pasted callback URL; tokens stay gateway-side', async () => {
    const { backends } = service({ runner: callbackRunner() });
    let view = backends.startAuth('me', 'openai-codex');
    await until(() => backends.authStatus('me', view.id).prompts.length === 1);
    view = backends.authStatus('me', view.id);
    expect(view.auth!.url).toStartWith('https://auth.example/');
    expect(view.auth!.instructions).not.toContain(SECRET);
    const prompt = view.prompts[0]!;
    expect(prompt.kind).toBe('manual');
    // Wrong state, host, or a bare code is refused before it reaches the provider flow.
    for (const bad of [
      'the-code',
      'http://localhost:1455/auth/callback?code=x&state=other',
      'http://evil.example:1455/auth/callback?code=x&state=abc',
    ])
      expect(() => backends.authInput('me', view.id, prompt.id, bad)).toThrow('callback URL');
    expect(() => backends.authStatus('someone-else', view.id)).toThrow('not found');
    backends.authInput('me', view.id, prompt.id, CALLBACK);
    await until(() => backends.authStatus('me', view.id).status === 'succeeded');
    expect(() => backends.authInput('me', view.id, prompt.id, CALLBACK)).toThrow();
    const resolved = await backends.resolve('oauth:openai-codex', 'openai-codex-model');
    expect(resolved.apiKey).toBe(SECRET);
    expect(resolved.provider.piProvider).toBe('openai-codex');
    expect(resolved.model).toMatchObject({
      api: 'openai-codex-responses',
      canonicalProvider: 'openai-codex',
      headers: { 'x-required': 'catalog-header' },
    });
    const published = JSON.stringify([backends.models, backends.snapshot()]);
    for (const secret of [SECRET, 'refresh-secret', 'catalog-header', 'catalog.example'])
      expect(published).not.toContain(secret);
    expect(backends.snapshot().oauthProviders.find((p) => p.id === 'openai-codex')!.connected).toBe(
      true,
    );
  });

  test('requires explicit Copilot policy consent and serves prompt/select callbacks', async () => {
    const { backends } = service({
      runner: async (_id, callbacks) => {
        const domain = await callbacks.onPrompt({ message: 'Enterprise domain', allowEmpty: true });
        const choice = await callbacks.onSelect!({
          message: 'Pick',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        });
        callbacks.onAuth({
          url: 'https://github.com/login/device',
          instructions: 'Enter code: ABCD',
        });
        return {
          access: `${domain || 'none'}-${choice}`,
          refresh: 'r',
          expires: Date.now() + 3_600_000,
        };
      },
    });
    expect(() => backends.startAuth('me', 'github-copilot')).toThrow('consent');
    const { id } = backends.startAuth('me', 'github-copilot', true);
    await until(() => backends.authStatus('me', id).prompts.length === 1);
    const text = backends.authStatus('me', id).prompts[0]!;
    expect(() => backends.authInput('me', id, text.id, 'https://ghe.example/path')).toThrow(
      'Enterprise',
    );
    backends.authInput('me', id, text.id, '');
    await until(() => backends.authStatus('me', id).prompts[0]?.kind === 'select');
    const select = backends.authStatus('me', id).prompts[0]!;
    expect(() => backends.authInput('me', id, select.id, 'zzz')).toThrow('selection');
    backends.authInput('me', id, select.id, 'b');
    await until(() => backends.authStatus('me', id).status === 'succeeded');
    expect((await backends.resolve('oauth:github-copilot', 'github-copilot-model')).apiKey).toBe(
      'none-b',
    );
  });

  test('exposes a device-flow user code separately from the instructions', async () => {
    const { backends } = service({
      runner: async (_id, callbacks) => {
        callbacks.onAuth({
          url: 'https://github.com/login/device',
          instructions: 'Enter code: AB12-CD34',
        });
        await callbacks.onPrompt({ message: 'Hold' });
        throw new Error('unused');
      },
    });
    const { id } = backends.startAuth('me', 'github-copilot', true);
    await until(() => backends.authStatus('me', id).prompts.length === 1);
    expect(backends.authStatus('me', id).auth).toEqual({
      url: 'https://github.com/login/device',
      instructions: 'Enter code: AB12-CD34',
      userCode: 'AB12-CD34',
    });
  });

  test('cancellation and logout win over late login and refresh results', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { backends } = service({ runner: callbackRunner(hold) });
    const view = backends.startAuth('me', 'openai-codex');
    await until(() => backends.authStatus('me', view.id).prompts.length === 1);
    backends.authInput('me', view.id, backends.authStatus('me', view.id).prompts[0]!.id, CALLBACK);
    expect(backends.cancelAuth('me', view.id).status).toBe('cancelled');
    release();
    await Bun.sleep(20);
    expect(backends.snapshot().oauthProviders.find((p) => p.id === 'openai-codex')!.connected).toBe(
      false,
    );
    await expect(backends.resolve('oauth:openai-codex', 'openai-codex-model')).rejects.toThrow();
  });

  test('refreshes expired tokens once for concurrent requests; logout discards in-flight refresh', async () => {
    let refreshes = 0;
    let finish!: () => void;
    let gate = Promise.resolve();
    const { backends, stateDir } = service({
      runner: async () => ({ access: 'old', refresh: 'r', expires: Date.now() - 1 }),
      refresh: async (_id, credentials) => {
        refreshes++;
        await gate;
        return { ...credentials, access: `new-${refreshes}`, expires: Date.now() + 3_600_000 };
      },
    });
    const { id } = backends.startAuth('me', 'anthropic');
    await until(() => backends.authStatus('me', id).status === 'succeeded');
    const [a, b] = await Promise.all([
      backends.resolve('oauth:anthropic', 'anthropic-model'),
      backends.resolve('oauth:anthropic', 'anthropic-model'),
    ]);
    expect([a.apiKey, b.apiKey, refreshes]).toEqual(['new-1', 'new-1', 1]);
    expect(readFileSync(path.join(stateDir, 'backends', 'settings.json'), 'utf8')).toContain(
      'new-1',
    );

    // Force another refresh, then log out while it is still running.
    backends['state'].oauth.anthropic!.expires = 0;
    gate = new Promise((resolve) => (finish = resolve));
    const pending = backends.resolve('oauth:anthropic', 'anthropic-model');
    await until(() => refreshes === 2);
    backends.deleteProvider('oauth:anthropic');
    finish();
    await expect(pending).rejects.toThrow('sign in again');
    expect(backends.snapshot().oauthProviders.find((p) => p.id === 'anthropic')!.connected).toBe(
      false,
    );
    expect(readFileSync(path.join(stateDir, 'backends', 'settings.json'), 'utf8')).not.toContain(
      'new-2',
    );
  });
});

test('the isolated OAuth worker speaks private IPC and fails closed', async () => {
  const outcome = await workerLogin('no-such-provider', {
    onAuth: () => {},
    onPrompt: async () => '',
  }).then(
    () => 'resolved',
    (error: Error) => error.message,
  );
  expect(outcome).toBe('OAuth provider failed');
});

describe('backend routes', () => {
  test('require browser auth and Origin for mutations, and never cache responses', async () => {
    const { app, services } = await buildDaemonApp(daemonConfig());
    cleanups.push(() => app.close());
    expect(services.backends.snapshot().oauthProviders.map((p) => p.id)).toEqual([
      'anthropic',
      'github-copilot',
      'openai-codex',
    ]);
    const listed = await app.inject({ method: 'GET', url: '/api/providers', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const { origin: _origin, ...noOrigin } = headers;
    const body = {
      id: 'lan',
      api: 'openai-chat',
      baseUrl: 'http://10.0.0.2:1234/v1',
      apiKey: 'route-secret',
      models: [{ id: 'm' }],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/providers',
          headers: noOrigin,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { ...headers, 'x-pirc-user': 'intruder' },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('route-secret');
    const models = await app.inject({ method: 'GET', url: '/api/models', headers });
    expect(models.json().models).toEqual([expect.objectContaining({ provider: 'lan', id: 'm' })]);
    const set = await app.inject({
      method: 'PUT',
      url: '/api/providers/default-model',
      headers,
      payload: { provider: 'lan', id: 'm' },
    });
    expect(set.json().defaultModel).toEqual({ provider: 'lan', id: 'm' });
    const auth = await app.inject({
      method: 'POST',
      url: '/api/provider-auth/sessions',
      headers,
      payload: { providerId: 'github-copilot' },
    });
    expect(auth.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/providers/lan', headers })).json().providers,
    ).toEqual([]);
  });
});
