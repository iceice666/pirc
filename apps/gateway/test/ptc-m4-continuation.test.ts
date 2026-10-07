/** Continuing a stopped M4 run: rows reused, uncertain usage charged in full, stop superseded. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { ATTEMPT_RESERVATION_UNITS, validateM4Stopped } from './ptc-m1/m4-continuation.js';
import { matrix } from './ptc-m1/synthetic-matrix.js';
import { APPROVED_OPENAI_001, openAIOrder } from './ptc-m1/openai-resume.js';
import { M4_BOUNDS } from './ptc-m1/m4-bounds.js';
import { PTC_ORACLE_MAPPING } from './ptc-m1/ptc-surface.js';
import { TEAM_ORACLE_REVISION } from './ptc-m1/team-evidence.js';
import { OPENAI_PROTOCOL } from './ptc-m1/openai-contract.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const carry = { spentUnits: 1000, admittedAttempts: 10 };
const pins = { node: 'n', chat: 'c' };
const COST = 100 * 20 + 20 * 100; // The synthetic attempt: 100 input, 20 output tokens.

/** A stopped run of `count` rows whose last row has one attempt without usage. */
function stoppedRun(
  count: number,
  edit: (rows: any[], ledger: any[]) => void = () => {},
  stopped = true,
) {
  const template = matrix()[0]!;
  const order = openAIOrder();
  let spent = carry.spentUnits,
    attempts = carry.admittedAttempts;
  const rows: any[] = order.slice(0, count).map((position, i) => {
    const result = structuredClone(template);
    result.run.fixture = position.fixture;
    result.condition = result.run.condition = position.phase === 'uncached' ? 'uncached' : 'warm';
    const last = stopped && i === count - 1;
    if (last) {
      result.run.attempts.push({
        ...structuredClone(result.run.attempts[0]!),
        usage: null,
        completion: 'cancelled',
        generationComplete: false,
        cacheConditionValid: false,
      } as never);
      result.run.allAttemptsAccounted = false;
    }
    spent += COST;
    attempts += result.run.attempts.length;
    result.run.budget = {
      ...result.run.budget,
      spentUnits: spent,
      admittedAttempts: attempts,
      reservedUnits: last ? ATTEMPT_RESERVATION_UNITS : 0,
      halted: last,
    };
    return { ...position, result };
  });
  const ledger = [
    { spentUnits: carry.spentUnits, admittedAttempts: carry.admittedAttempts },
    {
      spentUnits: spent,
      admittedAttempts: attempts,
      reservedUnits: stopped ? ATTEMPT_RESERVATION_UNITS : 0,
      unknownAttempts: stopped ? 1 : 0,
      halted: stopped,
    },
  ];
  edit(rows, ledger);
  const manifest = {
    kind: 'ptc-m4',
    provider: 'openai',
    primeOutcome: 'record',
    controllerSourceHash: 'ctl',
    pins,
    carry,
    protocol: OPENAI_PROTOCOL,
    fixtureHash: APPROVED_OPENAI_001.fixture,
    oracleMapping: PTC_ORACLE_MAPPING,
    teamOracleRevision: TEAM_ORACLE_REVISION,
    bounds: M4_BOUNDS,
  };
  const texts = {
    trials: [manifest, ...rows].map((v) => JSON.stringify(v)).join('\n') + '\n',
    budget: ledger.map((v) => JSON.stringify(v)).join('\n') + '\n',
    summary: JSON.stringify({ complete: false, budget: ledger.at(-1) }),
  };
  const pin = {
    name: 'ptc-m4-x',
    pins,
    controller: 'ctl',
    trials: sha256(texts.trials),
    budget: sha256(texts.budget),
    summary: sha256(texts.summary),
    carry,
  };
  return { texts, pin, spent, attempts };
}

describe('stopped M4 run continuation', () => {
  it('reuses rows, charges the uncertain attempt in full and repeats the stopping row', () => {
    // Row 7 is an uncached row (positions: uncached, prime, warm, ...).
    const { texts, pin, spent, attempts } = stoppedRun(7);
    const result = validateM4Stopped(texts, pin);
    expect(result.rows).toHaveLength(6);
    expect(result.next).toEqual(openAIOrder()[6]!);
    expect(result.carry).toEqual({
      spentUnits: spent + ATTEMPT_RESERVATION_UNITS,
      admittedAttempts: attempts,
    });
    expect(result.superseded).toEqual([
      { fixture: 'single-bash', phase: 'uncached', index: 2, reason: 'uncertain_usage' },
    ]);
  });

  it('drops a trailing prime whose warm pair died with the stopped process', () => {
    // Row 9 is a warm row; the prime before it loses its pair.
    const result = validateM4Stopped(stoppedRun(9).texts, stoppedRun(9).pin);
    expect(result.rows).toHaveLength(7);
    expect(result.superseded.map((s) => s.reason)).toEqual(['uncertain_usage', 'pair_lost']);
  });

  it('refuses tampered artifacts, missing usage before the stop and budget drift', () => {
    const { texts, pin } = stoppedRun(7);
    expect(() => validateM4Stopped({ ...texts, budget: texts.budget + ' ' }, pin)).toThrow(
      'hash mismatch',
    );
    expect(() => validateM4Stopped(texts, { ...pin, carry: { ...carry, spentUnits: 0 } })).toThrow(
      'manifest mismatch',
    );
    const early = stoppedRun(7, (rows) => {
      rows[2].result.run.attempts[0].usage = null;
    });
    expect(() => validateM4Stopped(early.texts, early.pin)).toThrow('usage missing before');
    const drift = stoppedRun(7, (_rows, ledger) => {
      ledger.at(-1).reservedUnits = 0;
    });
    expect(() => validateM4Stopped(drift.texts, drift.pin)).toThrow('budget mismatch');
    const complete = stoppedRun(7, () => {}, false);
    expect(() => validateM4Stopped(complete.texts, complete.pin)).toThrow('no stopping row');
    const invalid = stoppedRun(7, (rows) => {
      rows[2].result.cacheVerified = false; // A warm row without cache evidence.
    });
    expect(() => validateM4Stopped(invalid.texts, invalid.pin)).toThrow('row invalid');
    const unknown = stoppedRun(7, (_rows, ledger) => {
      ledger.at(-1).unknownAttempts = 2;
    });
    expect(() => validateM4Stopped(unknown.texts, unknown.pin)).toThrow('budget mismatch');
    expect(() => validateM4Stopped(texts, { ...pin, pins: { node: 'x', chat: 'c' } })).toThrow(
      'manifest mismatch',
    );
  });
});
