// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import BackendSettings from './BackendSettings.svelte';
import type { BackendSettingsSnapshot, ProviderAuthSession } from '../types';
import { reactiveProps } from '../testing/props.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let settings: BackendSettingsSnapshot;
let auth: ProviderAuthSession;
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
  calls = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, init });
    if (url.startsWith('/api/provider-auth/')) return response(auth);
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
    expect(logins[1].disabled).toBe(true);
    const consent = target.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(consent.checked).toBe(false);
    consent.click();
    await flush();
    logins[1].click();
    await flush();
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
    settings = { providers: [], oauthProviders: [] };
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(target.textContent).toContain('Login complete');
    expect(target.textContent).not.toContain('Baseline');
    expect(changed).toHaveBeenCalledTimes(1);
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(count);
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
    expect(target.textContent).toContain('Login expired');
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
    await input('Model ID', 'model-one');
    const go = Array.from(target.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('OpenCode Go compatibility'))!
      .querySelector<HTMLInputElement>('input')!;
    go.click();
    await tick();
    await click('Save backend');
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
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

  it('never reads or mutates real settings in demo mode', async () => {
    await setup(true);
    expect(target.textContent).toContain('unavailable in demo mode');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buttons()).toHaveLength(0);
  });
});
