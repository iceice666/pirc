import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  APPROVED_OPENAI_001,
  openAIOrder,
  validateOpenAIResume,
  validateOpenAIResume002,
  validateOpenAIContinuation,
  validateOpenAIRemeasure,
  AUTHORIZATION_FIXTURES,
} from './ptc-m1/openai-resume.js';
import { OPENAI_PROTOCOL, openAICostUnits } from './ptc-m1/openai-contract.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
const carry = { spentUnits: 53688009, admittedAttempts: 1030, reservedUnits: 0, halted: false };
function fixture(): any[] {
  const manifest = {
    kind: 'manifest',
    provider: 'openai',
    protocol: OPENAI_PROTOCOL,
    baseline: '16c80846da64c07114d8cd43bab68748e5474127',
    controllerSourceHash: APPROVED_OPENAI_001.controller,
    fixtureHash: APPROVED_OPENAI_001.fixture,
    pins: {
      node: '164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80',
      chat: 'be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf',
    },
    endpointFingerprint: 'd9617135d6fdd0a2cde722d637a1dfcc3da37515708b3ea5d66ae607c8ac785e',
  };
  let spent = 0,
    count = 0;
  const rows = openAIOrder()
    .slice(0, 271)
    .map((position, i) => {
      const number = i === 270 ? 17 : i === 269 ? 206 : 3;
      const attempts = Array.from({ length: number }, () => {
        count++;
        const usage =
          count === 1030
            ? {
                input: 111900,
                output: 0,
                cacheRead: 9,
                cacheWrite: 0,
                reasoning: 0,
                totalTokens: 111909,
              }
            : {
                input: 2500,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                totalTokens: 2500,
              };
        spent += openAICostUnits(usage);
        return {
          usage,
          generationComplete: true,
          cacheConditionValid: true,
          completion: 'complete',
        };
      });
      return {
        ...position,
        result: {
          provenance: 'real-openai',
          condition: position.phase === 'uncached' ? 'uncached' : 'warm',
          infrastructureValid: true,
          cacheVerified: position.phase !== 'prime',
          run: {
            fixture: position.fixture,
            kind: FIXTURES.find((f) => f.id === position.fixture)!.kind,
            infrastructureValid: true,
            budgetValid: true,
            childrenAccounted: i !== 270,
            allAttemptsAccounted: true,
            success: i !== 270,
            accounting: {
              verified: true,
              attempts: number,
              requests: number,
              owners: { parent: 6, child: 7, auxiliary: 4, unknown: 0 },
            },
            metrics: { requestCount: number, missingUsage: 0 },
            attempts,
            budget: { spentUnits: spent, admittedAttempts: count, reservedUnits: 0, halted: false },
            teamEvidence: { waited: false, childWriteConfirmed: true, childCompleted: true },
          },
        },
      };
    });
  return [manifest, ...rows];
}
function validate(rows: any[], budget = carry) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return validateOpenAIResume(text, createHash('sha256').update(text).digest('hex'), budget);
}
test('resume validator recomputes complete prefix and only corrects derived accounting flag', () => {
  const rows = fixture(),
    before = JSON.stringify(rows);
  const proof = validate(rows);
  expect(proof.carry).toEqual({ spentUnits: 53688009, admittedAttempts: 1030 });
  expect(proof.next).toEqual({ fixture: 'team-wait', phase: 'prime', index: 0 });
  expect(proof.rows.at(-1)!.result.run.childrenAccounted).toBe(true);
  expect(proof.rows.at(-1)!.result.run.success).toBe(false);
  expect(JSON.stringify(rows)).toBe(before);
});
test('resume rejects hash, manifest, ordering, provenance, boundary and budget mismatches', () => {
  expect(() => validateOpenAIResume('{}\n', APPROVED_OPENAI_001.trials, carry)).toThrow('hash');
  const changes: Array<(rows: any[]) => void> = [
    (r) => {
      r[0].pins.node = 'wrong';
    },
    (r) => {
      r.pop();
    },
    (r) => {
      r[1].index = 9;
    },
    (r) => {
      r[1].result.provenance = 'synthetic';
    },
    (r) => {
      r[1].result.run.childrenAccounted = false;
    },
    (r) => {
      r.at(-1).result.run.childrenAccounted = true;
    },
    (r) => {
      r.at(-1).result.run.accounting.requests = 16;
    },
    (r) => {
      r[1].result.run.attempts[0].usage = null;
    },
    (r) => {
      r[1].result.run.budget.spentUnits++;
    },
  ];
  for (const mutate of changes) {
    const rows = fixture();
    mutate(rows);
    expect(() => validate(rows)).toThrow();
  }
  expect(() => validate(fixture(), { ...carry, spentUnits: 0 })).toThrow('budget');
});

