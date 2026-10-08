/**
 * Push notifications (docs/history/cron.md, phase 4): Web Push to browsers, and the
 * same protocol to phones through UnifiedPush (the app's distributor, e.g.
 * ntfy, gives it a Web Push endpoint). Payloads are encrypted for the
 * subscriber (RFC 8291) and signed with the gateway's VAPID key, so the push
 * service relays them without reading them. They still say little: a title,
 * a short line and where to open, never an agent's answer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import type { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import type { GatewayEvent } from '../types.js';
import { now } from '../util.js';

/** What a notification opens: a session, the schedules, or the memory settings. */
export type PushTarget =
  | { sessionId: string }
  | { schedules: true; scheduleId?: string }
  | { memory: true };

export interface PushMessage {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  target: PushTarget;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** `web` (a browser) or `unifiedpush` (the Android app). */
  kind: 'web' | 'unifiedpush';
  /** Shown in the list of places that get notifications. */
  name?: string | undefined;
}

export const subscriptionBody = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}={0,2}$/),
      })
      .strict(),
    kind: z.enum(['web', 'unifiedpush']).default('web'),
    name: z.string().trim().max(100).optional(),
  })
  .strict();

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The gateway's VAPID key pair: from `PIRC_VAPID_PUBLIC_KEY` and
 * `PIRC_VAPID_PRIVATE_KEY`, else made once and kept in `<stateDir>/vapid.json`.
 * A new key pair invalidates every subscription, so it must outlive restarts.
 */
export function loadVapidKeys(stateDir: string, env: NodeJS.ProcessEnv = process.env): VapidKeys {
  const publicKey = env.PIRC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.PIRC_VAPID_PRIVATE_KEY?.trim();
  if (publicKey || privateKey) {
    if (!publicKey || !privateKey)
      throw new Error('Set both PIRC_VAPID_PUBLIC_KEY and PIRC_VAPID_PRIVATE_KEY, or neither');
    return { publicKey, privateKey };
  }
  const file = path.join(stateDir, 'vapid.json');
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
    if (stored.publicKey && stored.privateKey)
      return { publicKey: stored.publicKey, privateKey: stored.privateKey };
    throw new Error(`${file} holds no VAPID key pair`);
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
  return keys;
}

interface SubscriptionRow {
  id: string;
  owner_user: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kind: string;
  name: string | null;
  device_id: string | null;
  created_at: number;
  last_success_at: number | null;
  failures: number;
}

export interface PushDeps {
  db: GatewayDatabase;
  vapid: VapidKeys;
  /** `mailto:` or `https:` contact the push services may use (PIRC_VAPID_SUBJECT). */
  subject: string;
  /** Plain http endpoints are refused unless this allows them (tests, loopback distributors). */
  allowInsecureEndpoints?: boolean;
  fetch?: typeof fetch;
  warn(message: string, error?: unknown): void;
}

