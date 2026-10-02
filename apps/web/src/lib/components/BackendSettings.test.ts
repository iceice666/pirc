// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import BackendSettings from './BackendSettings.svelte';
import type {
  BackendPreset,
  BackendSettingsSnapshot,
  ConnectionTestResult,
  DiscoveredModel,
  ProviderAuthSession,
} from '../types';
import { reactiveProps } from '../testing/props.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let settings: BackendSettingsSnapshot;
let auth: ProviderAuthSession;
let presets: BackendPreset[];
let discovered: DiscoveredModel[];
let tested: ConnectionTestResult;
let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ url: string; method: string; body: any; init: RequestInit }>;
let changed: ReturnType<typeof vi.fn>;

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
const buttons = () => Array.from(target.querySelectorAll<HTMLButtonElement>('button'));
const button = (text: string) => buttons().find((item) => item.textContent?.trim() === text)!;
async function click(text: string) {
  button(text).click();
  await flush();
}
function field(label: string) {
  return Array.from(target.querySelectorAll('label'))
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')!;
}
async function input(label: string, value: string) {
  const element = field(label);
  element.value = value;
  element.dispatchEvent(
    new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
  );
  await flush();
}
async function setup(disabled = false) {
  target = document.createElement('div');
  document.body.append(target);
  changed = vi.fn();
  component = mount(BackendSettings, { target, props: { disabled, onchanged: changed } });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  settings = {
    providers: [
      {
        id: 'baseline',
        name: 'Baseline',
        source: 'file',
        readOnly: true,
        api: 'openai-chat',
        hasApiKey: true,
        models: [{ id: 'base-model' }],
      },
    ],
    oauthProviders: [
      {
        id: 'future-provider',
        name: 'Future registry provider',
        connected: false,
        providerId: 'oauth:future-provider',
        requiresPolicyConsent: false,
        usesCallbackServer: true,
        modelCount: 2,
      },
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        connected: false,
        providerId: 'oauth:github-copilot',
        requiresPolicyConsent: true,
        usesCallbackServer: false,
        modelCount: 26,
      },
    ],
  };
  auth = {
    id: 'login-1',
    providerId: 'future-provider',
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    prompts: [],
    auth: {
      url: 'https://provider.example/auth',
      instructions: 'Code ABCD. <script>not HTML</script>',
    },
    progress: 'Waiting for authorization',
  };
  presets = [
    {
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.example/v1',
      catalog: true,
      models: [
        { id: 'gpt-x', name: 'GPT X', contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
        { id: 'gpt-mini', name: 'GPT Mini', contextWindow: 128_000, maxTokens: 16_000 },
      ],
    },
    {
      id: 'ollama',
      name: 'Ollama (local)',
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      keyless: true,
      catalog: false,
      models: [],
    },
  ];
  discovered = [];
  tested = { ok: true, message: 'm answered in 12 ms.', latencyMs: 12 };
  calls = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, init });
    if (url.startsWith('/api/provider-auth/')) return response(auth);
    if (url === '/api/providers/presets') return response({ presets });
    if (url === '/api/providers/discover') return response({ models: discovered });
    if (url === '/api/providers/test') return response(tested);
    return response(settings);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BackendSettings', () => {
  it('loads once it stops being disabled', async () => {
    target = document.createElement('div');
    document.body.append(target);
    const props = reactiveProps({ disabled: true, onchanged: vi.fn() });
    component = mount(BackendSettings, { target, props });
    await flush();
    expect(calls).toHaveLength(0);
    props.disabled = false;
    await flush();
    expect(calls.map((call) => call.url)).toEqual(['/api/providers']);
    expect(target.textContent).toContain('Future registry provider');
  });

  it('keeps an unsaved default choice when settings refresh with the same default', async () => {
    settings.defaultModel = { provider: 'baseline', id: 'base-model' };
    settings.providers[0]!.models.push({ id: 'other-model' });
    settings.providers.push({
      id: 'custom',
      name: 'Custom',
      source: 'ui',
      readOnly: false,
      api: 'openai-completions',
      hasApiKey: false,
      models: [{ id: 'custom-model' }],
    });
    await setup();
    await input('Gateway default', JSON.stringify(['baseline', 'other-model']));
    // Another change refreshes settings; the saved default is unchanged.
    await click('Remove custom');
    expect(calls[calls.length - 1]).toMatchObject({ method: 'DELETE' });
    expect(field('Gateway default').value).toBe(JSON.stringify(['baseline', 'other-model']));
    // A changed saved default does reset the picker.
    fetchMock.mockImplementationOnce(async () =>
      response({ ...settings, defaultModel: { provider: 'custom', id: 'custom-model' } }),
    );
    await click('Remove custom');
    expect(field('Gateway default').value).toBe(JSON.stringify(['custom', 'custom-model']));
  });

  it('loads every registry provider, labels baseline read-only, and requires explicit policy consent', async () => {
    await setup();
    expect(target.textContent).toContain('Future registry provider');
    expect(target.textContent).toContain('File-managed · Read only');
    expect(button('Edit baseline')).toBeUndefined();
    const logins = buttons().filter((item) => item.textContent?.trim() === 'Log in');
    // Consent is asked only when logging in, and nothing starts before it is given.
    expect(target.textContent).not.toContain('enables the policies');
    logins[1].click();
    await flush();
    expect(target.textContent).toContain(
      'enables the policies for all known GitHub Copilot models',
    );
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await click('Not now');
    expect(target.textContent).not.toContain('enables the policies');
    buttons()
      .filter((item) => item.textContent?.trim() === 'Log in')[1]!
      .click();
    await flush();
    await click('I agree, log in');
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      providerId: 'github-copilot',
      policyConsent: true,
    });
    expect(
      calls.every((call) => call.init.cache === 'no-store' && call.init.credentials === 'include'),
    ).toBe(true);
  });

  it('renders simultaneous auth URL, text/manual/select prompts by ID, with plain instructions and no storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    auth.prompts = [
      { id: 'enterprise', kind: 'prompt', message: 'Enterprise domain', allowEmpty: true },
      { id: 'manual', kind: 'manual', message: 'Paste redirect URL' },
      {
        id: 'choice',
        kind: 'select',
        message: 'Choose account',
        options: [{ id: 'a', label: 'Account A' }],
      },
    ];
    settings.oauthProviders[0]!.usesCallbackServer = false;
    await setup();
    await click('Log in');
    expect(target.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(target.querySelector('script')).toBeNull();
    expect(target.textContent).toContain('<script>not HTML</script>');
    expect(field('Paste redirect URL').type).toBe('password');
    expect(target.querySelectorAll('form')).toHaveLength(3);
    await input('Paste redirect URL', 'http://localhost:1455/auth/callback?code=secret&state=test');
    field('Paste redirect URL')
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.find((call) => call.url.endsWith('/input'))?.body).toEqual({
      promptId: 'manual',
      value: 'http://localhost:1455/auth/callback?code=secret&state=test',
    });
    expect(field('Paste redirect URL').value).toBe('');
    expect(target.textContent).not.toContain('code=secret');
    expect(storage).not.toHaveBeenCalled();
    await click('Skip selection');
    expect(calls.filter((call) => call.url.endsWith('/input')).slice(-1)[0]?.body).toEqual({
      promptId: 'choice',
    });
  });

  it('polls completion, refreshes empty settings and model list, and stops polling', async () => {
    await setup();
    await click('Log in');
    auth = { ...auth, status: 'succeeded', prompts: [] };
    settings = {
      providers: [],
      oauthProviders: [{ ...settings.oauthProviders[0]!, connected: true }],
    };
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(target.textContent).toContain('Connected. 2 models are now available.');
    expect(target.textContent).not.toContain('Baseline');
    expect(button('Reconnect')).toBeDefined();
    expect(changed).toHaveBeenCalledTimes(1);
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(calls).toHaveLength(count);
    // The confirmation fades; the card keeps showing the account as connected.
    expect(target.textContent).not.toContain('models are now available');
    expect(target.textContent).toContain('Connected');
  });

  it('cancels on unmount and ignores a stale polling response', async () => {
    await setup();
    await click('Log in');
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await unmount(component!);
    component = undefined;
    expect(calls.slice(-1)[0]?.method).toBe('DELETE');
    resolve(response({ ...auth, status: 'succeeded' }));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it('cancels a login whose creation resolves after closing settings', async () => {
    await setup();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await click('Log in');
    await unmount(component!);
    component = undefined;
    resolve(response(auth));
    await flush();
    expect(calls.slice(-1)[0]?.method).toBe('DELETE');
    expect(changed).not.toHaveBeenCalled();
  });

  it('expires pending login locally and cancels it even when polling stalls', async () => {
    auth.expiresAt = Date.now() + 2000;
    await setup();
    await click('Log in');
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(target.textContent).toContain('The login timed out');
    expect(button('Try again')).toBeDefined();
    expect(calls.slice(-1)[0]?.method).toBe('DELETE');
  });

  it('does not turn unsafe authorization URLs into links or expose raw error bodies', async () => {
    auth.auth = { url: 'javascript:alert(1)' };
    await setup();
    await click('Log in');
    expect(target.querySelector('a')).toBeNull();
    await click('Cancel login');
    fetchMock.mockResolvedValueOnce(
      response({ error: { message: 'access_token=TOPSECRET' } }, 400),
    );
    await click('Log in');
    expect(target.textContent).toContain('Backend request failed (400)');
    expect(target.textContent).not.toContain('TOPSECRET');
    // Curated gateway guidance is shown so the user knows what to fix.
    fetchMock.mockResolvedValueOnce(
      response(
        {
          error: {
            message:
              'Paste the complete expected localhost callback URL with matching authorization state',
          },
        },
        400,
      ),
    );
    await click('Log in');
    expect(target.textContent).toContain('Paste the complete expected localhost callback URL');
  });

  it('adds a no-key local endpoint and edits metadata without echoing or replacing saved keys', async () => {
    await setup();
    await click('Add backend');
    await input('Backend ID', 'local');
    await input('Base URL', 'http://localhost:11434/v1');
    expect(button('Save backend').disabled).toBe(true);
    await input('Model ID', 'model-one');
    await click('Add model');
    expect(field('Model ID').value).toBe('');
    const go = Array.from(target.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('OpenCode Go compatibility'))!
      .querySelector<HTMLInputElement>('input')!;
    go.click();
    await tick();
    await click('Save backend');
    const created = calls.find((call) => call.method === 'POST' && call.url === '/api/providers');
    expect(created?.body.preset).toBeUndefined();
    expect(created?.body).toMatchObject({
      id: 'local',
      opencodeGo: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'model-one' }],
    });
    expect(changed).toHaveBeenCalledTimes(1);
    settings.providers.push({
      id: 'custom',
      name: 'Custom',
      opencodeGo: true,
      source: 'ui',
      readOnly: false,
      api: 'openai-responses',
      hasApiKey: true,
      baseUrl: 'https://api.example/v1',
      models: [{ id: 'one', canonicalProvider: 'uneditable', api: 'openai-responses' }],
    });
    await click('Save default');
    await click('Edit custom');
    expect(field('API key (optional)').value).toBe('');
    await input('Display name', 'Renamed');
    await click('Save backend');
    const update = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/custom'))!;
    expect(update.body.apiKey).toBeUndefined();
    expect(update.body.opencodeGo).toBe(true);
    expect(update.body.models).toEqual([expect.objectContaining({ id: 'one', name: 'Renamed' })]);
    // Gateway-derived metadata is never sent back as editable input.
    expect(update.body.models[0]).not.toHaveProperty('canonicalProvider');
    expect(update.body.models[0]).not.toHaveProperty('api');
    await click('Remove custom');
    expect(calls.slice(-1)[0]?.method).toBe('DELETE');
  });

  it('clears submitted API key form values on failure and supports explicit key removal', async () => {
    settings.providers.push({
      id: 'custom',
      name: 'Custom',
      source: 'ui',
      readOnly: false,
      api: 'openai-responses',
      hasApiKey: true,
      baseUrl: 'https://api.example/v1',
      models: [{ id: 'one' }],
    });
    await setup();
    await click('Edit custom');
    await input('API key (optional)', 'secret-input');
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'secret-input' } }, 400));
    await click('Save backend');
    expect(field('API key (optional)').value).toBe('');
    expect(target.textContent).not.toContain('secret-input');
    (field('Remove the saved API key') as HTMLInputElement).click();
    await flush();
    await click('Save backend');
    expect(calls.filter((call) => call.method === 'PUT').slice(-1)[0]?.body.apiKey).toBe('');
  });

  it('saves selected defaults and logs out local credentials with catalog refresh', async () => {
    settings.oauthProviders[0].connected = true;
    await setup();
    await input('Gateway default', JSON.stringify(['baseline', 'base-model']));
    await click('Save default');
    expect(calls.slice(-1)[0]?.body).toEqual({ provider: 'baseline', id: 'base-model' });
    await click('Log out Future registry provider');
    expect(calls.slice(-1)[0]?.url).toBe('/api/providers/oauth%3Afuture-provider');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('sets up a backend from a service preset by picking catalog models', async () => {
    settings.providers.push({
      id: 'openai',
      name: 'openai',
      source: 'ui',
      readOnly: false,
      api: 'openai-completions',
      hasApiKey: false,
      models: [{ id: 'other' }],
    });
    await setup();
    await click('Add backend');
    expect(button('Add backend')).toBeUndefined();
    await input('Service', 'openai');
    // The preset fills the endpoint and suggests a free backend ID.
    expect(field('Backend ID').value).toBe('openai-2');
    expect(field('Base URL').value).toBe('https://api.openai.example/v1');
    expect(field('API').value).toBe('openai-responses');
    expect(field('API').disabled).toBe(true);
    expect(target.textContent).not.toContain('OpenCode Go compatibility');
    expect(target.textContent).toContain('400K context · 128K output · reasoning');
    const filter = target.querySelector<HTMLInputElement>('input[aria-label="Filter models"]')!;
    filter.value = 'mini';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(target.querySelectorAll('ul[aria-label="Available models"] li')).toHaveLength(1);
    await click('Select shown');
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    field('GPT X').click();
    await flush();
    await input('API key (optional)', 'sk-typed');
    await click('Save backend');
    const created = calls.find((call) => call.method === 'POST' && call.url === '/api/providers')!;
    expect(created.body).toEqual({
      id: 'openai-2',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.example/v1',
      opencodeGo: false,
      apiKey: 'sk-typed',
      preset: 'openai',
      models: [
        { id: 'gpt-mini', name: 'GPT Mini', contextWindow: 128_000, maxTokens: 16_000 },
        {
          id: 'gpt-x',
          name: 'GPT X',
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
      ],
    });
  });

  it('switching to a local server preset clears catalog choices and suggests no key', async () => {
    await setup();
    await click('Add backend');
    await input('Service', 'openai');
    field('GPT X').click();
    await flush();
    await input('Service', 'ollama');
    expect(field('Backend ID').value).toBe('ollama');
    expect(field('Base URL').value).toBe('http://localhost:11434/v1');
    expect((field('API key (optional)') as HTMLInputElement).placeholder).toBe(
      'Not needed for a local server',
    );
    expect(target.querySelector('ul[aria-label="Selected models"]')).toBeNull();
    expect(field('GPT X')).toBeUndefined();
  });

  it('fetches the endpoint model list with the typed or saved key', async () => {
    discovered = [
      { id: 'llama3', known: false },
      { id: 'qwen3:8b', known: false, contextWindow: 32_768 },
    ];
    settings.providers.push({
      id: 'custom',
      name: 'Custom',
      source: 'ui',
      readOnly: false,
      api: 'openai-completions',
      hasApiKey: true,
      baseUrl: 'https://api.example/v1',
      models: [{ id: 'one' }],
    });
    await setup();
    await click('Edit custom');
    await click('Fetch models from endpoint');
    const probe = calls.find((call) => call.url === '/api/providers/discover')!;
    expect(probe.body).toEqual({
      api: 'openai-completions',
      baseUrl: 'https://api.example/v1',
      opencodeGo: false,
      backendId: 'custom',
    });
    expect(target.textContent).toContain('Found 2 models. Select the ones to use.');
    field('qwen3:8b').click();
    await flush();
    await input('API key (optional)', 'sk-new');
    fetchMock.mockResolvedValueOnce(
      response(
        { error: { message: 'The endpoint rejected the API key (HTTP 401). Check it.' } },
        502,
      ),
    );
    await click('Fetch models from endpoint');
    const retry = JSON.parse(String(fetchMock.mock.calls.slice(-1)[0]![1].body));
    expect(retry).toMatchObject({ apiKey: 'sk-new' });
    expect(retry).not.toHaveProperty('backendId');
    expect(target.textContent).toContain('The endpoint rejected the API key (HTTP 401)');
    expect(field('API key (optional)').value).toBe('sk-new');
    await click('Save backend');
    const update = calls.find((call) => call.method === 'PUT')!;
    expect(update.body.models).toEqual([{ id: 'one' }, { id: 'qwen3:8b', contextWindow: 32_768 }]);
  });

  it('tests the unsaved form against the chosen model and shows only safe errors', async () => {
    await setup();
    await click('Add backend');
    await input('Backend ID', 'lan');
    await input('Base URL', 'http://10.0.0.2:8000/v1');
    for (const id of ['a', 'b']) {
      await input('Model ID', id);
      await click('Add model');
    }
    await input('Test with', 'b');
    await click('Test connection');
    expect(calls.find((call) => call.url === '/api/providers/test')?.body).toEqual({
      api: 'openai-completions',
      baseUrl: 'http://10.0.0.2:8000/v1',
      opencodeGo: false,
      apiKey: '',
      model: { id: 'b' },
    });
    expect(target.textContent).toContain('Connected. m answered in 12 ms.');
    // Editing the form makes the result stale.
    await input('Base URL', 'http://10.0.0.3:8000/v1');
    expect(target.textContent).not.toContain('Connected.');
    tested = { ok: false, message: 'upstream said access_token=LEAK', latencyMs: 3 };
    await click('Test connection');
    expect(target.textContent).toContain('The connection test failed.');
    expect(target.textContent).not.toContain('LEAK');
    tested = { ok: false, message: 'Model request failed (HTTP 401)', latencyMs: 3 };
    await click('Test connection');
    expect(target.textContent).toContain('Model request failed (HTTP 401)');
  });

  it('shows a device code to copy inside the provider card', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    auth = {
      ...auth,
      providerId: 'github-copilot',
      auth: {
        url: 'https://github.com/login/device',
        instructions: 'Enter code: AB12-CD34',
        userCode: 'AB12-CD34',
      },
    };
    await setup();
    buttons()
      .filter((item) => item.textContent?.trim() === 'Log in')[1]!
      .click();
    await flush();
    await click('I agree, log in');
    const card = target.querySelector('[aria-label="Provider login"]')!;
    expect(card.closest('.backend-card')?.textContent).toContain('GitHub Copilot');
    expect(card.querySelector('code')?.textContent).toBe('AB12-CD34');
    // The code is not repeated in the provider's raw instructions.
    expect(card.textContent).not.toContain('Enter code');
    await click('Copy code');
    expect(writeText).toHaveBeenCalledWith('AB12-CD34');
    expect(button('Copied')).toBeDefined();
    await click('Copy link');
    expect(writeText).toHaveBeenLastCalledWith('https://github.com/login/device');
    // Only the active provider's login button is replaced; others wait for it.
    expect(button('Log in')?.disabled).toBe(true);
    await click('Cancel login');
    expect(target.querySelector('[aria-label="Provider login"]')).toBeNull();
  });

  it('never reads or mutates real settings in demo mode', async () => {
    await setup(true);
    expect(target.textContent).toContain('unavailable in demo mode');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buttons()).toHaveLength(0);
  });
});
