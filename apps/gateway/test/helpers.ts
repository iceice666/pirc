import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect } from 'bun:test';
import type { DaemonConfig, NodeConfig } from '../src/config.js';
import { buildDaemonApp, type DaemonServices } from '../src/daemon/app.js';
import type { EventHub } from '../src/events.js';
import { startNode } from '../src/node/runtime.js';

const USER = 'test@example.com';

function stateDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const uploadsDir = path.join(dir, 'uploads');
  mkdirSync(uploadsDir);
  return { stateDir: dir, uploadsDir, databasePath: path.join(dir, 'test.sqlite') };
}

/** A node with one workspace `test`; its router expects `x-pirc-user` (see nodeHeaders). */
export function testConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  const dirs = stateDir('pirc-node-');
  const workspace = path.join(dirs.stateDir, 'workspace');
  mkdirSync(workspace);
  const sessionsDir = path.join(dirs.stateDir, 'sessions');
  mkdirSync(sessionsDir);
  return {
    nodeId: 'test',
    nodeToken: 't'.repeat(32),
    daemonUrl: 'ws://127.0.0.1:1',
    allowedUsers: new Set([USER]),
    ...dirs,
    sessionsDir,
    agentCommand: process.execPath,
    agentArgs: [path.resolve('test/fixtures/fake-pi.mjs')],
    workspaces: [{ id: 'test', path: workspace, displayName: 'Test', defaults: {} }],
    chat: false,
    eventBufferSize: 20,
    rpcMaxLineBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
    terminalsEnabled: true,
    leaseTtlMs: 5000,
    interactionTtlMs: 5000,
    shutdownGraceMs: 100,
    ...overrides,
  };
}

export function daemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    ...stateDir('pirc-daemon-'),
    trustedProxies: new Set(['127.0.0.1', '::1']),
    allowedUsers: new Set([USER]),
    allowedOrigins: new Set(['https://test.example']),
    allowedHosts: new Set(['test.example']),
    identityHeader: 'x-pirc-user',
    nodeTokens: new Map([['test', 't'.repeat(32)]]),
    eventBufferSize: 50,
    websocketMaxBufferedBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
    deviceTokenIdleMs: 7 * 86_400_000,
    deviceTokenMaxAgeMs: 30 * 86_400_000,
    // Absent file: no providers unless a test writes one.
    modelsFile: path.join(tmpdir(), 'pirc-test-no-models.json'),
    memoryBudgets: { user: 2000, note: 8000 },
    ...overrides,
  };
}

/** Browser request headers accepted by the daemon (forward-auth identity). */
export const headers = {
  host: 'test.example',
  origin: 'https://test.example',
  'x-pirc-user': USER,
};

/** Headers the node runtime sets when it replays a daemon request. */
export const nodeHeaders = { 'x-pirc-user': USER };

export interface Cluster {
  app: FastifyInstance;
  services: DaemonServices;
  /** ws:// base URL of the listening daemon. */
  url: string;
  nodes: Array<{ close: () => Promise<void> }>;
  close(): Promise<void>;
}

/**
 * A listening daemon plus in-process nodes connected to it, the only
 * deployment shape pirc has. Each node advertises a workspace `<nodeId>:test`.
 */
export async function startCluster(
  nodes: Array<Partial<NodeConfig> & { nodeId: string }> = [{ nodeId: 'test' }],
  overrides: Partial<DaemonConfig> = {},
): Promise<Cluster> {
  const tokens = new Map(
    nodes.map((node, index) => [node.nodeId, String.fromCharCode(97 + index).repeat(32)]),
  );
  const { app, services } = await buildDaemonApp(
    daemonConfig({ nodeTokens: tokens, ...overrides }),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const started: Array<{ close: () => Promise<void> }> = [];
  for (const node of nodes)
    started.push(
      await startNode(testConfig({ ...node, nodeToken: tokens.get(node.nodeId)!, daemonUrl: url })),
    );
  await waitFor(() => services.nodes.list().length, nodes.length);
  return {
    app,
    services,
    url,
    nodes: started,
    async close() {
      await Promise.all(started.splice(0).map((node) => node.close()));
      await app.close();
    },
  };
}

/** Poll until `read()` equals `expected` or the timeout elapses (replacement for vitest's expect.poll). */
export async function waitFor<T>(read: () => T | Promise<T>, expected: T, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!Object.is(last, expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = await read();
  }
  if (!Object.is(last, expected))
    throw new Error(`waitFor timed out: expected ${String(expected)}, got ${String(last)}`);
}

/**
 * Open a session in `workspaceId` through `app` (the daemon or a node router)
 * and return `ask`, which prompts the fake agent and resolves with its reply.
 */
export async function promptSession(
  app: FastifyInstance,
  events: EventHub,
  requestHeaders: Record<string, string>,
  workspaceId: string,
): Promise<{ sessionId: string; ask: (message: string) => Promise<string> }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: requestHeaders,
    payload: { workspaceId },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = created.json().session.id as string;
  const acquired = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/control/acquire`,
    headers: requestHeaders,
    payload: { clientId: 'browser' },
  });
  const generation = acquired.json().lease.generation as number;
  const settled = () =>
    events
      .replay(sessionId, null)
      .events.filter(
        (event) => event.type === 'pi_event' && (event.data as any)?.type === 'agent_settled',
      ).length;
  let count = 0;
  const ask = async (message: string): Promise<string> => {
    const command = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/commands`,
      headers: requestHeaders,
      payload: {
        // Command ids are unique across sessions.
        commandId: `${sessionId}-command-${++count}`,
        clientId: 'browser',
        generation,
        payload: { type: 'prompt', message },
      },
    });
    expect(command.statusCode).toBe(202);
    await waitFor(settled, count);
    const snapshot = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/snapshot`,
      headers: requestHeaders,
    });
    return snapshot.json().history.at(-1).content[0].text as string;
  };
  return { sessionId, ask };
}
