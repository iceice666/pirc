// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NativeManagementConsent from './NativeManagementConsent.svelte';

const now = Date.now();
let current: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ url: string; method: string }>;
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function flush() {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

const button = (label: string) =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label,
  );

async function click(label: string) {
  button(label)!.click();
  await flush();
}

async function setup(requestId = 'opaque/request?value') {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(NativeManagementConsent, { target, props: { requestId } });
  await flush();
}

beforeEach(() => {
  current = {
    id: 'request-1',
    status: 'pending',
    deviceName: 'Mira’s Pixel',
    capabilities: ['providers', 'devices'],
    expiresAt: now + 5 * 60_000,
    serverNow: now,
  };
  calls = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/approve'))
      current = { ...current, status: 'approved', expiresAt: now + 15 * 60_000 };
    else if (method === 'POST' && url.endsWith('/deny')) current = { ...current, status: 'denied' };
    else if (method === 'DELETE') current = { ...current, status: 'revoked' };
    return response(current);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NativeManagementConsent', () => {
  it('shows the named device and exact scope, then approves and revokes by status', async () => {
    await setup();
    expect(target.querySelector('dialog')?.open).toBe(true);
    expect(target.textContent).toContain('Mira’s Pixel');
    expect(target.textContent).toContain('subscription accounts');
    expect(target.textContent).toContain('saved provider credentials');
    expect(target.textContent).toContain('pair, and revoke connected devices');
    expect(target.textContent).toContain('up to 15 minutes after the device claims it');
    expect(calls).toEqual([
      { url: '/api/native-management/requests/opaque%2Frequest%3Fvalue', method: 'GET' },
    ]);

    await click('Approve for 15 minutes');
    expect(calls.slice(1)).toEqual([
      { url: '/api/native-management/requests/opaque%2Frequest%3Fvalue/approve', method: 'POST' },
      { url: '/api/native-management/requests/opaque%2Frequest%3Fvalue', method: 'GET' },
    ]);
    expect(target.textContent).toContain('Approved. The device can claim temporary access.');
    expect(button('Revoke access')).toBeDefined();

    await click('Revoke access');
    expect(calls.slice(-2)).toEqual([
      { url: '/api/native-management/requests/opaque%2Frequest%3Fvalue', method: 'DELETE' },
      { url: '/api/native-management/requests/opaque%2Frequest%3Fvalue', method: 'GET' },
    ]);
    expect(target.textContent).toContain('Temporary access was revoked.');
    expect(button('Revoke access')).toBeUndefined();
  });

  it('offers revocation after a claim and renders denied requests as terminal', async () => {
    current = {
      ...current,
      status: 'claimed',
      expiresAt: now + 15 * 60_000,
    };
    await setup('claimed-request');
    expect(target.textContent).toContain('has claimed temporary access');
    expect(button('Revoke access')).toBeDefined();

    current = { ...current, status: 'denied' };
    // A status refresh reflects an update from another browser window.
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(target.textContent).toContain('This request was denied.');
    expect(button('Revoke access')).toBeUndefined();
  });

  it('sends an explicit denial and explains expired requests without offering actions', async () => {
    await setup('denied-request');
    await click('Deny');
    expect(calls.some(({ url, method }) => url.endsWith('/deny') && method === 'POST')).toBe(true);
    expect(target.textContent).toContain('This request was denied.');

    current = { ...current, status: 'expired' };
    await unmount(component!);
    component = undefined;
    target.remove();
    await setup('expired-request');
    expect(target.textContent).toContain('This request or temporary access has expired.');
    expect(button('Approve for 15 minutes')).toBeUndefined();
    expect(button('Revoke access')).toBeUndefined();
  });

  it('keeps load failures generic and retries the status check', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: { message: 'bearer=private-token' } }, 503))
      .mockImplementationOnce(async () => response(current));
    await setup('retry-request');
    expect(target.textContent).toContain('Unable to check this request.');
    expect(target.textContent).not.toContain('private-token');
    await click('Retry');
    expect(target.textContent).toContain('Mira’s Pixel');
    expect(button('Approve for 15 minutes')).toBeDefined();
  });

  it('fails closed when the server lists a capability the browser does not explain', async () => {
    current = { ...current, capabilities: ['providers', 'future-management'] };
    await setup('future-scope-request');
    expect(target.textContent).toContain('Unable to check this request.');
    expect(button('Approve for 15 minutes')).toBeUndefined();
    expect(calls.map(({ method }) => method)).toEqual(['GET']);
  });
});
