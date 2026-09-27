import { afterEach, describe, expect, it } from 'bun:test';
import WebSocket from 'ws';
import { buildDaemonApp } from '../src/daemon/app.js';
import { DeviceTokens } from '../src/daemon/devices.js';
import { GatewayDatabase } from '../src/database.js';
import { daemonConfig, headers, startCluster, type Cluster } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DAY = 86_400_000;
const { 'x-pirc-user': _user, origin: _origin, ...proxyOnly } = headers;
const bearer = (token: string) => ({ ...proxyOnly, authorization: `Bearer ${token}` });

async function daemon() {
  const { app, services } = await buildDaemonApp(daemonConfig());
  cleanups.push(() => app.close());
  const pair = async (name = 'Pixel') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers,
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { device: { id: string }; token: string };
  };
  return { app, services, pair };
}

describe('device tokens', () => {
  it('pairs with forward auth and then authenticates the device alone', async () => {
    const { app, pair } = await daemon();
    const { device, token } = await pair();
    expect(token).toMatch(/^pirc_dev_[A-Za-z0-9_-]{43}$/);

    const sessions = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: bearer(token),
    });
    expect(sessions.statusCode).toBe(200);
    // Mutations need no Origin with a bearer token (nothing is sent ambiently).
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/missing',
      headers: bearer(token),
      payload: { pinned: true },
    });
    expect(renamed.statusCode).toBe(404);

    const listed = await app.inject({ method: 'GET', url: '/api/devices', headers });
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json().devices).toEqual([
      expect.objectContaining({ id: device.id, name: 'Pixel' }),
    ]);
    // The token is shown once; listings never contain it or its hash.
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain('hash');
  });

  it('stores only a hash of the token', async () => {
    const { services, pair } = await daemon();
    const { token } = await pair();
    const rows = services.db.raw.query('SELECT * FROM device_tokens').all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('refuses bad, mixed, cross-origin and untrusted-proxy requests', async () => {
    const { app, pair } = await daemon();
    const { token } = await pair();
    const get = (extra: Record<string, string>, remoteAddress = '127.0.0.1') =>
      app.inject({ method: 'GET', url: '/api/sessions', headers: extra, remoteAddress });

    expect((await get(bearer('pirc_dev_' + 'x'.repeat(43)))).statusCode).toBe(401);
    expect((await get(bearer('pirc_dev_short'))).statusCode).toBe(401);
    // No fallback: a device-shaped bearer never falls through to forward auth.
    expect((await get({ ...headers, authorization: 'Bearer pirc_dev_nope' })).statusCode).toBe(401);
    expect((await get({ ...headers, authorization: `Bearer ${token}` })).statusCode).toBe(401);
    expect((await get({ ...bearer(token), origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get({ ...bearer(token), origin: 'https://test.example' })).statusCode).toBe(200);
    expect((await get({ ...bearer(token), host: 'evil.example' })).statusCode).toBe(403);
    expect((await get(bearer(token), '10.9.9.9')).statusCode).toBe(401);
    // Other Authorization schemes are the proxy's business; forward auth still decides.
    expect((await get({ ...headers, authorization: 'Basic Zm9vOmJhcg==' })).statusCode).toBe(200);
  });

  it('cannot manage devices or reach model backends', async () => {
    const { app, pair } = await daemon();
    const { device, token } = await pair();
    for (const [method, url] of [
      ['GET', '/api/devices'],
      ['POST', '/api/devices'],
      ['DELETE', `/api/devices/${device.id}`],
      ['GET', '/api/providers'],
      ['PUT', '/api/providers/default-model'],
      ['POST', '/api/provider-auth/sessions'],
      ['GET', '/api/%64evices'],
      ['GET', '//api/providers'],
    ] as const) {
      const response = await app.inject({ method, url, headers: bearer(token), payload: {} });
      // Refused, or (odd spellings) not routed at all: never served.
      expect([403, 404]).toContain(response.statusCode);
      if (!url.startsWith('//'))
        expect([method, url, response.statusCode]).toEqual([method, url, 403]);
    }
    // Model listing is not credential management.
    expect(
      (await app.inject({ method: 'GET', url: '/api/models', headers: bearer(token) })).statusCode,
    ).toBe(200);
  });

  it('revokes immediately and only the owner can', async () => {
    const { app, pair } = await daemon();
    const { device, token } = await pair();
    const revoke = (extra: Record<string, string>) =>
      app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: extra });
    const { origin: _o, ...noOrigin } = headers;
    expect((await revoke(noOrigin)).statusCode).toBe(403);
    expect((await revoke({ ...headers, 'x-pirc-user': 'intruder' })).statusCode).toBe(403);
    expect((await revoke(headers)).statusCode).toBe(204);
    expect((await revoke(headers)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions', headers: bearer(token) }))
        .statusCode,
    ).toBe(401);
  });

  it('validates names and caps the number of devices', async () => {
    const { app, pair } = await daemon();
    for (const name of ['', '   ', 'x'.repeat(101)])
      expect(
        (await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { name } }))
          .statusCode,
      ).toBe(400);
    for (let index = 0; index < 10; index++) await pair(`phone ${index}`);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/devices',
          headers,
          payload: { name: 'one more' },
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('device token expiry', () => {
  function store() {
    const db = new GatewayDatabase(':memory:');
    let clock = 1_000_000;
    const devices = new DeviceTokens(db.raw, { idleMs: 7 * DAY, maxAgeMs: 30 * DAY }, () => clock);
    cleanups.push(() => {
      devices.close();
      db.close();
    });
    return { devices, advance: (ms: number) => (clock += ms) };
  }

  it('dies after the idle limit without use', () => {
    const { devices, advance } = store();
    const { token } = devices.create('u', 'phone');
    advance(7 * DAY - 1);
    expect(devices.authenticate(token).user).toBe('u');
    // Use slides the idle window.
    advance(7 * DAY - 1);
    expect(devices.authenticate(token).user).toBe('u');
    advance(7 * DAY);
    expect(() => devices.authenticate(token)).toThrow(/expired/);
    expect(devices.list('u')).toEqual([]);
  });

  it('dies at the absolute limit however often it is used', () => {
    const { devices, advance } = store();
    const { device, token } = devices.create('u', 'phone');
    expect(device.expiresAt - device.createdAt).toBe(7 * DAY);
    for (let day = 0; day < 29; day++) {
      advance(DAY);
      devices.authenticate(token);
    }
    expect(devices.list('u')[0]!.expiresAt).toBe(device.createdAt + 30 * DAY);
    advance(DAY);
    expect(() => devices.authenticate(token)).toThrow(/expired/);
  });

  it('closes tracked sockets when swept after expiry', () => {
    const { devices, advance } = store();
    const { device } = devices.create('u', 'phone');
    let closed = 0;
    devices.track(device.id, () => closed++);
    const untrack = devices.track(device.id, () => closed++);
    untrack();
    devices.sweep();
    expect(closed).toBe(0);
    advance(7 * DAY);
    devices.sweep();
    expect(closed).toBe(1);
  });

  it('requires idle to fit within the maximum age', async () => {
    const { loadDaemonConfig } = await import('../src/config.js');
    const env = {
      PIRC_NODE_TOKENS: JSON.stringify({ n: 'n'.repeat(32) }),
      PIRC_TRUSTED_PROXIES: '127.0.0.1',
      PIRC_ALLOWED_ORIGINS: 'https://a',
      PIRC_ALLOWED_HOSTS: 'a',
      PIRC_ALLOWED_USERS: 'u',
      PIRC_STATE_DIR: '/tmp/pirc-device-config-test',
    };
    const config = loadDaemonConfig(env);
    expect([config.deviceTokenIdleMs, config.deviceTokenMaxAgeMs]).toEqual([7 * DAY, 30 * DAY]);
    expect(() => loadDaemonConfig({ ...env, PIRC_DEVICE_TOKEN_IDLE_DAYS: '31' })).toThrow(
      /cannot exceed/,
    );
  });
});

describe('device WebSockets', () => {
  const clusters: Cluster[] = [];
  afterEach(async () => {
    await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
  });

  it('streams events without Origin and closes when the token is revoked', async () => {
    const cluster = await startCluster();
    clusters.push(cluster);
    const { app, url } = cluster;
    const paired = (
      await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { name: 'Pixel' } })
    ).json();
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(paired.token),
      payload: { workspaceId: 'test:test' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;

    const socket = new WebSocket(`${url}/api/events?sessionId=${sessionId}`, {
      headers: bearer(paired.token),
      localAddress: '127.0.0.1',
    });
    cleanups.push(() => socket.terminate());
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/devices/${paired.device.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(await closed).toBe(4401);
  });
});
