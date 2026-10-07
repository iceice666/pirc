import { expect, test } from 'bun:test';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { ProviderActivity } from './ptc-m1/activity.js';
import { startAdmissionProxy } from './ptc-m1/inference-admission.js';
import { startNodeInference } from '../src/node/inference.js';

test('partial authenticated upload prevents quiet until malformed body completes', async () => {
  const root = await mkdtemp('/tmp/ptc-adm-');
  const activity = new ProviderActivity();
  const inference = await startNodeInference({
    stateDir: root,
    getModels: () => ({ providers: {} }),
    send: () => false,
  });
  let proxy: Awaited<ReturnType<typeof startAdmissionProxy>> | undefined;
  try {
    proxy = await startAdmissionProxy(root, inference.config, activity);
    const req = request({
      socketPath: proxy.config.socketPath,
      path: '/inference',
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.config.token}`,
        'content-type': 'application/json',
      },
    });
    req.on('error', () => undefined);
    const ended = new Promise<void>((resolve) =>
      req.on('response', (res) => {
        res.resume();
        res.on('end', resolve);
      }),
    );
    req.write('{');
    await Bun.sleep(30);
    let quiet = false;
    const waiting = activity.waitForQuiet({ quietMs: 15, timeoutMs: 1000 }).then(() => {
      quiet = true;
    });
    await Bun.sleep(50);
    expect(quiet).toBe(false);
    req.end('bad}');
    await ended;
    await waiting;
    expect(quiet).toBe(true);
  } finally {
    activity.close();
    const cleanup = await Promise.allSettled([proxy?.close(), inference.close()]);
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
    if (proxy) expect(await Bun.file(proxy.config.socketPath).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['disconnect', 'shutdown', 'oversize', 'timeout', 'upstream-refusal'] as const)
  test(`admission releases partial upload on ${mode}`, async () => {
    const root = await mkdtemp('/tmp/ptc-adm-');
    const activity = new ProviderActivity();
    const inference = await startNodeInference({
      stateDir: root,
      getModels: () => ({ providers: {} }),
      send: () => false,
    });
    let proxy: Awaited<ReturnType<typeof startAdmissionProxy>> | undefined;
    try {
      proxy = await startAdmissionProxy(
        root,
        mode === 'upstream-refusal'
          ? { socketPath: `${root}/absent`, token: 'synthetic' }
          : inference.config,
        activity,
        { requestBytes: 64, timeoutMs: mode === 'timeout' ? 60 : 1000 },
      );
      const req = request({
        socketPath: proxy.config.socketPath,
        path: '/inference',
        method: 'POST',
        headers: { authorization: `Bearer ${proxy.config.token}` },
      });
      req.on('error', () => undefined);
      req.on('response', (res) => res.resume());
      const disconnected = new Promise<void>((resolve) => req.once('close', resolve));
      req.write('{');
      await Bun.sleep(20);
      if (mode === 'disconnect') req.destroy();
      if (mode === 'shutdown') await proxy.close();
      if (mode === 'oversize') req.write('x'.repeat(128));
      await disconnected;
      await activity.waitForQuiet({ quietMs: 10, timeoutMs: 1000 });
    } finally {
      activity.close();
      const results = await Promise.allSettled([proxy?.close(), inference.close()]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      if (proxy) expect(await Bun.file(proxy.config.socketPath).exists()).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  }, 3000);
