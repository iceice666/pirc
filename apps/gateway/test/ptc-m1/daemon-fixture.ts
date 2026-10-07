/** Disposable production agent-operation authorization, not an HTTP/WS authentication claim. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildDaemonApp } from '../../src/daemon/app.js';
import type { DaemonConfig } from '../../src/config.js';

const USER = 'fixture@example.invalid';
const NODE = 'fixture-node';
export async function startFixtureDaemon(kind: 'coding' | 'chat', privateParent = '/tmp') {
  const root = await mkdtemp(path.join(privateParent, 'ptc-daemon-'));
  await mkdir(path.join(root, 'uploads'));
  const config: DaemonConfig = {
    host: '127.0.0.1',
    port: 0,
    stateDir: root,
    databasePath: path.join(root, 'fixture.sqlite'),
    uploadsDir: path.join(root, 'uploads'),
    trustedProxies: new Set(),
    allowedUsers: new Set([USER]),
    allowedOrigins: new Set(),
    allowedHosts: new Set(),
    identityHeader: 'x-pirc-user',
    proxySecret: 'synthetic-not-a-real-secret',
    nodeTokens: new Map(),
    eventBufferSize: 20,
    websocketMaxBufferedBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
    deviceTokenIdleMs: 3600000,
    deviceTokenMaxAgeMs: 3600000,
    modelsFile: path.join(root, 'absent-models.json'),
    memoryBudgets: { user: 2000, note: 8000 },
    delegationTtlMs: 3600000,
    timezone: 'UTC',
    vapidSubject: 'mailto:fixture@example.invalid',
    pushAllowHttp: false,
  };
  let built: Awaited<ReturnType<typeof buildDaemonApp>>;
  try {
    built = await buildDaemonApp(config);
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new Error('Disposable daemon unavailable');
  }
  const { app, services } = built;
  const { db, schedules } = services;
  db.syncRemoteWorkspaces(NODE, [
    {
      id: 'workspace',
      displayName: 'Synthetic fixture',
      kind: kind === 'chat' ? 'chat' : 'directory',
    },
  ]);
  const session = db.createSession(
    `${NODE}:workspace`,
    `node://${NODE}/fixture`,
    NODE,
    'fixture',
    USER,
  );
  const allowed = new Set(['assistant.context', 'schedule.create']);
  let closed = false;
  return {
    async dispatch(op: string, args: unknown) {
      if (closed || !allowed.has(op)) throw new Error('Unexpected fixture gateway operation');
      return services.nodes.onAgentRequest!(NODE, { sessionId: session.piSessionId!, op, args });
    },
    /** Deliberately outside timing: negative authorization probes use real dispatch. */
    async authorizationProof() {
      const before = schedules.list(USER).length;
      const unknownSession = await services.nodes.onAgentRequest!(NODE, {
        sessionId: 'unknown',
        op: 'schedule.list',
        args: {},
      });
      const foreignNode = await services.nodes.onAgentRequest!('foreign-node', {
        sessionId: session.piSessionId!,
        op: 'schedule.list',
        args: {},
      });
      // Gateway capability policy is supported only for chat, not directory workspaces.
      db.syncRemoteWorkspaces(NODE, [
        { id: 'policy', displayName: 'Synthetic policy', kind: 'chat' },
      ]);
      const policy = db.createSession(
        `${NODE}:policy`,
        `node://${NODE}/policy`,
        NODE,
        'policy',
        USER,
      );
      db.patchWorkspaceCapabilities(`${NODE}:policy`, { web_search: false, schedules: false });
      const denied = await services.nodes.onAgentRequest!(NODE, {
        sessionId: policy.piSessionId!,
        op: 'web.search',
        args: { query: 'synthetic' },
      });
      const deniedSchedule = await services.nodes.onAgentRequest!(NODE, {
        sessionId: policy.piSessionId!,
        op: 'schedule.create',
        args: { prompt: 'synthetic', cron: '0 9 * * *' },
      });
      return (
        unknownSession.status === 404 &&
        foreignNode.status === 404 &&
        denied.status === 403 &&
        deniedSchedule.status === 403 &&
        schedules.list(USER).length === before
      );
    },
    /** Enforcement only (no spec/wording checks): nothing active, every proposal still pending. */
    scheduleEnforcement() {
      const rows = db.raw
        .prepare('SELECT status FROM schedule_proposals WHERE session_id=?')
        .all(session.id) as Array<{ status: string }>;
      return {
        activeSchedules: schedules.list(USER).length,
        proposals: rows.length,
        nonPendingProposals: rows.filter((row) => row.status !== 'pending').length,
      };
    },
    scheduleProof(proposalId: string) {
      const proposals = schedules.pendingInteractions(session.id);
      const row = db.raw
        .prepare('SELECT spec_json,status FROM schedule_proposals WHERE id=? AND session_id=?')
        .get(proposalId, session.id) as { spec_json: string; status: string } | null;
      if (!row) return false;
      const spec = JSON.parse(row.spec_json);
      return (
        row.status === 'pending' &&
        proposals.length === 1 &&
        proposals[0]!.id === proposalId &&
        schedules.list(USER).length === 0 &&
        spec.cron === '0 9 * * *' &&
        spec.timezone === 'UTC' &&
        spec.workspaceId === session.workspaceId &&
        /synthetic\s+CI/i.test(spec.prompt)
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
