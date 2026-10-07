/** Round 3: interleaved main/branch cohorts, their gates, and continuing a stopped run. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  pairedOrder,
  runPairedCohorts,
  validatePairedStopped,
  type PairedRow,
} from './ptc-m1/m4-paired.js';
import { ATTEMPT_RESERVATION_UNITS } from './ptc-m1/openai-budget.js';
import { matrix } from './ptc-m1/synthetic-matrix.js';
import { FIXTURES } from './ptc-m1/fixtures.js';

const template = matrix()[0]!;
const resultFor = (fixture: string, phase: string) => {
  const result = structuredClone(template);
  const kind = FIXTURES.find((f) => f.id === fixture)!.kind;
  result.run.fixture = fixture;
  result.run.kind = kind;
  result.condition = result.run.condition = phase === 'uncached' ? 'uncached' : 'warm';
  return result;
};

describe('round 3 interleaved order', () => {
  it('measures both arms per fixture index, alternating which goes first', () => {
    const order = pairedOrder();
    expect(order).toHaveLength(900);
    expect(order.slice(0, 6).map((p) => `${p.arm}:${p.phase}`)).toEqual([
      'main:uncached',
      'main:prime',
      'main:warm',
      'ptc:uncached',
      'ptc:prime',
      'ptc:warm',
    ]);
    expect(order.slice(6, 12).map((p) => p.arm)).toEqual([
      'ptc',
      'ptc',
      'ptc',
      'main',
      'main',
      'main',
    ]);
    for (const arm of ['main', 'ptc'])
      expect(order.filter((p) => p.arm === arm && p.phase !== 'prime')).toHaveLength(300);
  });

  it('runs every position once, gates rows, stops at the first stage and reuses a prefix', async () => {
    const seen: string[] = [];
    let stages = 0;
    const run = (previous: PairedRow[] = []) =>
      runPairedCohorts({
        signal: new AbortController().signal,
        previous,
        firstStage: async (rows) => {
          stages++;
          expect(rows).toHaveLength(6);
        },
        execute: async (arm, fixture, phase, index) => {
          seen.push(`${arm}:${fixture.id}:${phase}:${index}`);
          return resultFor(fixture.id, phase);
        },
        record: async () => {},
      });
    const full = await run();
    expect(seen).toHaveLength(900);
    expect(stages).toBe(1);
    expect(full.measured.main).toHaveLength(300);
    expect(full.complete).toBe(true);
    // A resumed run dispatches only what is missing and skips the stage.
    seen.length = 0;
    const prefix = full.rows.slice(0, 9);
    await run(prefix);
    expect(seen).toHaveLength(891);
    expect(stages).toBe(1);
    // A prefix ending before a warm row is refused (its prime's pair is gone).
    await expect(run(full.rows.slice(0, 2))).rejects.toThrow('Invalid paired resume prefix');
    // A row failing a gate stops the run.
    await expect(
      runPairedCohorts({
        signal: new AbortController().signal,
        firstStage: async () => {},
        execute: async (_arm, fixture, phase) => {
          const result = resultFor(fixture.id, phase);
          result.run.allAttemptsAccounted = false;
          return result;
        },
        record: async () => {},
      }),
    ).rejects.toThrow('accounting incomplete');
  });
});

describe('continuing a stopped round 3 run', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const carry = { spentUnits: 5000, admittedAttempts: 50 };
  const COST = 100 * 20 + 20 * 100;
  function stopped(count: number, previous: PairedRow[] = []) {
    const order = pairedOrder();
    let spent = carry.spentUnits,
      attempts = carry.admittedAttempts;
    const rows = order.slice(previous.length, previous.length + count).map((position, i) => {
      const result = resultFor(position.fixture, position.phase);
      const last = i === count - 1;
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
      result.run.budget = { ...result.run.budget, spentUnits: spent, admittedAttempts: attempts };
      return { ...position, result };
    });
    const ledger = [
      carry,
      {
        spentUnits: spent,
        admittedAttempts: attempts,
        reservedUnits: ATTEMPT_RESERVATION_UNITS,
        unknownAttempts: 1,
        halted: true,
      },
    ];
    const manifest = {
      kind: 'ptc-m4-paired',
      controllerSourceHash: 'ctl',
      carry,
      reusedRows: previous.length,
      tag: 'ok',
    };
    const texts = {
      trials: [manifest, ...rows].map((v) => JSON.stringify(v)).join('\n') + '\n',
      budget: ledger.map((v) => JSON.stringify(v)).join('\n') + '\n',
      summary: JSON.stringify({ complete: false, budget: ledger.at(-1) }),
    };
    const pin = {
      name: 'ptc-m4-r3-001',
      trials: sha256(texts.trials),
      budget: sha256(texts.budget),
      summary: sha256(texts.summary),
      controller: 'ctl',
      carry,
    };
    return { texts, pin, spent, attempts };
  }
  const check = (manifest: any) => manifest.tag === 'ok';

  it('reuses rows, charges the uncertain attempt in full and supersedes the stop', () => {
    // Row 4 is ptc:uncached of the first index; the main triplet before it is kept.
    const { texts, pin, spent, attempts } = stopped(4);
    const step = validatePairedStopped(texts, pin, [], check);
    expect(step.rows.map((r) => `${r.arm}:${r.phase}`)).toEqual([
      'main:uncached',
      'main:prime',
      'main:warm',
    ]);
    expect(step.carry).toEqual({
      spentUnits: spent + ATTEMPT_RESERVATION_UNITS,
      admittedAttempts: attempts,
    });
    expect(step.superseded).toEqual([
      {
        arm: 'ptc',
        fixture: 'single-bash',
        phase: 'uncached',
        index: 0,
        reason: 'uncertain_usage',
      },
    ]);
    // Stopping on a warm row also drops its prime.
    const warm = stopped(3);
    expect(
      validatePairedStopped(warm.texts, warm.pin, [], check).superseded.map((s) => s.reason),
    ).toEqual(['uncertain_usage', 'pair_lost']);
  });

  it('refuses tampering, a failed manifest check and a wrong previous prefix', () => {
    const { texts, pin } = stopped(4);
    expect(() =>
      validatePairedStopped({ ...texts, summary: texts.summary + ' ' }, pin, [], check),
    ).toThrow('hash mismatch');
    expect(() => validatePairedStopped(texts, pin, [], () => false)).toThrow('manifest mismatch');
    const prefix = validatePairedStopped(texts, pin, [], check).rows;
    expect(() => validatePairedStopped(texts, pin, prefix, check)).toThrow('manifest mismatch');
  });
});
