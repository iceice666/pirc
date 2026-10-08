import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, parseJson } from '../src/environment/json.js';
import {
  bindingSchema,
  decodeMessage,
  descriptorDigest,
  encodeMessage,
  intentDigest,
  validateIntent,
  recordSchema,
  CONTROL_BYTES,
  REQUEST_BYTES,
  type Binding,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

export const binding = (): Binding => ({
  nodeId: 'node',
  workspaceId: 'node:work',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
export const intent = (bound = binding()): ExecutionIntent => {
  const content = {
    binding: bound,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'read',
    arguments: { path: 'file' },
    budgetMs: 1000,
  };
  return { ...content, argumentDigest: intentDigest(content) };
};

describe('environment strict JSON and canonical identity', () => {
  test('rejects duplicate keys including escaped aliases at every depth', () => {
    for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":[{"x":1,"x":2}]}'])
      expect(() => parseJson(input, CONTROL_BYTES)).toThrow('Duplicate');
    expect(parseJson('{"__proto__":{"polluted":true}}', CONTROL_BYTES)).toEqual({
      __proto__: { polluted: true },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test('rejects invalid syntax, numbers, depth and byte overflow', () => {
    for (const input of [
      '01',
      '1e400',
      '[1,]',
      '{"x":1,}',
      'true false',
      'undefined',
      '"bad\ntext"',
      '\u00a0null',
      '[',
      '{',
      '"\\q"',
    ])
      expect(() => parseJson(input, CONTROL_BYTES)).toThrow();
    expect(() => parseJson('['.repeat(66) + '0' + ']'.repeat(66), CONTROL_BYTES)).toThrow(
      'nesting',
    );
    expect(() => parseJson('"漢"', 4)).toThrow('byte');
  });
  test('canonicalization sorts keys but preserves array order and rejects JS-only values', () => {
    expect(canonicalJson({ z: [2, 1], a: true }, 100)).toBe('{"a":true,"z":[2,1]}');
    expect(digest({ a: 1, b: 2 }, 100)).toBe(digest({ b: 2, a: 1 }, 100));
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      { a: undefined },
      [undefined],
      Array(2),
      {
        get a() {
          throw new Error('getter invoked');
        },
      },
    ])
      expect(() => canonicalJson(value, 100)).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalJson(cycle, 100)).toThrow('Cyclic');
    expect(() => canonicalJson({ x: '漢'.repeat(30) }, 80)).toThrow('byte');
  });
  test('matches standard JSON on representative values', () => {
    for (const value of [
      null,
      false,
      true,
      -0,
      -2.5e-10,
      '"\\\n漢',
      [1, null],
      { a: [false, { b: 'x' }] },
    ])
      expect(parseJson(JSON.stringify(value), 1000)).toEqual(JSON.parse(JSON.stringify(value)));
  });
});

describe('closed logical environment protocol (not production transport)', () => {
  test('binds node-qualified workspace and rejects unknown fields', () => {
    expect(() => bindingSchema.parse({ ...binding(), workspaceId: 'other:work' })).toThrow();
    expect(() => bindingSchema.parse({ ...binding(), authorization: true })).toThrow();
  });
  test('intent digest includes every identity, revision, budget and argument', () => {
    const original = intent();
    expect(validateIntent(original)).toEqual(original);
    for (const change of [
      { arguments: { path: 'other' } },
      { executionId: randomUUID() },
      { budgetMs: 999 },
      { binding: binding() },
      { policyRevision: 'c'.repeat(64) },
    ])
      expect(() => validateIntent({ ...original, ...change })).toThrow('digest');
    expect(() => validateIntent({ ...original, arguments: { value: undefined } })).toThrow();
    expect(() => validateIntent({ ...original, approvalId: randomUUID() })).toThrow();
  });
  test('validates versions, duplicate raw fields and correlation envelope', () => {
    const message = {
      version: 1 as const,
      requestId: randomUUID(),
      type: 'execution.start' as const,
      intent: intent(),
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
    expect(() => decodeMessage(JSON.stringify({ ...message, version: 2 }))).toThrow();
    expect(() => decodeMessage(JSON.stringify({ ...message, extra: true }))).toThrow();
    expect(() => decodeMessage('{"version":1,"version":1}')).toThrow('Duplicate');
    expect(() => decodeMessage(JSON.stringify({ ...message, type: 'arbitrary.shell' }))).toThrow();
  });
  test('control messages are bounded independently of logical data messages', () => {
    const value = {
      type: 'execution.event' as const,
      version: 1 as const,
      requestId: randomUUID(),
      event: {
        binding: binding(),
        executionId: randomUUID(),
        seq: 1,
        kind: 'output' as const,
        payload: 'x'.repeat(CONTROL_BYTES),
      },
    };
    expect(() => encodeMessage(value)).toThrow('byte');
    expect(() =>
      validateIntent({ ...intent(), arguments: { x: 'x'.repeat(REQUEST_BYTES) } }),
    ).toThrow('byte');
  });
  test('descriptors have explicit placement, bounded instructions and content revision', () => {
    const content: Omit<Descriptor, 'revision'> = {
      binding: binding(),
      version: 1,
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: [
        {
          name: 'read',
          argumentSchema: {},
          resultSchema: {},
          placement: 'node',
          effects: 'read',
          concurrency: 'read',
          approval: 'policy',
          hookRevision: 'c'.repeat(64),
        },
      ],
      instructions: 'Untrusted project instructions',
      skills: [],
      role: 'coding',
      platform: 'linux',
      cwdDisplay: '/workspace',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    const descriptor = { ...content, revision: descriptorDigest(content) };
    const message = {
      type: 'environment.descriptor' as const,
      version: 1 as const,
      requestId: randomUUID(),
      descriptor,
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
    expect(() =>
      decodeMessage(JSON.stringify({ ...message, descriptor: { ...descriptor, role: 'admin' } })),
    ).toThrow('digest');
    expect(() =>
      decodeMessage(
        JSON.stringify({
          ...message,
          descriptor: {
            ...descriptor,
            capabilityCatalog: [{ ...content.capabilityCatalog[0], placement: undefined }],
          },
        }),
      ),
    ).toThrow();
  });
  test('rejects inconsistent result summaries and tombstones', () => {
    const base = {
      binding: binding(),
      executionId: randomUUID(),
      argumentDigest: 'a'.repeat(64),
      state: 'accepted',
      effect: 'not_started',
      finalSeq: 0,
      cancelRequested: false,
      acknowledged: false,
      reclaimed: false,
    };
    expect(recordSchema.safeParse(base).success).toBe(true);
    expect(recordSchema.safeParse({ ...base, acknowledged: true }).success).toBe(false);
    expect(recordSchema.safeParse({ ...base, state: 'completed' }).success).toBe(false);
    expect(
      recordSchema.safeParse({ ...base, state: 'running', effect: 'completed', reclaimed: true })
        .success,
    ).toBe(false);
  });
});
