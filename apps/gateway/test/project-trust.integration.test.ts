import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'bun:test';
import { headers, promptSession, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

it('lets the web review and trust a workspace’s project config, kept on the node', async () => {
  const cluster = await startCluster([{ nodeId: 'repo' }, { nodeId: 'test', chat: true }]);
  clusters.push(cluster);
  const { app, services, nodes } = cluster;
  await waitFor(
    () =>
      ['repo:test', 'test:chats'].every((id) =>
        services.db.listWorkspaces().some((w) => w.id === id),
      ),
    true,
  );
  const root = nodes[0]!.config.workspaces[0]!.path;
  const write = (config: unknown) => {
    mkdirSync(path.join(root, '.pirc'), { recursive: true });
    writeFileSync(path.join(root, '.pirc', 'config.json'), JSON.stringify(config));
  };
  write({
    env: { GIT_SSH_COMMAND: 'ssh -i key' },
    hooks: { sessionStart: [{ command: 'make setup' }] },
    allowedPaths: ['../shared'],
  });
  const summaryUrl = '/api/workspaces/repo%3Atest/project-config';
  const trustUrl = '/api/workspaces/repo%3Atest/project-trust';

  const first = await app.inject({ method: 'GET', url: summaryUrl, headers });
  expect(first.statusCode).toBe(200);
  const project = first.json().project;
  expect(project).toMatchObject({
    env: { GIT_SSH_COMMAND: 'ssh -i key' },
    allowedPaths: ['../shared'],
    trusted: false,
    trustedHash: null,
    empty: false,
  });
  expect(project.hooks.sessionStart).toEqual([{ command: 'make setup', timeoutMs: 10_000 }]);
  expect(project.hash).toMatch(/^[0-9a-f]{64}$/);
  expect((await app.inject({ method: 'GET', url: summaryUrl })).statusCode).toBe(403);

  // Untrusted: the agent gets no trust hash.
  const before = await promptSession(app, services.events, headers, 'repo:test');
  expect(await before.ask('env PIRC_PROJECT_TRUST')).toBe('env:PIRC_PROJECT_TRUST=');

  // Only what the user saw can be trusted.
  const stale = await app.inject({
    method: 'POST',
    url: trustUrl,
    headers,
    payload: { trusted: true, hash: 'a'.repeat(64) },
  });
  expect(stale.statusCode).toBe(409);
  const bad = await app.inject({
    method: 'POST',
    url: trustUrl,
    headers,
    payload: { trusted: true, hash: 'nope' },
  });
  expect(bad.statusCode).toBe(400);

  const trusted = await app.inject({
    method: 'POST',
    url: trustUrl,
    headers,
    payload: { trusted: true, hash: project.hash },
  });
  expect(trusted.statusCode).toBe(200);
  expect(trusted.json().project).toMatchObject({ trusted: true, trustedHash: project.hash });
  const after = await promptSession(app, services.events, headers, 'repo:test');
  expect(await after.ask('env PIRC_PROJECT_TRUST')).toBe(`env:PIRC_PROJECT_TRUST=${project.hash}`);

  // A change to the gated fields needs trust again.
  write({ env: { GIT_SSH_COMMAND: 'ssh -o ProxyCommand=evil' } });
  const changed = (await app.inject({ method: 'GET', url: summaryUrl, headers })).json().project;
  expect(changed.trusted).toBe(false);
  expect(changed.trustedHash).toBe(project.hash);
  expect(changed.hash).not.toBe(project.hash);

  const revoked = await app.inject({
    method: 'POST',
    url: trustUrl,
    headers,
    payload: { trusted: false },
  });
  expect(revoked.json().project).toMatchObject({ trusted: false, trustedHash: null });

  // An invalid config is reported, and cannot be trusted.
  writeFileSync(path.join(root, '.pirc', 'config.json'), '{"hooks": ');
  const invalid = (await app.inject({ method: 'GET', url: summaryUrl, headers })).json().project;
  expect(invalid.error).toContain('Invalid JSON');
  expect(invalid.hash).toBeNull();

  // Chat projects have no project config.
  const chat = await app.inject({
    method: 'GET',
    url: '/api/workspaces/test%3Achats/project-config',
    headers,
  });
  expect(chat.statusCode).toBe(400);
}, 30_000);
