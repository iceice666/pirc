import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CentralLink } from '../src/environment/central-link.js';
import {
  intentDigest,
  encodeMessage,
  decodeMessage,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

function intent(): ExecutionIntent {
  const value = {
    binding: {
      nodeId: 'n',
      workspaceId: 'n:w',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    },
    executionId: randomUUID(),
    parentExecutionId: randomUUID(),
    innerOperationId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'web_search',
    arguments: { query: 'x' },
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
}
test('control cancellation overtaking central data prevents delayed dispatch', async () => {
  const call = intent();
  let effects = 0;
  const replies: unknown[] = [];
  const link = new CentralLink({
    nodeId: 'n',
    authorize: () => {},
    send: async (reply) => {
      replies.push(reply);
    },
    execute: async () => {
      effects++;
      return {
        ok: true,
        contractVersion: 1,
        operationId: call.innerOperationId!,
        data: null,
        attachments: [],
        truncated: false,
      };
    },
  });
  await link.receive({
    version: 1,
    type: 'ptc.central.cancel',
    requestId: randomUUID(),
    binding: call.binding,
    executionId: call.executionId,
  });
  await link.receive({ version: 1, type: 'ptc.central', requestId: randomUUID(), intent: call });
  await link.drain();
  expect(effects).toBe(0);
  expect(replies).toHaveLength(2);
  link.disconnect();
});

test('central cancellation awaits remote effect drain, not local request rejection', async () => {
  const call = intent();
  let finish!: () => void, started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const held = new Promise<void>((resolve) => (finish = resolve));
  let gateway!: CentralLink;
  const node = new CentralLink({
    nodeId: 'n',
    authorize: () => {},
    send: (message) => gateway.receive(message).then(() => {}),
  });
  gateway = new CentralLink({
    nodeId: 'n',
    authorize: () => {},
    send: (message) => node.receive(message).then(() => {}),
    execute: async () => {
      started();
      await held;
      return {
        ok: true,
        contractVersion: 1,
        operationId: call.innerOperationId!,
        data: null,
        attachments: [],
        truncated: false,
      };
    },
  });
  const controller = new AbortController();
  let settled = false;
  const request = node.request(call, controller.signal).catch((error) => {
    settled = true;
    return error;
  });
  await running;
  controller.abort();
  await Bun.sleep(20);
  expect(settled).toBe(false);
  finish();
  expect(String(await request)).toContain('drained');
  await gateway.drain();
  node.disconnect();
  gateway.disconnect();
});

test('central reverse RPC preserves strict wire identity; lost reply never automatically replays', async () => {
  const call = intent();
  let calls = 0,
    drop = false;
  let gateway!: CentralLink;
  const node = new CentralLink({
    nodeId: 'n',
    authorize: (binding) => {
      if (binding.sessionId !== call.binding.sessionId) throw new Error('owner');
    },
    send: async (message) => {
      await gateway.receive(decodeMessage(encodeMessage(message)));
    },
  });
  gateway = new CentralLink({
    nodeId: 'n',
    authorize: (binding) => {
      if (binding.sessionId !== call.binding.sessionId) throw new Error('owner');
    },
    execute: async () => {
      calls++;
      return {
        ok: true,
        contractVersion: 1,
        operationId: call.innerOperationId!,
        data: { text: 'found' },
        attachments: [],
        truncated: false,
      };
    },
    send: async (message) => {
      if (drop) {
        node.disconnect();
        return;
      }
      await node.receive(decodeMessage(encodeMessage(message)));
    },
  });
  expect((await node.request(call, new AbortController().signal)).ok).toBe(true);
  expect(calls).toBe(1);
  await gateway.drain();
  drop = true;
  await expect(node.request(call, new AbortController().signal)).rejects.toThrow('disconnected');
  expect(calls).toBe(2);
  await gateway.drain();
  node.reconnect();
  await Bun.sleep(10);
  expect(calls).toBe(2);
  node.disconnect();
  gateway.disconnect();
});
