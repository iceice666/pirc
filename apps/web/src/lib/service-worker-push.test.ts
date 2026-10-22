import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function serviceWorkerHarness(
  harnessOptions: {
    noClients?: boolean;
    page?: string;
    /** The page is in front, being looked at. */
    looking?: boolean;
  } = {},
) {
  const navigated: string[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const records = new Map<string, Response>();
  const shown: Array<{ title: string; options: any; closed: boolean; close(): void }> = [];
  const messages: any[] = [];
  const pageClient = {
    url: `https://pirc.test${harnessOptions.page ?? '/'}`,
    focused: !!harnessOptions.looking,
    async navigate(url: string) {
      navigated.push(url);
    },
    visibilityState: harnessOptions.looking ? 'visible' : 'hidden',
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
    /** Rooms muted on this device, as src/lib/mute.ts copies them. */
    mute(rooms: string[]) {
      records.set('https://pirc.test/__pirc_muted_rooms__', new Response(JSON.stringify(rooms)));
    },
    openedWindows,
    navigated,
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

it('shows nothing for a push without a title', async () => {
  // What gateways before session question notifications were removed sent
  // to take back an answered question's notification.
  const worker = serviceWorkerHarness();
  await worker.push({
    kind: 'interaction_answered',
    sessionId: 'session:one',
    interactionId: 'ask:q1:0',
    interactionEpoch: '0',
    title: '',
    body: '',
  });

  expect(worker.shown).toEqual([]);
  expect(worker.messages).toEqual([]);
});

it('moves an open window to the page the notification is about', async () => {
  // A session's notification while the rooms are open: the window goes to the engine.
  const rooms = serviceWorkerHarness({ page: '/?room=general' });
  await rooms.push({ title: 'Done', tag: 'session:one', target: { sessionId: 'session:one' } });
  await rooms.clickNotification(rooms.shown[0]!.options.data);
  expect(rooms.messages).toEqual([]);
  expect(rooms.navigated).toEqual(['/engine?session=session%3Aone']);

  // A room's message while the engine is open: back to the rooms.
  const engine = serviceWorkerHarness({ page: '/engine' });
  await engine.clickNotification({ target: { roomId: 'room_1' } });
  expect(engine.navigated).toEqual(['/?room=room_1']);

  // The rooms already open: they switch rooms themselves.
  const open = serviceWorkerHarness({ page: '/' });
  await open.clickNotification({ target: { roomId: 'room_1' } });
  expect(open.messages).toEqual([{ type: 'OPEN_TARGET', target: { roomId: 'room_1' } }]);
  expect(open.navigated).toEqual([]);

  const fresh = serviceWorkerHarness({ noClients: true });
  await fresh.clickNotification({ target: { memory: true } });
  expect(fresh.openedWindows).toEqual(['/engine?open=memory']);
});

it('shows a room’s message unless that room is on screen or muted on this device', async () => {
  const room = (roomId: string) => ({
    title: 'pirc',
    body: 'Done.',
    tag: `room:${roomId}`,
    target: { roomId },
  });
  const away = serviceWorkerHarness({ page: '/?room=room_1' });
  await away.push(room('room_1'));
  expect(away.shown.map((item) => item.options.data.target)).toEqual([{ roomId: 'room_1' }]);

  const looking = serviceWorkerHarness({ page: '/?room=room_1', looking: true });
  await looking.push(room('room_1'));
  await looking.push(room('room_2'));
  expect(looking.shown.map((item) => item.options.tag)).toEqual(['room:room_2']);

  // The rooms page without ?room= shows #general.
  const general = serviceWorkerHarness({ page: '/', looking: true });
  await general.push(room('general'));
  expect(general.shown).toEqual([]);

  // The engine on screen is not the room.
  const engine = serviceWorkerHarness({ page: '/engine?room=room_1', looking: true });
  await engine.push(room('room_1'));
  expect(engine.shown).toHaveLength(1);

  const muted = serviceWorkerHarness({ page: '/' });
  muted.mute(['room_1']);
  await muted.push(room('room_1'));
  await muted.push(room('room_2'));
  expect(muted.shown.map((item) => item.options.tag)).toEqual(['room:room_2']);
});
