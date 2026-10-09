import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { planPtc, validatePtcStore } from '../src/gateway-runtime/ptc-contracts.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import {
  descriptorDigest,
  intentDigest,
  RESULT_BYTES,
  type Descriptor,
  type ExecutionIntent,
  type ExecutionRecord,
} from '../src/environment/protocol.js';
import { digest } from '../src/environment/json.js';
import type { WriterLease } from '../src/gateway-runtime/contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const catalog = (names: string[]): Descriptor['capabilityCatalog'] =>
  names.map((name) => ({
    name,
    ...capabilityMetadata(name),
    argumentSchema: {},
    resultSchema: {},
    hookRevision: 'a'.repeat(64),
  }));
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-ptc-authority-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(file);
  cleanups.push(() => authority.close());
  const transfer = authority.prepare({
    owner: 'alice',
    nodeId: 'test',
    workspaceId: 'test:workspace',
    legacySessionIds: [],
  });
  const lease = authority.activate({ ...transfer, fenced: true });
  function begin(target: WriterLease = lease, code = 'store("value", 1);') {
    const input = { runId: randomUUID(), turnId: randomUUID(), text: 'PTC', attachments: [] };
    const descriptor: Descriptor = {
      binding: target.binding,
      version: 1,
      revision: '',
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: catalog(['read', 'write', 'web_search']),
      instructions: '',
      skills: [],
      role: 'general',
      platform: 'linux',
      cwdDisplay: '/node/workspace',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 600_000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    authority.commitTurn(target, input, descriptor, []);
    const value = {
      binding: target.binding,
      executionId: randomUUID(),
      runId: input.runId,
      turnId: input.turnId,
      toolCallId: randomUUID(),
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      capability: 'ptc',
      arguments: { code },
      budgetMs: 120_000,
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    authority.persistExecution(target, intent);
    const dispatch = authority.preparePtc(target, intent.executionId);
    return { intent: authority.executionIntent(intent.binding, intent.executionId), dispatch };
  }
  return {
    file,
    lease,
    begin,
    get authority() {
      return authority;
    },
    restart() {
      authority.close();
      authority = new GatewaySessionAuthority(file);
    },
  };
}
function result(
  intent: ExecutionIntent,
  state: 'completed' | 'failed' | 'unknown' = 'completed',
): ExecutionRecord {
  const terminal = {
    state,
    effect: state === 'unknown' ? ('unknown' as const) : ('completed' as const),
    artifacts: [],
    truncated: false,
    output: { content: [{ type: 'text', text: 'script result' }] },
  };
  return {
    binding: intent.binding,
    executionId: intent.executionId,
    argumentDigest: intent.argumentDigest,
    state,
    effect: terminal.effect,
    terminal,
    finalSeq: 0,
    cancelRequested: false,
    acknowledged: false,
    reclaimed: false,
    resultDigest: digest(
      {
        binding: intent.binding,
        executionId: intent.executionId,
        argumentDigest: intent.argumentDigest,
        finalSeq: 0,
        terminal,
      },
      RESULT_BYTES,
    ),
  };
}

test('PTC static routing validates catalog and manifest, never splits a mixed script', () => {
  const entries = catalog(['read', 'web_search']);
  expect(planPtc({ code: 'return 1;' }, entries).placement).toBe('gateway');
  expect(planPtc({ code: 'return await tools.web_search({query:"x"});' }, entries).placement).toBe(
    'gateway',
  );
  expect(
    planPtc({ code: 'await tools.read({path:"a"}); await tools.web_search({query:"x"});' }, entries)
      .placement,
  ).toBe('node');
  expect(
    planPtc({ code: 'for(let i=0;i<10;i++) await tools.read({path:String(i)});' }, entries)
      .manifest,
  ).toEqual(['read']);
  expect(() => planPtc({ code: 'await tools.write({});' }, entries)).toThrow('unavailable');
  expect(() => planPtc({ code: 'await tools.ptc({});' }, entries)).toThrow('unavailable');
  expect(() => planPtc({ code: 'await tools["read"]({});' }, entries)).toThrow();
  expect(() => planPtc({ code: 'return 1;', placement: 'gateway' }, entries)).toThrow();
  expect(() => planPtc({ code: 'return 1;' }, [entries[0]!, entries[0]!])).toThrow('Duplicate');
  expect(() => planPtc({ code: 'return 1;' }, [{ ...entries[0]!, placement: 'gateway' }])).toThrow(
    'Conflicting',
  );
});

test('PTC store validation retains character budgets and rejects ambiguous JSON', () => {
  expect(validatePtcStore('{"b":2,"a":1}')).toBe('{"a":1,"b":2}');
  expect(validatePtcStore(JSON.stringify({ value: '界'.repeat(100_000) }))).toContain('界');
  for (const raw of [
    '[]',
    '{"a":1,"a":2}',
    '{"a":1e999}',
    '{"":1}',
    JSON.stringify({ a: 'a'.repeat(262_144) }),
  ])
    expect(() => validatePtcStore(raw)).toThrow();
});

test('canonical number expansion cannot exceed durable store character bounds', () => {
  const compact = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [String(index), Array(10_000).fill(1e20)]),
    ),
  ).replaceAll('100000000000000000000', '1e20');
  expect(compact.length).toBeLessThan(1_048_576);
  expect(() => validatePtcStore(compact)).toThrow('size');
});

