import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { GatewayDatabase } from '../src/database.js';
import { loadVapidKeys, Push, watchInteractions } from '../src/daemon/push.js';
import { EventHub } from '../src/events.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** A browser's push subscription keys, and a way to read what it is sent (RFC 8291). */
function subscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') },
    decrypt(body: Buffer): any {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const serverKey = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(serverKey);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
      const decipher = createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(ciphertext.subarray(-16));
      const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
      // The last record ends with the 0x02 delimiter, then padding.
      return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
    },
  };
}

/** A push service on loopback that records what it receives and answers `status`. */
function pushService() {
  const received: Array<{ path: string; headers: Headers; body: Buffer }> = [];
  let status = 201;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: Buffer.from(await request.arrayBuffer()),
      });
      return new Response(null, { status });
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    received,
    url: (name: string) => `http://127.0.0.1:${server.port}/${name}`,
    answer: (next: number) => (status = next),
  };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-push-'));
  const db = new GatewayDatabase(path.join(dir, 'gateway.db'));
  cleanup.push(() => db.close());
  const warnings: string[] = [];
  const push = new Push({
    db,
    vapid: loadVapidKeys(dir, {}),
    subject: 'mailto:ops@example.com',
    allowInsecureEndpoints: true,
    warn: (message) => warnings.push(message),
  });
  return { dir, db, push, warnings };
}

it('keeps one VAPID key pair in the state directory, or takes it from the environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-vapid-'));
  const first = loadVapidKeys(dir, {});
  expect(loadVapidKeys(dir, {})).toEqual(first);
  expect(statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path.join(dir, 'vapid.json'), 'utf8')).publicKey).toBe(
    first.publicKey,
  );
  expect(
    loadVapidKeys(dir, { PIRC_VAPID_PUBLIC_KEY: 'pub', PIRC_VAPID_PRIVATE_KEY: 'priv' }),
  ).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  expect(() => loadVapidKeys(dir, { PIRC_VAPID_PUBLIC_KEY: 'pub' })).toThrow('both');
});

it('sends encrypted, signed notifications that only the subscriber can read', async () => {
  const { push } = setup();
  const service = pushService();
  const browser = subscriber();
  push.subscribe('me', { endpoint: service.url('me'), keys: browser.keys, kind: 'web' }, null);

  expect(
    await push.notify('me', {
      title: 'CI check failed',
      body: 'Scheduled run: open it to read the result.',
      tag: 'session:s1',
      target: { sessionId: 's1' },
    }),
  ).toBe(1);
  const [delivery] = service.received;
  expect(delivery!.headers.get('content-encoding')).toBe('aes128gcm');
  expect(delivery!.headers.get('ttl')).toBe('86400');
  expect(delivery!.headers.get('topic')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  expect(delivery!.headers.get('authorization')).toMatch(/^vapid t=.+, k=.+$/);
  // Nothing readable on the wire.
  expect(delivery!.body.toString('latin1')).not.toContain('CI check');
  expect(browser.decrypt(delivery!.body)).toMatchObject({
    title: 'CI check failed',
    tag: 'session:s1',
    target: { sessionId: 's1' },
  });

  // Nobody else's notifications.
  expect(
    await push.notify('someone-else', {
      title: 'x',
      body: 'y',
      tag: 't',
      target: { memory: true },
    }),
  ).toBe(0);
  expect(service.received).toHaveLength(1);
});

it('lists, refreshes and removes subscriptions, and drops dead ones', async () => {
  const { push, db, warnings } = setup();
  const service = pushService();
  const browser = subscriber();
  expect(() =>
    new Push({
      db,
      vapid: loadVapidKeys(mkdtempSync(path.join(tmpdir(), 'v-')), {}),
      subject: 'mailto:a@b.c',
      warn() {},
    }).subscribe(
      'me',
      { endpoint: 'http://push.example/x', keys: browser.keys, kind: 'web' },
      null,
    ),
  ).toThrow('https');

  const first = push.subscribe(
    'me',
    { endpoint: service.url('a'), keys: browser.keys, kind: 'web', name: 'Firefox' },
    null,
  );
  // The same endpoint again refreshes it rather than adding one.
  expect(
    push.subscribe(
      'me',
      { endpoint: service.url('a'), keys: browser.keys, kind: 'web', name: 'Firefox' },
      null,
    ).id,
  ).toBe(first.id);
  push.subscribe(
    'me',
    { endpoint: service.url('b'), keys: subscriber().keys, kind: 'unifiedpush', name: 'Pixel' },
    null,
  );
  expect(push.list('me').map((item) => [item.kind, item.name])).toEqual([
    ['web', 'Firefox'],
    ['unifiedpush', 'Pixel'],
  ]);

  // The push service says the subscription is gone: it goes here too.
  service.answer(410);
  expect(
    await push.notify('me', { title: 't', body: 'b', tag: 'x', target: { memory: true } }),
  ).toBe(0);
  expect(push.list('me')).toEqual([]);

  // A failing service is counted and logged, not thrown.
  push.subscribe('me', { endpoint: service.url('c'), keys: browser.keys, kind: 'web' }, null);
  service.answer(500);
  expect(
    await push.notify('me', { title: 't', body: 'b', tag: 'x', target: { memory: true } }),
  ).toBe(0);
  expect(push.list('me')[0]!.failing).toBe(true);
  expect(warnings.at(-1)).toContain('push to 127.0.0.1');

  expect(push.unsubscribe('me', { endpoint: service.url('c') })).toBe(true);
  expect(push.list('me')).toEqual([]);
});

it('drops a phone subscription with its device token', () => {
  const { push, db } = setup();
  db.raw
    .prepare(
      "INSERT INTO device_tokens (id, owner_user, name, token_hash, created_at, expires_at, last_used_at) VALUES ('dev1','me','Pixel','h',1,9999999999999,1)",
    )
    .run();
  push.subscribe(
    'me',
    { endpoint: 'http://127.0.0.1:1/p', keys: subscriber().keys, kind: 'unifiedpush' },
    'dev1',
  );
  expect(push.list('me')).toHaveLength(1);
  db.raw.prepare("DELETE FROM device_tokens WHERE id='dev1'").run();
  expect(push.list('me')).toEqual([]);
});

it('pushes when a session starts waiting for its user', async () => {
  const { push, db } = setup();
  const service = pushService();
  const browser = subscriber();
  push.subscribe('me', { endpoint: service.url('me'), keys: browser.keys, kind: 'web' }, null);
  db.syncRemoteWorkspaces('work', [{ id: 'pirc', displayName: 'pirc', kind: 'directory' } as any]);
  const session = db.createSession('work:pirc', 'node://work/r1', 'work', 'r1', 'me');
  const events = new EventHub(100);
  cleanup.push(
    watchInteractions({ db, push, subscribeAll: (listener) => events.subscribeAll(listener) }),
  );

  events.publish(session.id, 0, 'interaction_created', {
    id: 'i1',
    request: { title: 'Allow rm -rf build?' },
  });
  events.publish(session.id, 0, 'interaction_answered', { interactionId: 'i1' });
  for (let i = 0; i < 50 && !service.received.length; i++) await Bun.sleep(20);
  expect(service.received).toHaveLength(1);
  expect(browser.decrypt(service.received[0]!.body)).toMatchObject({
    title: `${session.name} is waiting for you`,
    body: 'Allow rm -rf build?',
    tag: `session:${session.id}`,
    target: { sessionId: session.id },
  });
});