const usage = {
  input: 2500,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 2500,
};
const attempt = {
  usage,
  generationComplete: true,
  cacheConditionValid: true,
  completion: 'complete',
};
function chain() {
  const base = validate(fixture());
  const unit = openAICostUnits(usage);
  const afterPrime = { spentUnits: 53688009 + 18 * unit, admittedAttempts: 1048 };
  const snapshot = (b: { spentUnits: number; admittedAttempts: number }) => ({
    currency: 'USD',
    provider: 'openai',
    limitUsd: 100,
    spentUnits: b.spentUnits,
    reservedUnits: 0,
    unknownAttempts: 0,
    admittedAttempts: b.admittedAttempts,
    halted: false,
  });
  const manifest = {
    ...fixture()[0],
    controllerSourceHash: 'controller-002',
    continuation: {
      original: APPROVED_OPENAI_001,
      correction: base.correction,
      carry: base.carry,
      next: { fixture: 'team-wait', index: 0, phase: 'prime' },
    },
  };
  const prime = {
    fixture: 'team-wait',
    phase: 'prime',
    index: 0,
    result: {
      provenance: 'real-openai',
      condition: 'warm',
      infrastructureValid: true,
      cacheVerified: false,
      run: {
        fixture: 'team-wait',
        kind: 'coding',
        success: false,
        infrastructureValid: true,
        budgetValid: true,
        allAttemptsAccounted: true,
        childrenAccounted: true,
        accounting: {
          verified: true,
          attempts: 18,
          requests: 18,
          owners: { parent: 6, child: 8, auxiliary: 4, unknown: 0 },
        },
        metrics: { requestCount: 18, missingUsage: 0 },
        attempts: Array.from({ length: 18 }, () => attempt),
        budget: snapshot(afterPrime),
      },
    },
  };
  const final = { spentUnits: afterPrime.spentUnits + 12 * unit, admittedAttempts: 1060 };
  const parts = {
    trials: [manifest, prime].map((x) => JSON.stringify(x)).join('\n') + '\n',
    budget: [snapshot(base.carry), snapshot(afterPrime)].map((x) => JSON.stringify(x)).join('\n'),
    summary: JSON.stringify({ complete: false, budget: snapshot(afterPrime) }),
  };
  const pins = {
    openai002: {
      trials: '',
      budget: '',
      summary: '',
      controller: 'controller-002',
    },
    diagnostic: { report: '', budget: '' },
  };
  const diag = (pinsNow: typeof pins) => ({
    report: JSON.stringify({
      kind: 'team-diagnostic-not-baseline',
      oracleRevision: 2,
      sourcePins: {
        trials: pinsNow.openai002.trials,
        budget: pinsNow.openai002.budget,
        summary: pinsNow.openai002.summary,
      },
      carry: afterPrime,
      completed: true,
      success: false,
      result: {
        attempts: Array.from({ length: 12 }, () => attempt),
        accounting: { verified: true, attempts: 12 },
        metrics: { missingUsage: 0 },
      },
      budget: snapshot(final),
    }),
    budget: [snapshot(afterPrime), snapshot(final)].map((x) => JSON.stringify(x)).join('\n'),
  });
  return { base, parts, pins, diag, final };
}
const h = (text: string) => createHash('sha256').update(text).digest('hex');
function validateChain(
  mutate?: (c: ReturnType<typeof chain>) => void,
  mutateDiag?: (d: any) => void,
) {
  const c = chain();
  mutate?.(c);
  c.pins.openai002.trials = h(c.parts.trials);
  c.pins.openai002.budget = h(c.parts.budget);
  c.pins.openai002.summary = h(c.parts.summary);
  const d = c.diag(c.pins);
  mutateDiag?.(d);
  c.pins.diagnostic.report = h(d.report);
  c.pins.diagnostic.budget = h(d.budget);
  return { c, proof: validateOpenAIResume002(c.base, c.parts, d, c.pins) };
}
test('openai-002 chain carries prime and diagnostic spend without new rows or replay', () => {
  const { c, proof } = validateChain();
  expect(proof.rows).toHaveLength(271);
  expect(proof.rows).toBe(c.base.rows);
  expect(proof.next).toEqual({ fixture: 'team-wait', index: 0, phase: 'prime' });
  expect(proof.carry).toEqual({ spentUnits: c.final.spentUnits, admittedAttempts: 1060 });
  expect(proof.supersededPrime).toMatchObject({ taskSuccess: false, attempts: 18 });
  expect(proof.diagnosticAttempts).toBe(12);
});
test('openai-002 chain rejects hash, manifest, prime, budget and diagnostic mismatches', () => {
  const c = chain();
  const d = c.diag(c.pins);
  expect(() => validateOpenAIResume002(c.base, c.parts, d)).toThrow('hash');
  const replace =
    (field: 'trials' | 'budget' | 'summary', from: string, to: string) => (x: any) => {
      x.parts[field] = x.parts[field].replace(from, to);
    };
  for (const mutate of [
    replace('trials', '"controllerSourceHash":"controller-002"', '"controllerSourceHash":"x"'),
    replace('trials', '"success":false', '"success":true'),
    replace('trials', '"unknown":0', '"unknown":1'),
    replace('trials', '"provenance":"real-openai"', '"provenance":"synthetic"'),
    replace('summary', '"complete":false', '"complete":true'),
    replace('budget', '"admittedAttempts":1048', '"admittedAttempts":1047'),
    replace('budget', '"admittedAttempts":1030', '"admittedAttempts":1029'),
    (x: any) => {
      x.parts.trials += JSON.stringify({ fixture: 'team-wait', phase: 'warm', index: 0 }) + '\n';
    },
  ])
    expect(() => validateChain(mutate)).toThrow();
  for (const mutateDiag of [
    (d: any) => {
      d.report = d.report.replace('"oracleRevision":2', '"oracleRevision":1');
    },
    (d: any) => {
      d.report = d.report.replace('"completed":true', '"completed":false');
    },
    (d: any) => {
      d.report = d.report.replace('"verified":true', '"verified":false');
    },
    (d: any) => {
      d.budget = d.budget.replace('"admittedAttempts":1060', '"admittedAttempts":1061');
    },
    (d: any) => {
      d.report = d.report.replace('"generationComplete":true', '"generationComplete":false');
    },
  ])
    expect(() => validateChain(undefined, mutateDiag)).toThrow();
  const base = validate(fixture());
  expect(() =>
    validateChain((x: any) => {
      x.base = { ...base, carry: { ...base.carry, spentUnits: 1 } };
    }),
  ).toThrow('base');
});