test('store and terminal commit once across restart, preserve no-op provenance and fork ancestry', () => {
  const f = fixture();
  const first = f.begin();
  expect(first.dispatch.snapshot.store).toBe('{}');
  const terminal = result(first.intent);
  const proposal = { store: '{"value":1}', untrusted: ['web_search'] };
  expect(() => f.authority.commitResult(terminal)).toThrow('atomic');
  expect(f.authority.commitPtcResult(terminal, proposal)).toBe('committed');
  const snapshot = f.authority.ptcStore(f.lease.binding.sessionId, 'alice');
  f.restart();
  expect(f.authority.commitPtcResult(terminal, proposal)).toBe('committed');
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice')).toEqual(snapshot);
  expect(() =>
    f.authority.commitPtcResult(terminal, { ...proposal, store: '{"value":2}' }),
  ).toThrow('conflict');
  const second = f.begin();
  expect(
    f.authority.commitPtcResult(result(second.intent), { store: '{"value":1}', untrusted: [] }),
  ).toBe('unchanged');
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice')).toEqual(snapshot);
  const third = f.begin();
  f.authority.commitPtcResult(result(third.intent), { store: '{"value":2}', untrusted: [] });
  const fork = f.authority.fork(f.lease, snapshot.revision);
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice')).toEqual({
    ...snapshot,
    branchId: fork.branchId,
  });
  expect(() => f.authority.ptcStore(f.lease.binding.sessionId, 'bob')).toThrow('owner');
  expect(() => f.authority.ptcStore(f.lease.binding.sessionId, 'alice', randomUUID())).toThrow(
    'branch',
  );
});

test('changed revision and switched branch retain effects and explicit conflicts without overwriting stores', () => {
  const f = fixture();
  const a = f.begin(),
    b = f.begin();
  f.authority.commitPtcResult(result(a.intent), { store: '{"a":1}', untrusted: [] });
  expect(f.authority.preparePtc(f.lease, b.intent.executionId)).toEqual(b.dispatch);
  expect(f.authority.commitPtcResult(result(b.intent), { store: '{"b":2}', untrusted: [] })).toBe(
    'conflict',
  );
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice').store).toBe('{"a":1}');
  const c = f.begin();
  const fork = f.authority.fork(f.lease, null);
  expect(f.authority.commitPtcResult(result(c.intent), { store: '{"c":3}', untrusted: [] })).toBe(
    'conflict',
  );
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice').store).toBe('{}');
  expect(
    f.authority
      .read(f.lease.binding.sessionId, 'alice', f.lease.branchId)
      .history.filter((message) => message.role === 'toolResult'),
  ).toHaveLength(3);
  expect(f.authority.read(fork.binding.sessionId, 'alice').history).toHaveLength(0);
});

test('unknown outer outcome gains verified evidence without replay or late store commits', () => {
  const f = fixture(),
    a = f.begin();
  f.authority.commitPtcResult(result(a.intent, 'unknown'));
  f.restart();
  expect(() =>
    f.authority.commitPtcResult(result(a.intent), { store: '{"late":1}', untrusted: [] }),
  ).toThrow('conflict');
  expect(f.authority.commitPtcResult(result(a.intent, 'failed'))).toBe('unchanged');
  expect(f.authority.commitPtcResult(result(a.intent, 'failed'))).toBe('unchanged');
  const view = f.authority.read(f.lease.binding.sessionId, 'alice');
  expect(view.history.filter((message) => message.role === 'toolResult')).toHaveLength(1);
  expect(
    view.entries.some(
      (entry) => entry.type === 'custom' && entry.customType === 'execution.reconciled',
    ),
  ).toBe(true);
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice').store).toBe('{}');
});

test('failure, corrupted receipt and transaction failure cannot partially commit stores', () => {
  const f = fixture();
  const a = f.begin();
  expect(() =>
    f.authority.commitPtcResult(result(a.intent, 'failed'), { store: '{"a":1}', untrusted: [] }),
  ).toThrow('Failed');
  expect(f.authority.commitPtcResult(result(a.intent, 'failed'))).toBe('unchanged');
  const b = f.begin();
  const proposal = { store: '{"b":2}', untrusted: [] };
  expect(() =>
    f.authority.commitPtcResult({ ...result(b.intent), resultDigest: 'f'.repeat(64) }, proposal),
  ).toThrow('digest');
  expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice').store).toBe('{}');
  const db = new Database(f.file);
  try {
    db.exec(
      "CREATE TRIGGER fail_ptc BEFORE UPDATE ON runtime_ptc_dispatch BEGIN SELECT RAISE(ABORT,'disk simulation'); END;",
    );
    expect(() => f.authority.commitPtcResult(result(b.intent), proposal)).toThrow(
      'disk simulation',
    );
    expect(f.authority.ptcStore(f.lease.binding.sessionId, 'alice').store).toBe('{}');
    db.exec('DROP TRIGGER fail_ptc');
  } finally {
    db.close();
  }
  expect(f.authority.commitPtcResult(result(b.intent), proposal)).toBe('committed');
});
