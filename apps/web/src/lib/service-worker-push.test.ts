import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function serviceWorkerHarness(
  harnessOptions: { showGate?: Promise<void>; noClients?: boolean; page?: string } = {},
) {
  const navigated: string[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const records = new Map<string, Response>();
  const shown: Array<{ title: string; options: any; closed: boolean; close(): void }> = [];
  const messages: any[] = [];
  let showStarted!: () => void;
  const notificationShowStarted = new Promise<void>((resolve) => (showStarted = resolve));
  const pageClient = {
    url: `https://pirc.test${harnessOptions.page ?? '/'}`,
    focused: false,
    async navigate(url: string) {
      navigated.push(url);
    },
    visibilityState: 'hidden',
    async focus() {
      this.focused = true;
    },
    postMessage: (message: any) => messages.push(message),
  };
  const cache = {
    async match(key: string | Request) {
      return records.get(typeof key === 'string' ? key : key.url)?.clone();
    },
    async put(key: string | Request, response: Response) {
      records.set(typeof key === 'string' ? key : key.url, response.clone());
    },
    async keys() {
      return [...records.keys()].map((key) => new Request(key));
    },
    async delete(key: string | Request) {
      return records.delete(typeof key === 'string' ? key : key.url);
    },
  };
  const clients = {
    async matchAll() {
      return harnessOptions.noClients ? [] : [pageClient];
    },
    async openWindow(url: string) {
      openedWindows.push(url);
      return undefined;
    },
  };
  const openedWindows: string[] = [];
  const self = {
    location: { origin: 'https://pirc.test' },
    clients,
    registration: {
      async showNotification(title: string, notificationOptions: any) {
        showStarted();
        if (harnessOptions.showGate) await harnessOptions.showGate;
        const notification = {
          title,
          options: notificationOptions,
          data: notificationOptions.data,
          closed: false,
          close() {
            this.closed = true;
          },
        };
        shown.push(notification);
      },
      async getNotifications({ tag }: { tag: string }) {
        return shown.filter(
          (notification) => !notification.closed && notification.options.tag === tag,
        );
      },
    },
    addEventListener(name: string, handler: (event: any) => void) {
      listeners.set(name, handler);
    },
    skipWaiting() {},
  };
  const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    self,
    caches: {
      async open() {
        return cache;
      },
      async keys() {
        return [];
      },
      async delete() {},
    },
    Request,
    Response,
    URL,
    TextEncoder,
    Date,
    Number,
    Promise,
    Array,
    JSON,
    Math,
    RegExp,
    String,
    Error,
    fetch: async () => new Response(''),
  });

  return {
    shown,
    messages,
    openedWindows,
    navigated,
    notificationShowStarted,
    async push(message: unknown) {
      await this.startPush(message);
    },
    startPush(message: unknown) {
      let pending: Promise<void> | undefined;
      listeners.get('push')!({
        data: { json: () => message },
        waitUntil(promise: Promise<void>) {
          pending = promise;
        },
      });
      return pending;
    },
    async clickNotification(data: unknown) {
      let pending: Promise<void> | undefined;
      listeners.get('notificationclick')!({
        notification: { data, close() {} },
        waitUntil(promise: Promise<void>) {
          pending = promise;
        },
      });
      await pending;
    },
  };
}

const tuple = {
  sessionId: 'session:one',
  interactionId: 'ask:q1:0',
  interactionEpoch: '0',
};

it('keeps a late created push suppressed after its exact revocation arrived first', async () => {
  const worker = serviceWorkerHarness();
  await worker.push({ kind: 'interaction_answered', ...tuple, title: '', body: '' });
  await worker.push({
    kind: 'interaction_created',
    ...tuple,
    title: 'Continue?',
    body: 'The agent asks',
  });

  expect(worker.shown).toEqual([]);
});

