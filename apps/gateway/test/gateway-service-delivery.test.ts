import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayServiceDeliveries } from '../src/gateway-runtime/service-delivery.js';
import type { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
const leaseOf = (authority: GatewaySessionAuthority) =>
  authority.activate({
    ...authority.prepare({ owner: 'alice', nodeId: 'n', workspaceId: 'n:w', legacySessionIds: [] }),
    fenced: true,
  });
const inputOf = () => {
  const id = randomUUID();
  return { runId: id, turnId: id, text: 'durable task', attachments: [] };
};

test('durable service queue survives restart, retries capacity, and dedups immutable config before quota', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-service-queue-'));
  let authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
  let queue: GatewayServiceDeliveries | undefined;
  try {
    const lease = leaseOf(authority),
      input = inputOf();
    let ready = false,
      starts = 0,
      configured = 0;
    const runtime = {
      serviceDelivery: async (
        _lease: any,
        _owner: any,
        _input: any,
        before: (signal: AbortSignal) => Promise<void>,
      ) => {
        if (!ready) return;
        await before(new AbortController().signal);
        starts++;
        return { state: 'completed', reason: null };
      },
    } as unknown as GatewayAgentRuntime;
    const message = {
      customType: 'scheduled-run',
      content: input.text,
      details: { runId: 'schedule-one' },
      model: { provider: 'fake', id: 'model' },
    };
    queue = new GatewayServiceDeliveries({
      authority,
      runtime,
      configure: async () => {
        configured++;
      },
    });
    queue.admit(lease, 'alice', input, message);
    await Bun.sleep(10);
    expect(queue.status(input.runId, 'alice')?.state).toBe('queued');
    expect(configured).toBe(0);
    await queue.close();
    authority.close();
    authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
    queue = new GatewayServiceDeliveries({
      authority,
      runtime,
      configure: async () => {
        configured++;
      },
    });
    expect(() => queue!.admit(lease, 'alice', input, message)).not.toThrow();
    expect(() => queue!.admit(lease, 'alice', input, { ...message, thinking: 'changed' })).toThrow(
      'identity conflict',
    );
    ready = true;
    await Bun.sleep(400);
    expect(starts).toBe(1);
    expect(configured).toBe(1);
    expect(queue.status(input.runId, 'alice')?.state).toBe('completed');
    queue.admit(lease, 'alice', input, message);
    await Bun.sleep(300);
    expect(starts).toBe(1);
  } finally {
    await queue?.close();
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart conservatively seals a claimed delivery without replaying configure or lifecycle', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-service-claimed-'));
  let authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
  let queue: GatewayServiceDeliveries | undefined;
  try {
    const lease = leaseOf(authority),
      input = inputOf();
    queue = new GatewayServiceDeliveries({
      authority,
      runtime: { serviceDelivery: async () => undefined } as unknown as GatewayAgentRuntime,
    });
    queue.admit(lease, 'alice', input, { customType: 'service.delivery', content: input.text });
    await Bun.sleep(10);
    await queue.close();
    authority.inner.operations.db
      .query("UPDATE runtime_service_deliveries SET state='claimed' WHERE id=?")
      .run(input.runId);
    authority.close();
    authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
    let starts = 0;
    queue = new GatewayServiceDeliveries({
      authority,
      runtime: {
        serviceDelivery: async () => {
          starts++;
          throw Error('Must not replay');
        },
      } as unknown as GatewayAgentRuntime,
    });
    await Bun.sleep(300);
    expect(queue.status(input.runId, 'alice')?.state).toBe('interrupted');
    expect(starts).toBe(0);
  } finally {
    await queue?.close();
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});
