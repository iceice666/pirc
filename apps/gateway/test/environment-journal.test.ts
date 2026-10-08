import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionJournal } from '../src/environment/journal.js';
import { canonicalJson, digest } from '../src/environment/json.js';
import {
  encodeMessage,
  CONTROL_BYTES,
  REQUEST_BYTES,
  RESULT_BYTES,
} from '../src/environment/protocol.js';
import {
  intentDigest,
  type Binding,
  type ExecutionIntent,
  type Terminal,
} from '../src/environment/protocol.js';

const dirs: string[] = [];
const journals: ExecutionJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bound = (): Binding => ({
  nodeId: 'node',
  workspaceId: 'node:work',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
const makeIntent = (binding = bound()): ExecutionIntent => {
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'bash',
    arguments: { command: 'effect' },
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
};
const completed = (): Terminal => ({
  state: 'completed',
  effect: 'completed',
  output: { text: 'done' },
  artifacts: [],
  truncated: false,
});
function setup(clock?: () => number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-journal-'));
  dirs.push(dir);
  const file = path.join(dir, 'journal.sqlite');
  const journal = new ExecutionJournal(file, clock);
  journals.push(journal);
  const intent = makeIntent();
  journal.provision(intent.binding, intent.descriptorRevision, intent.policyRevision);
  return { journal, intent, file };
}

describe('durable execution journal foundation', () => {
  test('acceptance is durable, duplicate IDs do not create new work or extend deadline', () => {
    let now = 100;
    const { journal, intent, file } = setup(() => now);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(journal.accept(intent).fresh).toBe(true);
    now = 1100;
    expect(journal.accept(intent).fresh).toBe(false);
    expect(journal.claim(intent.binding, intent.executionId).terminal?.error?.code).toBe('expired');
    const changed = { ...intent, arguments: { command: 'another effect' } };
    changed.argumentDigest = intentDigest(changed);
    expect(() => journal.accept(changed)).toThrow('conflict');
  });
  test('forged bindings cannot start, query, cancel, read events or acknowledge', () => {
    const { journal, intent } = setup();
    journal.accept(intent);
    const forged = bound();
    expect(() => journal.accept(makeIntent(forged))).toThrow('binding');
    journal.provision(forged, intent.descriptorRevision, intent.policyRevision);
    for (const operation of [
      () => journal.status(forged, intent.executionId),
      () => journal.cancel(forged, intent.executionId),
      () => journal.events(forged, intent.executionId),
      () => journal.ack(forged, intent.executionId, 'a'.repeat(64)),
    ])
      expect(operation).toThrow('Unknown execution');
  });
  test('stale revisions reject durably, rather than becoming reusable IDs', () => {
    const { journal, intent } = setup();
    const stale = { ...intent, policyRevision: 'c'.repeat(64) };
    stale.argumentDigest = intentDigest(stale);
    expect(journal.accept(stale).record).toMatchObject({
      state: 'rejected',
      effect: 'not_started',
    });
    expect(journal.accept(stale).fresh).toBe(false);
    expect(() => journal.accept(intent)).toThrow('conflict');
    expect(() => journal.claim(stale.binding, stale.executionId)).toThrow('not startable');
  });
  test('single claim, ordered events, terminal persistence and idempotent ACK', () => {
    const { journal, intent } = setup();
    journal.accept(intent);
    expect(journal.claim(intent.binding, intent.executionId).effect).toBe('unknown');
    expect(() => journal.claim(intent.binding, intent.executionId)).toThrow('not startable');
    expect(
      journal.appendEvent(intent.binding, intent.executionId, 'progress', { text: 'one' }).seq,
    ).toBe(1);
    expect(journal.appendEvent(intent.binding, intent.executionId, 'output', 'two').seq).toBe(2);
    expect(journal.events(intent.binding, intent.executionId, 1).map((event) => event.seq)).toEqual(
      [2],
    );
    const result = journal.finish(intent.binding, intent.executionId, completed());
    expect(result.finalSeq).toBe(2);
    expect(journal.finish(intent.binding, intent.executionId, completed())).toEqual(result);
    expect(() =>
      journal.finish(intent.binding, intent.executionId, { ...completed(), output: 'different' }),
    ).toThrow('conflict');
    expect(() => journal.appendEvent(intent.binding, intent.executionId, 'output', 'late')).toThrow(
      'terminal',
    );
    expect(() => journal.ack(intent.binding, intent.executionId, '0'.repeat(64))).toThrow('digest');
    expect(journal.ack(intent.binding, intent.executionId, result.resultDigest!).acknowledged).toBe(
      true,
    );
    expect(journal.ack(intent.binding, intent.executionId, result.resultDigest!).acknowledged).toBe(
      true,
    );
  });
  test('cancellation records intent without claiming effects are undone', () => {
    const { journal, intent } = setup();
    journal.accept(intent);
    const queued = makeIntent(intent.binding);
    journal.accept(queued);
    expect(journal.cancel(queued.binding, queued.executionId)).toMatchObject({
      state: 'cancelled',
      effect: 'not_started',
    });
    journal.claim(intent.binding, intent.executionId);
    expect(journal.cancel(intent.binding, intent.executionId)).toMatchObject({
      state: 'running',
      effect: 'unknown',
      cancelRequested: true,
    });
    const result = journal.finish(intent.binding, intent.executionId, {
      state: 'cancelled',
      effect: 'unknown',
      truncated: false,
      artifacts: [],
    });
    expect(result.effect).toBe('unknown');
  });
  test('restart recovery reports unknown after an effect, never reruns it', () => {
    const { journal, intent, file } = setup();
    journal.accept(intent);
    journal.claim(intent.binding, intent.executionId);
    journal.appendEvent(intent.binding, intent.executionId, 'progress', 'effect may have occurred');
    const accepted = makeIntent(intent.binding);
    journal.accept(accepted);
    journal.close();
    journals.splice(journals.indexOf(journal), 1);
    const reopened = new ExecutionJournal(file);
    journals.push(reopened);
    expect(reopened.status(intent.binding, intent.executionId).state).toBe('running');
    expect(
      reopened
        .recover(intent.binding)
        .map((record) => record.state)
        .sort(),
    ).toEqual(['failed', 'unknown']);
    expect(reopened.status(intent.binding, intent.executionId).finalSeq).toBe(1);
    expect(reopened.accept(intent).fresh).toBe(false);
    expect(() => reopened.claim(intent.binding, intent.executionId)).toThrow('not startable');
    expect(reopened.recover(intent.binding)).toEqual([]);
  });
  test('lost ACK keeps data; reclamation preserves dedup tombstones and retirement fences', () => {
    let now = 100;
    const { journal, intent, file } = setup(() => now);
    journal.accept(intent);
    journal.claim(intent.binding, intent.executionId);
    const result = journal.finish(intent.binding, intent.executionId, completed());
    now += 30 * 86_400_000;
    expect(journal.reclaim(intent.binding, intent.executionId)).toBe(false);
    journal.ack(intent.binding, intent.executionId, result.resultDigest!);
    now += 86_400_000;
    expect(journal.reclaim(intent.binding, intent.executionId)).toBe(true);
    expect(journal.accept(intent)).toMatchObject({
      fresh: false,
      record: { reclaimed: true, resultDigest: result.resultDigest },
    });
    expect(journal.status(intent.binding, intent.executionId).terminal).toBeUndefined();
    journal.retire(intent.binding);
    expect(() => journal.accept(intent)).toThrow('Retired');
    expect(() => journal.accept(makeIntent(intent.binding))).toThrow('Retired');
    expect(() =>
      journal.provision(intent.binding, intent.descriptorRevision, intent.policyRevision),
    ).toThrow('Retired');
    journal.close();
    journals.splice(journals.indexOf(journal), 1);
    const reopened = new ExecutionJournal(file);
    journals.push(reopened);
    expect(() => reopened.accept(intent)).toThrow('Retired');
    expect(reopened.status(intent.binding, intent.executionId).reclaimed).toBe(true);
  });
  test('gateway persists intent and result before any future ACK; duplicate receipt is stable', () => {
    const { journal: node, intent } = setup();
    const { journal: gateway } = setup();
    gateway.provision(intent.binding, intent.descriptorRevision, intent.policyRevision);
    node.accept(intent);
    node.claim(intent.binding, intent.executionId);
    const result = node.finish(intent.binding, intent.executionId, completed());
    expect(() => gateway.receiveResult(intent.binding, result)).toThrow('persisted intent');
    gateway.persistIntent(intent);
    gateway.persistIntent(intent);
    expect(() =>
      gateway.receiveResult(intent.binding, { ...result, resultDigest: '0'.repeat(64) }),
    ).toThrow('digest');
    gateway.receiveResult(intent.binding, result);
    gateway.receiveResult(intent.binding, result);
    expect(gateway.receipt(intent.binding, intent.executionId)).toEqual(result);
    expect(node.status(intent.binding, intent.executionId).acknowledged).toBe(false);
    gateway.retire(intent.binding);
    gateway.receiveResult(intent.binding, result);
    expect(gateway.receipt(intent.binding, intent.executionId)).toEqual(result);
    expect(() => gateway.receipt(bound(), intent.executionId)).toThrow('binding');
  });
  test('unknown evidence refinement changes the digest without reopening execution', () => {
    const { journal: node, intent } = setup();
    const { journal: gateway } = setup();
    gateway.provision(intent.binding, intent.descriptorRevision, intent.policyRevision);
    gateway.persistIntent(intent);
    node.accept(intent);
    node.claim(intent.binding, intent.executionId);
    const [unknown] = node.recover(intent.binding);
    gateway.receiveResult(intent.binding, unknown!);
    node.ack(intent.binding, intent.executionId, unknown!.resultDigest!);
    node.retire(intent.binding);
    const verified = node.reconcile(intent.binding, intent.executionId, completed());
    expect(verified.resultDigest).not.toBe(unknown!.resultDigest);
    expect(verified.acknowledged).toBe(false);
    expect(() => node.ack(intent.binding, intent.executionId, unknown!.resultDigest!)).toThrow(
      'digest',
    );
    gateway.receiveResult(intent.binding, verified);
    gateway.receiveResult(intent.binding, verified);
    expect(gateway.receipt(intent.binding, intent.executionId)).toEqual(verified);
    expect(() => gateway.receiveResult(intent.binding, unknown!)).toThrow('conflict');
    expect(() => node.reconcile(intent.binding, intent.executionId, completed())).toThrow(
      'verified evidence',
    );
    expect(() => node.claim(intent.binding, intent.executionId)).toThrow('Retired');
    expect(() => node.accept(intent)).toThrow('Retired');
  });

  test('journaled requests, events and results fit the full delivery envelope', () => {
    const { journal, intent } = setup();
    const messageHeader = { version: 1 as const, requestId: randomUUID() };
    const oversized = { ...intent, arguments: { text: '' } };
    const emptyIntentBytes = Buffer.byteLength(canonicalJson(oversized, REQUEST_BYTES));
    oversized.arguments.text = 'x'.repeat(REQUEST_BYTES - emptyIntentBytes);
    oversized.argumentDigest = intentDigest(oversized);
    expect(() => journal.accept(oversized)).toThrow('byte');
    expect(() => journal.status(intent.binding, intent.executionId)).toThrow('Unknown');
    journal.accept(intent);
    journal.claim(intent.binding, intent.executionId);
    const emptyEvent = {
      binding: intent.binding,
      executionId: intent.executionId,
      seq: 1,
      kind: 'output' as const,
      payload: '',
    };
    const overhead = Buffer.byteLength(
      encodeMessage({ ...messageHeader, type: 'execution.event', event: emptyEvent }),
    );
    expect(() =>
      journal.appendEvent(
        intent.binding,
        intent.executionId,
        'output',
        'x'.repeat(CONTROL_BYTES - overhead + 1),
      ),
    ).toThrow('byte');
    expect(journal.events(intent.binding, intent.executionId)).toEqual([]);
    const event = journal.appendEvent(
      intent.binding,
      intent.executionId,
      'output',
      'x'.repeat(CONTROL_BYTES - overhead),
    );
    expect(
      Buffer.byteLength(encodeMessage({ ...messageHeader, type: 'execution.event', event })),
    ).toBe(CONTROL_BYTES);
    expect(() =>
      journal.finish(intent.binding, intent.executionId, {
        ...completed(),
        output: 'x'.repeat(RESULT_BYTES - 400),
      }),
    ).toThrow('byte');
    expect(journal.status(intent.binding, intent.executionId).state).toBe('running');
    const result = journal.finish(intent.binding, intent.executionId, completed());
    expect(() =>
      encodeMessage({ ...messageHeader, type: 'execution.result', record: result }),
    ).not.toThrow();
  });

  test('gateway rejects correctly digested artifacts from another owner', () => {
    const { journal: node, intent } = setup();
    const { journal: gateway } = setup();
    gateway.provision(intent.binding, intent.descriptorRevision, intent.policyRevision);
    gateway.persistIntent(intent);
    node.accept(intent);
    node.claim(intent.binding, intent.executionId);
    const result = node.finish(intent.binding, intent.executionId, completed());
    for (const foreign of [
      { nodeId: 'other' },
      { workspaceId: 'node:other' },
      { sessionId: randomUUID() },
    ]) {
      const terminal = {
        ...completed(),
        artifacts: [
          {
            nodeId: intent.binding.nodeId,
            workspaceId: intent.binding.workspaceId,
            sessionId: intent.binding.sessionId,
            artifactId: randomUUID(),
            digest: 'a'.repeat(64),
            bytes: 1,
            mimeType: 'text/plain',
            availability: 'available' as const,
            ...foreign,
          },
        ],
      };
      const forged = {
        ...result,
        terminal,
        resultDigest: digest(
          {
            binding: result.binding,
            executionId: result.executionId,
            argumentDigest: result.argumentDigest,
            finalSeq: result.finalSeq,
            terminal,
          },
          RESULT_BYTES,
        ),
      };
      expect(() => gateway.receiveResult(intent.binding, forged)).toThrow('ownership');
      expect(gateway.receipt(intent.binding, intent.executionId)).toBeUndefined();
    }
  });

  test('result artifacts must belong to the execution session', () => {
    const { journal, intent } = setup();
    journal.accept(intent);
    journal.claim(intent.binding, intent.executionId);
    expect(() =>
      journal.finish(intent.binding, intent.executionId, {
        ...completed(),
        artifacts: [
          {
            nodeId: 'other',
            workspaceId: 'other:work',
            sessionId: randomUUID(),
            artifactId: randomUUID(),
            digest: 'a'.repeat(64),
            bytes: 10,
            mimeType: 'text/plain',
            availability: 'available',
          },
        ],
      }),
    ).toThrow('ownership');
    expect(journal.status(intent.binding, intent.executionId).state).toBe('running');
  });
});