it('closes only the notification for the answered tuple and never shows a revoke', async () => {
  const worker = serviceWorkerHarness();
  const other = { ...tuple, interactionId: 'ask:q2:0' };
  await worker.push({ kind: 'interaction_created', ...tuple, title: 'Question one' });
  await worker.push({ kind: 'interaction_created', ...other, title: 'Question two' });
  await worker.push({ kind: 'interaction_answered', ...tuple, title: '', body: '' });

  expect(worker.shown).toHaveLength(2);
  expect(worker.shown[0]!.closed).toBe(true);
  expect(worker.shown[1]!.closed).toBe(false);
});

it('turns a session refresh hint into an app refresh message without a notification', async () => {
  const worker = serviceWorkerHarness();
  await worker.push({
    kind: 'interaction_refresh',
    sessionId: tuple.sessionId,
    title: '',
    body: '',
  });

  expect(worker.shown).toEqual([]);
  expect(worker.messages).toEqual([{ type: 'INTERACTION_REFRESH', sessionId: tuple.sessionId }]);
});

it('serializes a revoke that arrives while the created notification is being shown', async () => {
  const showGate = deferred<void>();
  const worker = serviceWorkerHarness({ showGate: showGate.promise });
  const creating = worker.startPush({
    kind: 'interaction_created',
    ...tuple,
    title: 'Continue?',
  });
  await worker.notificationShowStarted;
  const answering = worker.startPush({
    kind: 'interaction_answered',
    ...tuple,
    title: '',
    body: '',
  });

  expect(worker.shown).toEqual([]);
  showGate.resolve();
  await Promise.all([creating, answering]);

  expect(worker.shown).toHaveLength(1);
  expect(worker.shown[0]!.closed).toBe(true);
});

it('forwards the exact interaction identity when its notification is clicked', async () => {
  const worker = serviceWorkerHarness({ page: '/engine?session=other' });
  await worker.push({ kind: 'interaction_created', ...tuple, title: 'Continue?' });
  const data = worker.shown[0]!.options.data;

  await worker.clickNotification(data);

  expect(worker.messages).toEqual([
    { type: 'OPEN_TARGET', target: { sessionId: tuple.sessionId }, interaction: tuple },
  ]);
});

it('keeps the exact interaction tuple in the URL when a click opens a new window', async () => {
  const worker = serviceWorkerHarness({ noClients: true });
  await worker.push({ kind: 'interaction_created', ...tuple, title: 'Continue?' });
  const data = worker.shown[0]!.options.data;

  await worker.clickNotification(data);

  expect(worker.openedWindows).toEqual([
    '/engine?session=session%3Aone&interactionId=ask%3Aq1%3A0&interactionEpoch=0',
  ]);
});

it('moves an open window to the page the notification is about', async () => {
  // A session's question while the rooms are open: the window goes to the engine.
  const rooms = serviceWorkerHarness({ page: '/?room=general' });
  await rooms.push({ kind: 'interaction_created', ...tuple, title: 'Continue?' });
  await rooms.clickNotification(rooms.shown[0]!.options.data);
  expect(rooms.messages).toEqual([]);
  expect(rooms.navigated).toEqual([
    '/engine?session=session%3Aone&interactionId=ask%3Aq1%3A0&interactionEpoch=0',
  ]);

  // A room's message while the engine is open: back to the rooms.
  const engine = serviceWorkerHarness({ page: '/engine' });
  await engine.clickNotification({ target: { roomId: 'room_1' } });
  expect(engine.navigated).toEqual(['/?room=room_1']);

  // The rooms already open: they switch rooms themselves.
  const open = serviceWorkerHarness({ page: '/' });
  await open.clickNotification({ target: { roomId: 'room_1' } });
  expect(open.messages).toEqual([
    { type: 'OPEN_TARGET', target: { roomId: 'room_1' }, interaction: undefined },
  ]);
  expect(open.navigated).toEqual([]);

  const fresh = serviceWorkerHarness({ noClients: true });
  await fresh.clickNotification({ target: { memory: true } });
  expect(fresh.openedWindows).toEqual(['/engine?open=memory']);
});