/** A push service's answer before giving up on it for this message. */
const SEND_TIMEOUT_MS = 10_000;
/** How long a push service keeps an undelivered message (a phone offline for a while). */
const TTL_SECONDS = 24 * 3600;
/** Consecutive failures after which a subscription is dropped. */
const MAX_FAILURES = 20;
/** An endpoint may be long, but its host is what people recognize. */
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export class Push {
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: PushDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  get publicKey(): string {
    return this.deps.vapid.publicKey;
  }

  /** Where the user gets notifications (endpoints are shown by host only). */
  list(user: string) {
    this.prune();
    return (
      this.deps.db.raw
        .prepare('SELECT * FROM push_subscriptions WHERE owner_user=? ORDER BY created_at')
        .all(user) as SubscriptionRow[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name ?? new URL(row.endpoint).host,
      host: new URL(row.endpoint).host,
      createdAt: row.created_at,
      lastSuccessAt: row.last_success_at,
      failing: row.failures > 0,
    }));
  }

  /** Add or refresh a subscription; one endpoint belongs to one user. */
  subscribe(user: string, input: PushSubscriptionInput, deviceId: string | null) {
    const url = new URL(input.endpoint);
    if (
      url.protocol !== 'https:' &&
      !(this.deps.allowInsecureEndpoints && url.protocol === 'http:')
    )
      throw new ApiError(400, 'invalid_input', 'A push endpoint must use https');
    if (url.username || url.password)
      throw new ApiError(400, 'invalid_input', 'A push endpoint cannot carry credentials');
    const { raw } = this.deps.db;
    const existing = raw
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint=?')
      .get(input.endpoint) as SubscriptionRow | null;
    if (existing && existing.owner_user !== user)
      raw.prepare('DELETE FROM push_subscriptions WHERE id=?').run(existing.id);
    const id =
      existing && existing.owner_user === user ? existing.id : `push_${crypto.randomUUID()}`;
    raw
      .prepare(
        `INSERT INTO push_subscriptions (id,owner_user,endpoint,p256dh,auth,kind,name,device_id,created_at,failures)
         VALUES (?,?,?,?,?,?,?,?,?,0)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, kind=excluded.kind,
           name=excluded.name, device_id=excluded.device_id, failures=0`,
      )
      .run(
        id,
        user,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
        input.kind,
        input.name ? clip(input.name, 100) : null,
        deviceId,
        now(),
      );
    return this.list(user).find((item) => item.id === id)!;
  }

  /** Stop notifying one endpoint (by endpoint, as the device knows it) or subscription id. */
  unsubscribe(
    user: string,
    ref: { endpoint?: string | undefined; id?: string | undefined },
  ): boolean {
    const changes = this.deps.db.raw
      .prepare('DELETE FROM push_subscriptions WHERE owner_user=? AND (endpoint=? OR id=?)')
      .run(user, ref.endpoint ?? '', ref.id ?? '').changes;
    return changes > 0;
  }

  /**
   * Send `message` to every place `user` gets notifications. Never throws:
   * a push that cannot be delivered is only logged, and dead endpoints go.
   */
  async notify(user: string, message: PushMessage): Promise<number> {
    this.prune();
    const rows = this.deps.db.raw
      .prepare('SELECT * FROM push_subscriptions WHERE owner_user=?')
      .all(user) as SubscriptionRow[];
    const payload = JSON.stringify({
      title: clip(message.title, 120),
      body: clip(message.body, 240),
      tag: message.tag,
      target: message.target,
      at: now(),
    });
    const sent = await Promise.all(rows.map((row) => this.send(row, payload, message.tag)));
    return sent.filter(Boolean).length;
  }

  private async send(row: SubscriptionRow, payload: string, tag: string): Promise<boolean> {
    const { raw } = this.deps.db;
    try {
      const request = webpush.generateRequestDetails(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        {
          vapidDetails: {
            subject: this.deps.subject,
            publicKey: this.deps.vapid.publicKey,
            privateKey: this.deps.vapid.privateKey,
          },
          TTL: TTL_SECONDS,
          urgency: 'normal',
          // A newer message with the same topic replaces one still queued (a phone offline).
          topic: topicOf(tag),
        },
      );
      const response = await this.fetch(request.endpoint, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: new Uint8Array(request.body as Buffer),
        redirect: 'manual',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 410) {
        raw.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);
        return false;
      }
      if (!response.ok) throw new Error(`push service answered ${response.status}`);
      raw
        .prepare('UPDATE push_subscriptions SET last_success_at=?, failures=0 WHERE id=?')
        .run(now(), row.id);
      return true;
    } catch (error) {
      raw.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE id=?').run(row.id);
      raw
        .prepare('DELETE FROM push_subscriptions WHERE id=? AND failures>=?')
        .run(row.id, MAX_FAILURES);
      this.deps.warn(`push to ${new URL(row.endpoint).host} failed`, error);
      return false;
    }
  }

  /** A phone's subscription goes with its device token. */
  private prune(): void {
    this.deps.db.raw
      .prepare(
        'DELETE FROM push_subscriptions WHERE device_id IS NOT NULL AND device_id NOT IN (SELECT id FROM device_tokens)',
      )
      .run();
  }
}

/** The Topic header allows at most 32 URL-safe base64 characters. */
function topicOf(tag: string): string {
  let hash = 0;
  for (const char of tag) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `t${(hash >>> 0).toString(36)}${tag.length.toString(36)}`.slice(0, 32);
}

/**
 * A session that starts waiting for its user (a dangerous command to
 * confirm, a question) pushes to them; the gateway's own confirmations (a
 * delegation or schedule to approve) count too.
 */
export function watchInteractions(deps: {
  db: GatewayDatabase;
  push: Push;
  subscribeAll(listener: (event: GatewayEvent) => void): () => void;
}): () => void {
  return deps.subscribeAll((event) => {
    if (event.type !== 'interaction_created') return;
    let session;
    try {
      session = deps.db.getSession(event.sessionId);
    } catch {
      return;
    }
    if (!session.ownerUser) return;
    const request = (event.data as { request?: { title?: unknown } } | null)?.request;
    const asked = typeof request?.title === 'string' && request.title.trim() ? request.title : '';
    void deps.push.notify(session.ownerUser, {
      title: `${session.name} is waiting for you`,
      body: asked || 'It needs your answer to go on.',
      tag: `session:${session.id}`,
      target: { sessionId: session.id },
    });
  });
}
