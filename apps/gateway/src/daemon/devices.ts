/**
 * Device tokens: per-device bearer credentials for native clients (the
 * Android app) that cannot complete the forward-auth login. A browser holding
 * forward auth pairs a device and sees its token exactly once; the gateway
 * stores only the token's SHA-256 hash.
 *
 * Tokens die aggressively: after `idleMs` without use, `maxAgeMs` after
 * pairing, or on revocation. Open WebSockets of a dead token are closed.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { id, parse } from '../util.js';

export const DEVICE_TOKEN_PREFIX = 'pirc_dev_';
/** Prefix plus 32 random bytes in base64url. */
const TOKEN_PATTERN = /^pirc_dev_[A-Za-z0-9_-]{43}$/;
const MAX_DEVICES_PER_USER = 10;
/** `last_used_at` is written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;

export interface DevicePolicy {
  idleMs: number;
  maxAgeMs: number;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  /** When the token dies if it is not used again (idle or absolute limit, whichever is first). */
  expiresAt: number;
}

interface DeviceRow {
  id: string;
  owner_user: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class DeviceTokens {
  /** Device ID → close callbacks of its open WebSockets. */
  private readonly sockets = new Map<string, Set<() => void>>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database,
    private readonly policy: DevicePolicy,
    private readonly clock: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  private deadline(row: DeviceRow) {
    return Math.min(row.expires_at, row.last_used_at + this.policy.idleMs);
  }

  private summary(row: DeviceRow): DeviceSummary {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: this.deadline(row),
    };
  }

  private rows(user: string): DeviceRow[] {
    return this.db
      .query('SELECT * FROM device_tokens WHERE owner_user=? ORDER BY created_at DESC')
      .all(user) as DeviceRow[];
  }

  private disconnect(deviceId: string) {
    const closers = this.sockets.get(deviceId);
    this.sockets.delete(deviceId);
    for (const close of closers ?? []) close();
  }

  /** Delete dead tokens and close their sockets. */
  sweep(): void {
    const stamp = this.clock();
    const dead = (
      this.db
        .query('SELECT id FROM device_tokens WHERE expires_at<=? OR last_used_at+?<=?')
        .all(stamp, this.policy.idleMs, stamp) as Array<{ id: string }>
    ).map((row) => row.id);
    for (const deviceId of dead)
      this.db.query('DELETE FROM device_tokens WHERE id=?').run(deviceId);
    for (const deviceId of [...this.sockets.keys()])
      if (
        dead.includes(deviceId) ||
        !this.db.query('SELECT 1 FROM device_tokens WHERE id=?').get(deviceId)
      )
        this.disconnect(deviceId);
  }

  list(user: string): DeviceSummary[] {
    this.sweep();
    return this.rows(user).map((row) => this.summary(row));
  }

  create(user: string, name: string): { device: DeviceSummary; token: string } {
    this.sweep();
    if (this.rows(user).length >= MAX_DEVICES_PER_USER)
      throw new ApiError(
        409,
        'conflict',
        `At most ${MAX_DEVICES_PER_USER} devices can be paired; revoke one first`,
      );
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const stamp = this.clock();
    const row: DeviceRow = {
      id: id('dev'),
      owner_user: user,
      name,
      created_at: stamp,
      expires_at: stamp + this.policy.maxAgeMs,
      last_used_at: stamp,
    };
    this.db
      .query(
        'INSERT INTO device_tokens (id, owner_user, name, token_hash, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.owner_user,
        row.name,
        hash(token),
        row.created_at,
        row.expires_at,
        row.last_used_at,
      );
    return { device: this.summary(row), token };
  }

  revoke(user: string, deviceId: string): void {
    const removed = this.db
      .query('DELETE FROM device_tokens WHERE id=? AND owner_user=?')
      .run(deviceId, user).changes;
    if (!removed) throw new ApiError(404, 'not_found', 'Device not found');
    this.disconnect(deviceId);
  }

  /** The live token's device and owner; any failure is a 401 that reveals nothing. */
  authenticate(token: string): { id: string; user: string } {
    const invalid = () =>
      new ApiError(401, 'unauthenticated', 'Device token is invalid, expired or revoked');
    if (!TOKEN_PATTERN.test(token)) throw invalid();
    const row = this.db
      .query('SELECT * FROM device_tokens WHERE token_hash=?')
      .get(hash(token)) as DeviceRow | null;
    if (!row) throw invalid();
    const stamp = this.clock();
    if (stamp >= this.deadline(row)) {
      this.db.query('DELETE FROM device_tokens WHERE id=?').run(row.id);
      this.disconnect(row.id);
      throw invalid();
    }
    if (stamp - row.last_used_at >= TOUCH_INTERVAL_MS)
      this.db.query('UPDATE device_tokens SET last_used_at=? WHERE id=?').run(stamp, row.id);
    return { id: row.id, user: row.owner_user };
  }

  /** Close `close` when the device's token dies; returns the unsubscribe. */
  track(deviceId: string, close: () => void): () => void {
    let closers = this.sockets.get(deviceId);
    if (!closers) this.sockets.set(deviceId, (closers = new Set()));
    closers.add(close);
    return () => {
      closers.delete(close);
      if (!closers.size && this.sockets.get(deviceId) === closers) this.sockets.delete(deviceId);
    };
  }

  close(): void {
    clearInterval(this.sweeper);
    this.sockets.clear();
  }
}

const createBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const idParams = z.object({ id: z.string().min(1).max(200) });

/**
 * Device management needs forward auth: a device token can neither mint nor
 * revoke tokens (the auth hook refuses it; checked here again).
 */
export function registerDeviceRoutes(app: FastifyInstance, devices: DeviceTokens): void {
  app.register(async (scope) => {
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    const owner = (request: FastifyRequest) => {
      if (request.identity!.deviceId)
        throw new ApiError(403, 'forbidden', 'Device tokens cannot manage devices');
      return request.identity!.user;
    };
    scope.get('/api/devices', async (request) => ({ devices: devices.list(owner(request)) }));
    scope.post('/api/devices', async (request, reply) => {
      const user = owner(request);
      const { name } = parse(createBody, request.body);
      return reply.status(201).send(devices.create(user, name));
    });
    scope.delete('/api/devices/:id', async (request, reply) => {
      devices.revoke(owner(request), parse(idParams, request.params).id);
      return reply.status(204).send();
    });
  });
}
