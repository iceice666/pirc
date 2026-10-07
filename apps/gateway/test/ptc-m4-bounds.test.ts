/** M4 bounds against the accepted M1 baseline aggregates, with synthetic PTC matrices. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateM4, type BaselineReport } from './ptc-m1/m4-bounds.js';
import { matrix } from './ptc-m1/synthetic-matrix.js';
import type { OpenAICohortResult } from './ptc-m1/openai-cohort.js';

const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dir, '../../../plans/ptc-m1-openai-baseline.json'), 'utf8'),
) as BaselineReport;
const groupOf = (kind: 'coding' | 'chat', fixture: string, condition: string) =>
  baseline.aggregates[kind].groups.find((g) => g.fixture === fixture && g.condition === condition)!;

/** A PTC matrix shaped like the baseline, scaled per fixture. */
function shaped(scale: (fixture: string) => { tokens?: number; wall?: number; rounds?: number }) {
  const rows = matrix();
  const index = new Map<string, number>();
  for (const row of rows) {
    const run = row.run;
    const g = groupOf(run.kind, run.fixture, row.condition);
    const key = `${run.fixture}/${row.condition}`;
    const n = index.get(key) ?? 0;
    index.set(key, n + 1);
    const s = scale(run.fixture);
    const tokens = Math.round(g.meanTokens! * (s.tokens ?? 0.9));
    run.metrics.input = tokens - 20;
    run.metrics.totalTokens = tokens;
    run.attempts[0]!.usage!.input = tokens - 20;
    run.attempts[0]!.usage!.totalTokens = tokens;
    run.measurement!.wallMs = g.meanWallMs! * (s.wall ?? 1);
    run.metrics.modelRounds = Math.max(1, Math.round(g.meanModelRounds! * (s.rounds ?? 0.5)));
    // Same per-trial success count as the baseline.
    run.success = n < g.successes;
    run.outcome!.success = run.success;
    run.outcome!.authorizationEnforced = [
      'approval-denial',
      'permission-rejection',
      'chat-permission',
      'schedule',
    ].includes(run.fixture)
      ? true
      : null;
  }
  return rows;
}

test('the accepted baseline report is the M1 baseline', () => {
  expect(baseline.readiness.complete).toBe(true);
  expect(baseline.measuredTrials).toBe(300);
});

test('a PTC matrix within every bound passes coding and chat', () => {
  const result = evaluateM4(
    baseline,
    shaped(() => ({})),
  );
  expect(result.readiness.complete).toBe(true);
  const failing = [...result.verdicts.coding.checks, ...result.verdicts.chat.checks].filter(
    (c) => !c.pass,
  );
  expect(failing).toEqual([]);
  expect(result.pass).toBe(true);
});

test('each bound fails on its own', () => {
  const fails = (rows: OpenAICohortResult[], kind: 'coding' | 'chat') =>
    evaluateM4(baseline, rows)
      .verdicts[kind].checks.filter((c) => !c.pass)
      .map((c) => `${c.bound}:${c.fixture ?? ''}:${c.condition ?? ''}:${c.metric}`);
  // Single call: +16% tokens.
  expect(
    fails(
      shaped((f) => (f === 'single-read' ? { tokens: 1.16 } : {})),
      'coding',
    ),
  ).toEqual(['single:single-read:uncached:mean tokens', 'single:single-read:warm:mean tokens']);
  // Single call: +21% wall (chat judged separately).
  expect(
    fails(
      shaped((f) => (f === 'chat-web-search' ? { wall: 1.21 } : {})),
      'chat',
    ),
  ).toEqual([
    'single:chat-web-search:uncached:mean wall ms',
    'single:chat-web-search:warm:mean wall ms',
  ]);
  // Batch: as many rounds as the baseline is not fewer.
  expect(
    fails(
      shaped((f) => (f === 'multi-edit' ? { rounds: 1.1 } : {})),
      'coding',
    ),
  ).toEqual([
    'batch:multi-edit:uncached:mean model rounds',
    'batch:multi-edit:warm:mean model rounds',
  ]);
  // Total: every fixture above baseline tokens fails the total too.
  const heavy = fails(
    shaped(() => ({ tokens: 1.1 })),
    'coding',
  );
  expect(heavy).toContain('total::uncached:weighted mean tokens');
  expect(heavy).toContain('total::warm:weighted mean tokens');
  // Success: one fewer success in a fixture.
  const fewer = shaped(() => ({}));
  fewer.find((r) => r.run.fixture === 'dependent-edit')!.run.success = false;
  expect(fails(fewer, 'coding')).toEqual(['success:dependent-edit::successes (uncached + warm)']);
  // Authorization: one unenforced trial; it also leaves the matrix not ready.
  const breach = shaped(() => ({}));
  breach.find((r) => r.run.fixture === 'schedule')!.run.outcome!.authorizationEnforced = false;
  expect(fails(breach, 'coding')).toEqual([
    'readiness:::missing',
    'authorization:schedule:uncached:enforced trials',
  ]);
  // Cancellation: one trial not cancelled.
  const uncancelled = shaped(() => ({}));
  uncancelled.find((r) => r.run.fixture === 'cancel-wait')!.run.outcome!.cancellationObserved =
    false;
  expect(fails(uncancelled, 'coding')).toContain(
    'cancellation:cancel-wait:uncached:cancelled trials',
  );
  // A short matrix is never accepted.
  const short = shaped(() => ({}));
  short.pop();
  expect(evaluateM4(baseline, short).pass).toBe(false);
});
