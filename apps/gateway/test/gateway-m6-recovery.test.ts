import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionJournal } from '../src/environment/journal.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
import { GatewayPtcService } from '../src/gateway-runtime/ptc-service.js';

test('gateway-placed PTC records left running by a restart recover once, without replay', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-ptc-recover-'));
  let journal = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
  try {
    const binding = {
      nodeId: 'node',
      workspaceId: 'node:workspace',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    };
    const intent = (code: string): ExecutionIntent => {
      const value = {
        binding,
        executionId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        toolCallId: randomUUID(),
        descriptorRevision: 'a'.repeat(64),
        policyRevision: 'b'.repeat(64),
        capability: 'ptc',
        arguments: { code },
        budgetMs: 120_000,
      };
      return { ...value, argumentDigest: intentDigest(value) };
    };
    journal.provision(binding, 'a'.repeat(64), 'b'.repeat(64));
    const running = intent('return 1;');
    const accepted = intent('return 2;');
    journal.accept(running);
    journal.claim(binding, running.executionId);
    journal.accept(accepted);
    journal.close();
    journal = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
    const service = (j: ExecutionJournal) =>
      new GatewayPtcService({
        environment: {} as never,
        journal: j,
        inner: j.inner,
        workerExecutable: '/unused',
        online: () => true,
        central: async () => {
          throw new Error('unused');
        },
      });
    const recovered = service(journal).recover();
    expect(recovered.map((record) => [record.executionId, record.state, record.effect])).toEqual(
      expect.arrayContaining([
        [running.executionId, 'unknown', 'unknown'],
        [accepted.executionId, 'failed', 'not_started'],
      ]),
    );
    // Once per journal; the same generation still admits new gateway-placed scripts.
    expect(service(journal).recover()).toEqual([]);
    expect(journal.status(binding, running.executionId).state).toBe('unknown');
    expect(journal.accept(intent('return 3;')).fresh).toBe(true);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