function continuation(stop: 'valid' | 'uncached' | 'warm' | 'prime-gen', count = 6) {
  const order = openAIOrder();
  const start = 271; // team-wait prime 0
  const prev = {
    rows: order.slice(0, start).map((x) => ({ ...x, result: {} })) as any[],
    carry: { spentUnits: 1000, admittedAttempts: 10 },
    next: order[start]!,
  };
  let spent = prev.carry.spentUnits,
    count2 = prev.carry.admittedAttempts;
  const rows = order.slice(start, start + count).map((position, i) => {
    spent += openAICostUnits(usage) * 2;
    count2 += 2;
    const last = i === count - 1;
    const row: any = {
      ...position,
      result: {
        provenance: 'real-openai',
        condition: position.phase === 'uncached' ? 'uncached' : 'warm',
        infrastructureValid: true,
        cacheVerified: position.phase !== 'prime',
        run: {
          fixture: position.fixture,
          kind: FIXTURES.find((f) => f.id === position.fixture)!.kind,
          success: position.phase !== 'prime',
          infrastructureValid: true,
          budgetValid: true,
          allAttemptsAccounted: true,
          childrenAccounted: true,
          accounting: { verified: true, attempts: 2 },
          metrics: { requestCount: 2, missingUsage: 0 },
          attempts: [attempt, attempt].map((a) => ({ ...a })),
          budget: { spentUnits: spent, admittedAttempts: count2, reservedUnits: 0, halted: false },
        },
      },
    };
    if (last && stop !== 'valid') {
      if (stop === 'prime-gen') row.result.run.attempts[0].generationComplete = false;
      else row.result.run.infrastructureValid = false;
    }
    return row;
  });
  const manifest = {
    ...fixture()[0],
    controllerSourceHash: 'controller-003',
    continuation: { primeOutcome: 'record', carry: prev.carry, next: prev.next },
  };
  const snap = (spentUnits: number, admittedAttempts: number) => ({
    spentUnits,
    admittedAttempts,
    reservedUnits: 0,
    unknownAttempts: 0,
    halted: false,
  });
  const texts = {
    trials: [manifest, ...rows].map((x) => JSON.stringify(x)).join('\n') + '\n',
    budget: [snap(1000, 10), snap(spent, count2)].map((x) => JSON.stringify(x)).join('\n'),
    summary: JSON.stringify({ complete: false, budget: snap(spent, count2) }),
  };
  const pin = {
    name: 'openai-003',
    trials: h(texts.trials),
    budget: h(texts.budget),
    summary: h(texts.summary),
    controller: 'controller-003',
  };
  return { prev, texts, pin, rows, spent, count2 };
}
test('generic continuation supersedes only the stopping row (and its orphaned prime) and carries all spend', () => {
  // order from team-wait prime 0: prime0, warm0, uncached1, prime1, warm1, uncached2
  const a = continuation('uncached', 6);
  const s1 = validateOpenAIContinuation(a.prev, a.texts, a.pin);
  expect(s1.rows).toHaveLength(271 + 5);
  expect(s1.next).toEqual({ fixture: 'team-wait', index: 2, phase: 'uncached' });
  expect(s1.carry).toEqual({ spentUnits: a.spent, admittedAttempts: a.count2 });
  expect(s1.superseded).toEqual([
    { fixture: 'team-wait', phase: 'uncached', index: 2, reason: 'gate' },
  ]);
  const b = continuation('warm', 5);
  const s2 = validateOpenAIContinuation(b.prev, b.texts, b.pin);
  expect(s2.rows).toHaveLength(271 + 3);
  expect(s2.next).toEqual({ fixture: 'team-wait', index: 1, phase: 'prime' });
  expect(s2.superseded.map((x) => x.reason)).toEqual(['gate', 'pair_lost']);
  const c = continuation('prime-gen', 4);
  const s3 = validateOpenAIContinuation(c.prev, c.texts, c.pin);
  expect(s3.next).toEqual({ fixture: 'team-wait', index: 1, phase: 'prime' });
  const d = continuation('valid', 6);
  expect(validateOpenAIContinuation(d.prev, d.texts, d.pin).rows).toHaveLength(277);
  // A failed-task prime is retained in record mode.
  expect(s1.rows[271]!.result.run.success).toBe(false);
});
test('generic continuation rejects tampering, mid-run invalid rows and budget gaps', () => {
  const base = continuation('uncached', 6);
  expect(() =>
    validateOpenAIContinuation(base.prev, base.texts, { ...base.pin, trials: 'x' }),
  ).toThrow('hash');
  const mutate = (fn: (x: ReturnType<typeof continuation>) => void) => {
    const x = continuation('uncached', 6);
    fn(x);
    const texts = {
      trials:
        [JSON.parse(x.texts.trials.split('\n')[0]!), ...x.rows]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
      budget: x.texts.budget,
      summary: x.texts.summary,
    };
    return () =>
      validateOpenAIContinuation(x.prev, texts, {
        ...x.pin,
        trials: h(texts.trials),
      });
  };
  expect(
    mutate((x) => {
      x.rows[1].result.run.infrastructureValid = false;
    }),
  ).toThrow('before stop');
  expect(
    mutate((x) => {
      x.rows[1].result.cacheVerified = false;
    }),
  ).toThrow('before stop');
  expect(
    mutate((x) => {
      x.rows[2].index = 7;
    }),
  ).toThrow('sequence');
  expect(
    mutate((x) => {
      x.rows[3].result.run.budget.spentUnits++;
    }),
  ).toThrow('budget');
  expect(
    mutate((x) => {
      x.rows[0].result.run.attempts[0].usage = null;
    }),
  ).toThrow('usage');
  expect(
    mutate((x) => {
      x.prev.carry = { spentUnits: 1, admittedAttempts: 10 };
    }),
  ).toThrow('manifest');
});

