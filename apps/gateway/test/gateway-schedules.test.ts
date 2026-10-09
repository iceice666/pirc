import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { gatewayScheduleTool } from '../src/gateway-runtime/schedules.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
test('gateway schedule adapter preserves approval proposal without node filesystem context', async () => {
  const value = {
    binding: {
      nodeId: 'n',
      workspaceId: 'n:w',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    },
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'schedule',
    arguments: { action: 'create', prompt: 'test' },
    budgetMs: 1000,
  };
  const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
  let calls = 0;
  const tool = gatewayScheduleTool(async (op, args, bound) => {
    calls++;
    expect(op).toBe('schedule.create');
    expect(args.prompt).toBe('test');
    expect(bound.executionId).toBe(intent.executionId);
    return { proposalId: 'proposal', title: 'Test' };
  });
  const result = await tool.execute(
    { action: 'create', prompt: 'test' },
    intent,
    new AbortController().signal,
  );
  expect(result.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('does not exist until'),
  });
  expect(calls).toBe(1);
});
