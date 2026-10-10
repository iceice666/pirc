/**
 * M5 fresh-session cutover rehearsal on fixture state only. Test-local inventory and
 * rollback assessment helpers are deliberately not production APIs: an operational
 * cutover/rollback coordinator needs its own reviewed design.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { buildDaemonApp } from '../src/daemon/app.js';
import { GatewayDatabase } from '../src/database.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { legacyReferenceSchema, type WriterLease } from '../src/gateway-runtime/contracts.js';
import type { NodeWriterFence } from '../src/gateway-runtime/node-writer-fence.js';
import { buildNodeApp, type NodeServices } from '../src/node/app.js';
import { startNode } from '../src/node/runtime.js';
import { NODE_PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE } from '../src/protocol.js';
import type { Binding } from '../src/environment/protocol.js';
import type { NodeConfig } from '../src/config.js';
import { daemonConfig, nodeHeaders, testConfig, waitFor } from './helpers.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = 'test@example.com';

function files(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(relative, entry.name);
    return entry.isDirectory() ? files(root, next) : [next];
  });
}
function manifest(root: string, filter: (file: string) => boolean = () => true) {
  return Object.fromEntries(
    files(root)
      .filter(filter)
      .sort()
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(root, file)))
          .digest('hex'),
      ]),
  );
}
function tableNames(db: Database) {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}
/** Every pre-existing central table, captured before the fresh authority adds its own. */
function tableDigest(db: Database, tables: string[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        tables.map((table) => db.query(`SELECT * FROM "${table}" ORDER BY rowid`).all()),
      ),
    )
    .digest('hex');
}

