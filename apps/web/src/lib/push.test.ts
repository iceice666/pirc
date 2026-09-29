// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.svelte';
import { currentSubscriptionId, disablePush, enablePush, pushState, targetFromUrl } from './push';

const response = (value: unknown, status = 200) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status });
// The gateway's VAPID key: 65 bytes, base64url.
const PUBLIC_KEY = 'B' + 'A'.repeat(86);

let calls: Array<{ url: string; method: string; body: any }>;
let permission: NotificationPermission;
let subscription: any;

function fakeSubscription() {
  return {
    endpoint: 'https://push.example/abc',
    options: { applicationServerKey: null },
    toJSON: () => ({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) },
    }),
    unsubscribe: vi.fn(async () => {
      subscription = null;
      return true;
    }),
  };
}

beforeEach(() => {
  calls = [];
  permission = 'default';
  subscription = null;
  localStorage.clear();
  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async (options: any) => {
      expect(options.userVisibleOnly).toBe(true);
      expect(options.applicationServerKey).toBeInstanceOf(Uint8Array);
      subscription = fakeSubscription();
      return subscription;
    }),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }) },
  });
  vi.stubGlobal('PushManager', class {});
  const FakeNotification = class {};
  Object.defineProperty(FakeNotification, 'permission', { get: () => permission });
  Object.defineProperty(FakeNotification, 'requestPermission', {
    configurable: true,
    writable: true,
    value: vi.fn(async () => (permission = 'granted')),
  });
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/push') return response({ publicKey: PUBLIC_KEY, subscriptions: [] });
      if (method === 'POST') return response({ subscription: { id: 'push_1' } }, 201);
      return response(undefined, 204);
    }),
  );
});

afterEach(() => {
  delete (navigator as any).serviceWorker;
  vi.unstubAllGlobals();
});

describe('push on this browser', () => {
  it('subscribes with the gateway key after asking, and remembers which one is here', async () => {
    expect(await pushState()).toBe('off');
    expect(await enablePush()).toBe('on');
    const saved = calls.find((call) => call.method === 'POST')!;
    expect(saved.url).toBe('/api/push/subscriptions');
    expect(saved.body).toMatchObject({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) },
      kind: 'web',
    });
    expect(currentSubscriptionId()).toBe('push_1');
    expect(await pushState()).toBe('on');

    expect(await disablePush()).toBe('off');
    expect(calls[calls.length - 1]).toMatchObject({
      url: '/api/push/subscriptions',
      method: 'DELETE',
      body: { endpoint: 'https://push.example/abc' },
    });
    expect(currentSubscriptionId()).toBeUndefined();
  });

  it('says so when the user blocks notifications, or the browser cannot push', async () => {
    permission = 'denied';
    expect(await pushState()).toBe('denied');
    (Notification as any).requestPermission = async () => 'denied';
    expect(await enablePush()).toBe('denied');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    delete (navigator as any).serviceWorker;
    expect(await pushState()).toBe('unsupported');
  });
});

describe('where a notification leads', () => {
  it('reads targets from links', () => {
    const at = (query: string) => targetFromUrl(new URL(`https://pirc.example/${query}`));
    expect(at('?session=s%201')).toEqual({ sessionId: 's 1' });
    expect(at('?open=schedules&schedule=s1')).toEqual({ schedules: true, scheduleId: 's1' });
    expect(at('?open=schedules')).toEqual({ schedules: true });
    expect(at('?open=memory')).toEqual({ memory: true });
    expect(at('')).toBeUndefined();
  });

  it('shows the schedules page, focused on the one it was about', async () => {
    app.demo = undefined;
    await app.openTarget({ schedules: true, scheduleId: 's9' });
    expect(app.view).toBe('schedules');
    expect(app.requestedTarget).toBeUndefined();
    expect(app.scheduleFocus).toBe('s9');
    app.view = 'session';
    app.scheduleFocus = undefined;
  });

  it('opens the memory in Settings', async () => {
    app.demo = undefined;
    await app.openTarget({ memory: true });
    expect(app.requestedTarget).toEqual({ memory: true });
    app.requestedTarget = undefined;
  });
});