function remeasure(edit?: (rows: any[], manifest: any) => void) {
  const order = openAIOrder();
  const prev = {
    rows: order.map((x) => ({ ...x, result: { old: true } })) as any[],
    carry: { spentUnits: 5000, admittedAttempts: 50 },
  };
  let spent = 5000,
    n = 50;
  const rows = order
    .filter((o) => (AUTHORIZATION_FIXTURES as readonly string[]).includes(o.fixture))
    .map((position) => {
      spent += openAICostUnits(usage);
      n++;
      return {
        ...position,
        result: {
          provenance: 'real-openai',
          condition: position.phase === 'uncached' ? 'uncached' : 'warm',
          infrastructureValid: true,
          cacheVerified: position.phase !== 'prime',
          run: {
            fixture: position.fixture,
            kind: FIXTURES.find((f) => f.id === position.fixture)!.kind,
            success: true,
            outcome: { success: true, authorizationEnforced: true },
            infrastructureValid: true,
            budgetValid: true,
            allAttemptsAccounted: true,
            childrenAccounted: true,
            accounting: { verified: true, attempts: 1 },
            metrics: { requestCount: 1, missingUsage: 0 },
            attempts: [{ ...attempt }],
            budget: { spentUnits: spent, admittedAttempts: n, reservedUnits: 0, halted: false },
          },
        },
      };
    });
  const manifest = {
    ...fixture()[0],
    controllerSourceHash: 'controller-005',
    remeasure: { fixtures: AUTHORIZATION_FIXTURES, primeOutcome: 'record', carry: prev.carry },
  };
  edit?.(rows, manifest);
  const snap = (spentUnits: number, admittedAttempts: number) => ({
    spentUnits,
    admittedAttempts,
    reservedUnits: 0,
    unknownAttempts: 0,
    halted: false,
  });
  const texts = {
    trials: [manifest, ...rows].map((x) => JSON.stringify(x)).join('\n') + '\n',
    budget: [snap(5000, 50), snap(spent, n)].map((x) => JSON.stringify(x)).join('\n'),
    summary: JSON.stringify({ complete: false, budget: snap(spent, n) }),
  };
  const pin = {
    name: 'openai-005',
    fixtures: AUTHORIZATION_FIXTURES,
    trials: h(texts.trials),
    budget: h(texts.budget),
    summary: h(texts.summary),
    controller: 'controller-005',
  };
  return () => validateOpenAIRemeasure(prev, texts, pin);
}
test('whole-category re-measure replaces exactly those cohorts in place and carries spend', () => {
  const proof = remeasure()();
  const order = openAIOrder();
  expect(proof.rows).toHaveLength(order.length);
  expect(proof.supersededRows).toHaveLength(120);
  proof.rows.forEach((row: any, i) => {
    expect([row.fixture, row.phase, row.index]).toEqual([
      order[i]!.fixture,
      order[i]!.phase,
      order[i]!.index,
    ]);
    expect(row.result.old === true).toBe(
      !(AUTHORIZATION_FIXTURES as readonly string[]).includes(row.fixture),
    );
  });
  expect(proof.carry).toEqual({
    spentUnits: 5000 + 120 * openAICostUnits(usage),
    admittedAttempts: 170,
  });
});
test('re-measure rejects partial cohorts, invalid rows, wrong fixture and carry gaps', () => {
  for (const edit of [
    (r: any[]) => r.pop(),
    (r: any[]) => (r[3].result.run.infrastructureValid = false),
    (r: any[]) => (r[2].result.cacheVerified = false),
    (r: any[]) => (r[0].index = 4),
    (_r: any[], m: any) => (m.remeasure.fixtures = ['schedule']),
    (r: any[]) => (r[5].result.run.outcome.authorizationEnforced = null),
    (_r: any[], m: any) => (m.remeasure.carry = { spentUnits: 1, admittedAttempts: 50 }),
  ])
    expect(remeasure(edit)).toThrow();
  // A failed task stays a measured row (not a gate failure).
  expect(() => remeasure((r) => (r[0].result.run.success = false))()).not.toThrow();
});