/** §7 step 1, test-only: every legacy session ID referenced by retained central records. */
function inventory(db: Database, nodeSessions: string[]) {
  const columns: Array<[string, string]> = [
    ['schedules', 'created_by_session'],
    ['schedule_runs', 'session_id'],
    ['schedule_proposals', 'session_id'],
    ['delegations', 'assistant_session_id'],
    ['delegations', 'target_session_id'],
    ['memory_proposals', 'session_id'],
    ['memory_records', 'session_id'],
    ['memory_records', 'node_session_id'],
  ];
  const ids = new Set(nodeSessions);
  for (const [table, column] of columns)
    for (const row of db
      .query(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as Array<{ id: string }>)
      ids.add(row.id);
  // Fail closed on references this runtime cannot classify, rather than dropping them.
  for (const id of ids) legacyReferenceSchema.parse(id);
  return [...ids].sort();
}

function mentions(db: Database, sessionId: string, skip: string[] = []) {
  let rows = 0;
  for (const name of tableNames(db)) {
    if (skip.includes(name)) continue;
    const cols = (db.query(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
      (column) => `CAST("${column.name}" AS TEXT) LIKE ?1`,
    );
    if (!cols.length) continue;
    rows += (
      db
        .query(`SELECT count(*) AS n FROM "${name}" WHERE ${cols.join(' OR ')}`)
        .get(`%${sessionId}%`) as { n: number }
    ).n;
  }
  return rows;
}

/**
 * Test-only rollback POLICY assessment, not enforcement: nothing in production refuses a
 * revert. Any gateway row outside the identity tables, or any node environment-journal
 * row, that mentions the fresh session counts as a write (rows keyed only by execution
 * ID always accompany a session-bearing intent row). Workspace files are not covered.
 * A revert is eligible only with zero writes and both ends durably revoked; it never
 * un-fences legacy writers or reuses the fresh epoch.
 */
function rollbackAssessment(
  db: Database,
  fence: NodeWriterFence,
  nodeJournal: Database,
  binding: Binding,
) {
  const writes =
    mentions(db, binding.sessionId, ['runtime_sessions', 'runtime_branches', 'runtime_legacy']) +
    mentions(nodeJournal, binding.sessionId);
  const state = (
    db.query('SELECT state FROM runtime_sessions WHERE id=?').get(binding.sessionId) as {
      state: string;
    }
  ).state;
  let nodeRevoked = false;
  try {
    fence.assertProvisioned(binding);
  } catch (error) {
    nodeRevoked = String(error).includes('revoked');
  }
  const revoked = state === 'revoked' && nodeRevoked;
  return {
    writes,
    revoked,
    eligible: writes === 0 && revoked,
    reason:
      writes > 0
        ? 'New writes exist: no lossless rollback; preserve new data and plan a reviewed recovery'
        : revoked
          ? 'No writes and epoch revoked on both ends: restore pre-cutover backups'
          : 'Revoke the fresh epoch on gateway and node before any revert',
  };
}

/** Production-shaped fixture: legacy node sessions/JSONL plus central references. */
async function production() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-cutover-'));
  const config = testConfig();
  const daemon = daemonConfig();
  cleanups.push(() => {
    for (const dir of [root, config.stateDir, daemon.stateDir]) {
      for (const file of files(dir)) chmodSync(path.join(dir, file), 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const gatewayDir = path.join(root, 'gateway');
  mkdirSync(gatewayDir);
  const gatewayFile = path.join(gatewayDir, 'gateway.sqlite');
  // Legacy node with two sessions and retained transcripts.
  const legacy = await buildNodeApp(config);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await legacy.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: nodeHeaders,
      payload: { workspaceId: 'test' },
    });
    const id = created.json().session.id as string;
    ids.push(id);
    const transcript = legacy.services.db.getSession(id).privateSessionPath;
    mkdirSync(transcript, { recursive: true });
    writeFileSync(
      path.join(transcript, 'session.jsonl'),
      `{"type":"message","legacy":"private ${i}"}\n`,
    );
  }
  // Unfinished legacy work that quiescence must end: a running run and a pending approval.
  const run = legacy.services.db.createRun(ids[0]!);
  legacy.services.db.updateRun(run, 'running');
  legacy.services.db.createInteraction(
    ids[1]!,
    0,
    'rpc-legacy',
    'approval',
    {},
    Date.now() + 3_600_000,
  );
  await legacy.app.close();
  // Quiescence precedes the backup: a node restart (startup recovery) interrupts the run
  // and stales the approval without replaying either.
  const quiesced = await buildNodeApp(config);
  await quiesced.app.close();
  const gateway = new GatewayDatabase(gatewayFile);
  const now = 1_700_000_000_000;
  gateway.raw
    .query(
      `INSERT INTO schedules (id, owner_user, workspace_id, title, prompt, cron, timezone, status,
       next_run_at, created_by_session, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'sched-legacy',
      OWNER,
      'test',
      'Nightly',
      'Run',
      '0 3 * * *',
      'UTC',
      'active',
      now,
      ids[0]!,
      now,
      now,
    );
  gateway.raw
    .query(
      `INSERT INTO schedules (id, owner_user, workspace_id, title, prompt, cron, timezone, status,
       next_run_at, created_by_session, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    )
    .run(
      'sched-unrelated',
      OWNER,
      'other',
      'Weekly',
      'Run',
      '0 4 * * 1',
      'UTC',
      'active',
      now,
      now,
      now,
    );
  gateway.raw
    .query(
      `INSERT INTO schedule_runs (id, schedule_id, owner_user, due_at, status, session_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run('run-legacy', 'sched-legacy', OWNER, now, 'succeeded', ids[0]!, now);
  gateway.raw
    .query(
      `INSERT INTO delegations (id, owner_user, assistant_session_id, workspace_id, title, task, status,
       target_session_id, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('deleg-legacy', OWNER, ids[1]!, 'test', 'Fix', 'Fix it', 'done', ids[0]!, now, now, now);
  gateway.raw
    .query(
      `INSERT INTO memory_records (node_id, ledger_key, id, content, relevance, recorded_at,
       source_ids_json, session_id, workspace_id, owner_user, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('test', 'ledger', 'mem-1', 'note', 'high', 'now', '[]', ids[1]!, 'test', OWNER, 'active');
  const legacyTables = tableNames(gateway.raw);
  gateway.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  gateway.raw.close();

  // Fixture backup of the quiesced state; read-only for the remainder of the rehearsal.
  const backup = path.join(root, 'backup');
  const backupNode = path.join(backup, 'node');
  const backupGateway = path.join(backup, 'gateway');
  cpSync(config.stateDir, backupNode, { recursive: true });
  cpSync(gatewayDir, backupGateway, { recursive: true });
  for (const file of files(backup)) chmodSync(path.join(backup, file), 0o400);
  const transcripts = (file: string) => file.endsWith('.jsonl');
  return {
    config,
    daemon,
    legacyTables,
    run,
    gatewayDir,
    gatewayFile,
    ids,
    backup,
    backupManifest: manifest(backup),
    legacyManifest: manifest(config.stateDir, transcripts),
    transcripts,
    restore() {
      // Rollback restores both ends from the same pre-cutover backup set.
      for (const [from, to] of [
        [backupNode, config.stateDir],
        [backupGateway, gatewayDir],
      ] as const) {
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
        for (const file of files(to)) chmodSync(path.join(to, file), 0o600);
      }
    },
  };
}

/** Node runtime with access to its durable fences; connects through the real daemon. */
async function node(config: NodeConfig) {
  let services: NodeServices | undefined;
  const handle = await startNode(config, {
    initialize: (value) => {
      services = value;
    },
    connect() {},
    receive: async () => {},
    disconnect() {},
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  cleanups.push(close);
  return { close, services: services! };
}
/** Idempotent closer registered once; explicit early closes do not disturb other cleanups. */
function closer(fn: () => void) {
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    fn();
  };
  cleanups.push(close);
  return close;
}
const journalOf = (config: NodeConfig) => path.join(config.stateDir, 'environment-journal.sqlite');

test('fixture cutover rehearsal: quiescence, version-gated registration, retained legacy data, rollback only before writes', async () => {
  const fixture = await production();
  const { config, ids } = fixture;
  expect(Object.keys(fixture.legacyManifest)).toHaveLength(2);

  // Quiescence (in the fixture, before the backup) ended unfinished work without replay.
  let legacy = await node(config);
  expect(legacy.services.db.activeRuns()).toEqual([]);
  expect(legacy.services.db.latestRun(ids[0]!)?.status).toBe('interrupted');
  expect(legacy.services.writes.holders()).toEqual([]);
  for (const id of ids) {
    expect(legacy.services.runners.get(id)).toBeUndefined();
    expect(legacy.services.db.pendingInteractions(id)).toEqual([]);
  }
  const nodeSessions = legacy.services.db.listSessions().map((session) => session.id);
  await legacy.close();

  const gateway = new GatewayDatabase(fixture.gatewayFile);
  const centralBefore = tableDigest(gateway.raw, fixture.legacyTables);
  const legacyIds = inventory(gateway.raw, nodeSessions);
  expect(legacyIds).toEqual([...ids].sort());
  let authority = new GatewaySessionAuthority(gateway.raw);
  const closeGateway = closer(() => {
    authority.close();
    gateway.raw.close();
  });

  // Fresh identities are prepared while the node is offline: nothing is writable yet.
  const transfer = authority.prepare({
    owner: OWNER,
    nodeId: 'test',
    workspaceId: 'test:test',
    legacySessionIds: legacyIds,
  });
  const pendingLease: WriterLease = {
    binding: transfer.binding,
    branchId: authority.identities(transfer.binding.sessionId, OWNER).branchId,
  };
  expect(() =>
    authority.append(pendingLease, randomUUID(), {
      type: 'message',
      message: { role: 'user', content: 'too early', timestamp: 1 },
    }),
  ).toThrow('not active');
  for (const id of legacyIds) {
    expect(() => authority.assertFreshReference(id)).toThrow('Legacy session unavailable');
    expect(() => authority.read(id, OWNER)).toThrow('Legacy');
  }

  // The daemon here only exercises registration/version admission (its own database);
  // gateway-side legacy blocking is shown through the authority above.
  const { app: daemonApp, services: daemonServices } = await buildDaemonApp(fixture.daemon);
  cleanups.push(() => daemonApp.close());
  await daemonApp.listen({ host: '127.0.0.1', port: 0 });
  const daemonUrl = `ws://127.0.0.1:${(daemonApp.server.address() as { port: number }).port}`;
  const offlineFrame = async () => daemonServices.nodes.sendEnvironmentFrame('test', '{}');
  await expect(offlineFrame()).rejects.toThrow('offline');
  const stale = new WebSocket(`${daemonUrl}/node/connect`, {
    headers: { 'x-pirc-node-id': 'test', authorization: `Bearer ${'t'.repeat(32)}` },
  });
  const closed = new Promise<number>((resolve) => stale.once('close', (code) => resolve(code)));
  stale.once('open', () =>
    stale.send(
      JSON.stringify({
        type: 'register',
        protocol: NODE_PROTOCOL_VERSION - 1,
        role: 'node',
        workspaces: [],
      }),
    ),
  );
  expect(await closed).toBe(PROTOCOL_MISMATCH_CLOSE);
  // An outdated node never gets a node link, so no Environment work can reach it.
  expect(daemonServices.nodes.list()).toEqual([]);
  await expect(offlineFrame()).rejects.toThrow('offline');

  // A current node reconnects; it is still unprovisioned until both ends fence.
  const current = await node({ ...config, daemonUrl });
  await waitFor(() => daemonServices.nodes.list().length, 1);
  expect(() => current.services.writerFence.assertProvisioned(transfer.binding)).toThrow(
    'Unfenced',
  );
  const receipt = await current.services.writerFence.fence(transfer, async () => {
    for (const id of legacyIds) expect(current.services.runners.get(id)).toBeUndefined();
    expect(current.services.writes.holders()).toEqual([]);
  });
  const lease = authority.activate(receipt);
  current.services.writerFence.assertProvisioned(lease.binding);

  // Old writers cannot run legacy work again; fresh state starts empty; old data untouched.
  for (const id of legacyIds) {
    expect(() => current.services.writerFence.assertLegacyAllowed(id)).toThrow(
      'permanently fenced',
    );
    await expect(
      current.services.runners.dispatch(id, randomUUID(), { type: 'prompt', message: 'no' }, OWNER),
    ).rejects.toThrow('fenced');
  }
  await expect(
    current.services.runners.deliver(ids[0]!, { customType: 'scheduled-run', content: 'no' }),
  ).rejects.toThrow('fenced');
  expect(authority.read(lease.binding.sessionId, OWNER).entries).toEqual([]);
  expect(legacyIds).not.toContain(lease.binding.sessionId);
  expect(manifest(config.stateDir, fixture.transcripts)).toEqual(fixture.legacyManifest);
  expect(tableDigest(gateway.raw, fixture.legacyTables)).toBe(centralBefore);

  // Rollback before writes (policy): both-end revocation plus a zero-write assessment.
  const fence = current.services.writerFence;
  const journal = new Database(journalOf(config), { readonly: true });
  const closeJournal = closer(() => journal.close());
  expect(rollbackAssessment(gateway.raw, fence, journal, lease.binding)).toMatchObject({
    writes: 0,
    eligible: false,
  });
  authority.revoke(lease.binding);
  fence.revoke(lease.binding);
  expect(rollbackAssessment(gateway.raw, fence, journal, lease.binding)).toMatchObject({
    writes: 0,
    revoked: true,
    eligible: true,
  });
  expect(() => authority.activate(receipt)).toThrow('permanently revoked');
  expect(() => fence.assertProvisioned(lease.binding)).toThrow('revoked');
  expect(() => authority.assertWriter(lease)).toThrow();

  // Restore the pre-cutover backup on both ends after stopping everything. This also
  // discards the revocation records; the fresh generation simply no longer exists.
  closeJournal();
  await current.close();
  closeGateway();
  fixture.restore();
  expect(manifest(fixture.backup)).toEqual(fixture.backupManifest);
  legacy = await node(config);
  for (const id of legacyIds) legacy.services.writerFence.assertLegacyAllowed(id);
  expect(() => legacy.services.writerFence.assertProvisioned(lease.binding)).toThrow('Unfenced');
  const restored = new GatewayDatabase(fixture.gatewayFile);
  expect(tableDigest(restored.raw, fixture.legacyTables)).toBe(centralBefore);
  authority = new GatewaySessionAuthority(restored.raw);
  closer(() => {
    authority.close();
    restored.raw.close();
  });
  expect(() => authority.activate(receipt)).toThrow('Unknown fresh session');
  expect(manifest(config.stateDir, fixture.transcripts)).toEqual(fixture.legacyManifest);
}, 30000);

test('fixture cutover rehearsal: after the first fresh write there is no lossless rollback', async () => {
  const fixture = await production();
  const { config, ids } = fixture;
  const gateway = new GatewayDatabase(fixture.gatewayFile);
  const centralBefore = tableDigest(gateway.raw, fixture.legacyTables);
  let authority = new GatewaySessionAuthority(gateway.raw);
  closer(() => {
    authority.close();
    gateway.raw.close();
  });
  let current = await node(config);
  const transfer = authority.prepare({
    owner: OWNER,
    nodeId: 'test',
    workspaceId: 'test:test',
    legacySessionIds: inventory(gateway.raw, ids),
  });
  const receipt = await current.services.writerFence.fence(transfer, async () => {});
  const lease = authority.activate(receipt);
  const journal = new Database(journalOf(config), { readonly: true });
  const closeJournal = closer(() => journal.close());
  expect(
    rollbackAssessment(gateway.raw, current.services.writerFence, journal, lease.binding).writes,
  ).toBe(0);
  // A node-side write alone (here: provisioning the generation's journal binding) counts.
  current.services.environmentJournal.provision(lease.binding, 'a'.repeat(64), 'b'.repeat(64));
  expect(
    rollbackAssessment(gateway.raw, current.services.writerFence, journal, lease.binding).writes,
  ).toBeGreaterThan(0);
  authority.append(lease, randomUUID(), {
    type: 'message',
    message: { role: 'user', content: 'first fresh write', timestamp: 2 },
  });
  const before = rollbackAssessment(
    gateway.raw,
    current.services.writerFence,
    journal,
    lease.binding,
  );
  expect(before.writes).toBeGreaterThan(0);
  expect(before.eligible).toBe(false);
  authority.revoke(lease.binding);
  current.services.writerFence.revoke(lease.binding);
  const after = rollbackAssessment(
    gateway.raw,
    current.services.writerFence,
    journal,
    lease.binding,
  );
  expect(after).toMatchObject({ revoked: true, eligible: false });
  expect(after.reason).toContain('no lossless rollback');
  closeJournal();

  // Both ends restart: new data is retained, legacy writers stay fenced, epoch stays dead.
  await current.close();
  authority.close();
  authority = new GatewaySessionAuthority(gateway.raw);
  current = await node(config);
  expect(
    authority
      .read(lease.binding.sessionId, OWNER)
      .entries.some((entry) => JSON.stringify(entry).includes('first fresh write')),
  ).toBe(true);
  expect(() => authority.activate(receipt)).toThrow('permanently revoked');
  expect(() => current.services.writerFence.assertProvisioned(lease.binding)).toThrow('revoked');
  for (const id of ids)
    expect(() => current.services.writerFence.assertLegacyAllowed(id)).toThrow(
      'permanently fenced',
    );
  expect(manifest(config.stateDir, fixture.transcripts)).toEqual(fixture.legacyManifest);
  expect(tableDigest(gateway.raw, fixture.legacyTables)).toBe(centralBefore);
  expect(manifest(fixture.backup)).toEqual(fixture.backupManifest);
  expect(statSync(path.join(fixture.backup, 'gateway', 'gateway.sqlite')).mode & 0o222).toBe(0);
}, 30000);
