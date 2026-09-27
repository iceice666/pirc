// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import PairedDevices from './components/PairedDevices.svelte';
import { pairingUri, qrPath, type PairedDevice } from './devices';

const TOKEN = `pirc_dev_${'a'.repeat(43)}`;

describe('pairing link', () => {
  it('carries the gateway origin and token, URL-encoded', () => {
    const uri = pairingUri('https://pirc.example:8443', TOKEN);
    expect(uri.startsWith('pirc://pair?')).toBe(true);
    const params = new URL(uri.replace('pirc://', 'https://')).searchParams;
    expect(params.get('url')).toBe('https://pirc.example:8443');
    expect(params.get('token')).toBe(TOKEN);
  });

  it('renders a square QR path with a quiet zone', () => {
    const { size, path } = qrPath(pairingUri('https://pirc.example', TOKEN));
    expect(size).toBeGreaterThanOrEqual(21 + 8);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    // The border stays light: no module at the origin.
    expect(path).not.toContain('M0 0h');
  });
});

describe('PairedDevices', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let devices: PairedDevice[];
  let calls: Array<{ url: string; method: string; init: RequestInit }>;

  const device = (id: string, name: string): PairedDevice => ({
    id,
    name,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + 7 * 86_400_000,
  });
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      await tick();
    }
  }
  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
    )!;

  beforeEach(() => {
    devices = [device('dev_1', 'Old phone')];
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, init });
        if (method === 'POST') {
          const created = device('dev_2', JSON.parse(String(init.body)).name);
          devices = [created, ...devices];
          return new Response(JSON.stringify({ device: created, token: TOKEN }), { status: 201 });
        }
        if (method === 'DELETE') {
          devices = devices.filter((item) => !url.endsWith(item.id));
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ devices }), { status: 200 });
      }),
    );
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    vi.unstubAllGlobals();
  });

  it('pairs once, shows the token as QR and link, and revokes', async () => {
    component = mount(PairedDevices, { target, props: {} });
    await flush();
    expect(target.textContent).toContain('Old phone');

    const input = target.querySelector('input')!;
    input.value = 'Pixel';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    const pairing = calls.find((call) => call.method === 'POST')!;
    expect(pairing.url).toBe('/api/devices');
    expect(pairing.init.cache).toBe('no-store');
    expect(JSON.parse(String(pairing.init.body))).toEqual({ name: 'Pixel' });
    const link = target.querySelector<HTMLAnchorElement>('a[href^="pirc://pair"]')!;
    expect(link.getAttribute('href')).toContain(TOKEN);
    expect(target.querySelector('svg[aria-label="Pairing QR code"] path')).not.toBeNull();

    // Dismissed, the token is gone for good.
    button('Done').click();
    await flush();
    expect(target.innerHTML).not.toContain(TOKEN);

    button('Revoke Old phone').click();
    await flush();
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url === '/api/devices/dev_1'),
    ).toBe(true);
    expect(target.textContent).not.toContain('Old phone');
    expect(target.textContent).toContain('Pixel');
  });

  it('never calls the gateway in demo mode', async () => {
    component = mount(PairedDevices, { target, props: { disabled: true } });
    await flush();
    expect(calls).toEqual([]);
    expect(target.textContent).toContain('demo mode');
  });
});
