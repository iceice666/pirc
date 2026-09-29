/**
 * Push notifications on this browser (plans/cron.md, phase 4): scheduled
 * runs, sessions waiting for you, delegations and memory proposals. The
 * gateway encrypts each message for this browser's subscription; the
 * service worker (`public/sw.js`) shows it and opens what it points at.
 */
import { request } from './http';

export interface PushPlace {
  id: string;
  kind: 'web' | 'unifiedpush';
  name: string;
  host: string;
  createdAt: number;
  lastSuccessAt: number | null;
  failing: boolean;
}

/** What a notification opens (the `target` of a push). */
export type PushTarget =
  | { sessionId: string }
  | { schedules: true; scheduleId?: string }
  | { memory: true };

export type PushState =
  /** No service worker or Push API (an older browser, plain http, dev mode). */
  | 'unsupported'
  /** The user blocked notifications for this site. */
  | 'denied'
  | 'off'
  | 'on';

const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });

export const pushApi = {
  info: () => noStore<{ publicKey: string; subscriptions: PushPlace[] }>('/api/push'),
  remove: (ref: { endpoint?: string; id?: string }) =>
    noStore<void>('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify(ref) }),
  test: () => noStore<{ delivered: number }>('/api/push/test', { method: 'POST', body: '{}' }),
};

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!supported()) return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

/** Whether this browser gets notifications now. */
export async function pushState(): Promise<PushState> {
  const worker = await registration();
  if (!worker) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await worker.pushManager.getSubscription()) ? 'on' : 'off';
}

/** The gateway's id for this browser's subscription, to tell it apart in the list. */
const HERE_KEY = 'pirc.push.subscription';
export function currentSubscriptionId(): string | undefined {
  try {
    return localStorage.getItem(HERE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function remember(id: string | undefined) {
  try {
    if (id) localStorage.setItem(HERE_KEY, id);
    else localStorage.removeItem(HERE_KEY);
  } catch {
    /* private mode: the list just does not mark this browser */
  }
}

const base64Url = (value: string) => {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

function browserName(): string {
  const agent = navigator.userAgent;
  const browser = /Firefox\//.test(agent)
    ? 'Firefox'
    : /Edg\//.test(agent)
      ? 'Edge'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}

/**
 * Ask for permission (needs a click), subscribe with the gateway's key and
 * register the subscription. Returns the resulting state.
 */
export async function enablePush(): Promise<PushState> {
  const worker = await registration();
  if (!worker) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'off';
  const { publicKey } = await pushApi.info();
  let subscription = await worker.pushManager.getSubscription();
  // A subscription made with another key (the gateway's keys changed) cannot be used.
  const key = subscription?.options.applicationServerKey;
  if (
    subscription &&
    key &&
    btoa(String.fromCharCode(...new Uint8Array(key))) !==
      btoa(String.fromCharCode(...base64Url(publicKey)))
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64Url(publicKey),
  });
  const json = subscription.toJSON();
  const saved = await noStore<{ subscription: PushPlace }>('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      kind: 'web',
      name: browserName(),
    }),
  });
  remember(saved.subscription.id);
  return 'on';
}

/** Stop notifications on this browser, here and at the gateway. */
export async function disablePush(): Promise<PushState> {
  const worker = await registration();
  if (!worker) return 'unsupported';
  const subscription = await worker.pushManager.getSubscription();
  if (subscription) {
    await pushApi.remove({ endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  remember(undefined);
  return 'off';
}

/** Where a notification (or a `?session=` / `?open=` link) leads, from a URL. */
export function targetFromUrl(url: URL): PushTarget | undefined {
  const session = url.searchParams.get('session');
  if (session) return { sessionId: session };
  const open = url.searchParams.get('open');
  if (open === 'schedules') {
    const schedule = url.searchParams.get('schedule');
    return schedule ? { schedules: true, scheduleId: schedule } : { schedules: true };
  }
  if (open === 'memory') return { memory: true };
  return undefined;
}
