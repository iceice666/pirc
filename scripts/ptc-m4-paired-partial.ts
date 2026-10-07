/**
 * Aggregate-only partial report of the stopped round 3 (plans/ptc-m4-evaluation.md): the
 * pinned stop chain, the fixtures complete in both arms compared against the concurrent `main`
 * arm, and the M1 baseline for reference. Not a verdict: the matrix is incomplete. No spend.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { OPENAI_PROTOCOL } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import { APPROVED_OPENAI_001 } from '../apps/gateway/test/ptc-m1/openai-resume.js';
import { authorizationEnforced } from '../apps/gateway/test/ptc-m1/openai-readiness.js';
import { M4_BOUNDS } from '../apps/gateway/test/ptc-m1/m4-bounds.js';
import { PTC_ORACLE_MAPPING } from '../apps/gateway/test/ptc-m1/ptc-surface.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';
import { M4_BASELINE, M4_R3, M4_R3_STOPS, m4R3Run } from '../apps/gateway/test/ptc-m1/m4-run.js';
import {
  ARMS,
  validatePairedStopped,
  type Arm,
  type PairedRow,
} from '../apps/gateway/test/ptc-m1/m4-paired.js';
import { FIXTURES } from '../apps/gateway/test/ptc-m1/fixtures.js';
import type { OpenAICohortResult } from '../apps/gateway/test/ptc-m1/openai-cohort.js';

const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const root = path.resolve(import.meta.dir, '..');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
const m1Text = await readFile(path.join(root, 'plans/ptc-m1-openai-baseline.json'), 'utf8');
if (sha256(m1Text) !== M4_BASELINE.plansReport) throw new Error('Baseline report pin');
const m1 = JSON.parse(m1Text);
const expected = {
  provider: 'openai',
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  arms: M4_R3.arms,
  protocol: OPENAI_PROTOCOL,
  oracleMapping: PTC_ORACLE_MAPPING,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  bounds: M4_BOUNDS,
  fixtureHash: APPROVED_OPENAI_001.fixture,
  primeOutcome: 'record',
};
const sameFields = (manifest: any) =>
  Object.entries(expected).every(
    ([key, value]) => JSON.stringify(manifest[key]) === JSON.stringify(value),
  );
let rows: PairedRow[] = [];
let carry: { spentUnits: number; admittedAttempts: number } = { ...M4_R3.carry };
const stops: unknown[] = [];
for (const [i, stop] of M4_R3_STOPS.entries()) {
  if (stop.name !== m4R3Run(i + 1) || JSON.stringify(stop.carry) !== JSON.stringify(carry))
    throw new Error('Round 3 stop chain mismatch');
  const step = validatePairedStopped(
    {
      trials: await read(`${stop.name}.trials.jsonl`),
      budget: await read(`${stop.name}.budget.jsonl`),
      summary: await read(`${stop.name}.summary.json`),
    },
    stop,
    rows,
    sameFields,
  );
  rows = step.rows;
  carry = step.carry;
  stops.push({
    name: stop.name,
    trials: stop.trials,
    budget: stop.budget,
    summary: stop.summary,
    superseded: step.superseded,
    chargedUncertain: step.chargedUncertain,
  });
}
const measured = (arm: Arm, fixture: string, condition: string) =>
  rows
    .filter(
      (r) =>
        r.arm === arm &&
        r.fixture === fixture &&
        r.phase !== 'prime' &&
        r.result.condition === condition,
    )
    .map((r) => r.result);
const mean = (values: number[]) =>
  values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
const modelMs = (r: OpenAICohortResult) =>
  r.run.attempts
    .filter((a) => a.outputCap === OPENAI_PROTOCOL.maxOutputTokens)
    .reduce((s, a) => s + a.durationMs, 0);
const sumCounts = (items: Array<Record<string, number> | undefined>) => {
  const out: Record<string, number> = {};
  for (const item of items)
    for (const [key, value] of Object.entries(item ?? {}))
      if (Number.isSafeInteger(value) && value) out[key] = (out[key] ?? 0) + value;
  return out;
};
const group = (cohort: OpenAICohortResult[]) => ({
  trials: cohort.length,
  successes: cohort.filter((r) => r.run.success).length,
  enforced: cohort.filter((r) => authorizationEnforced(r.run)).length,
  meanTokens: mean(cohort.map((r) => r.run.metrics.totalTokens)),
  meanWallMs: mean(cohort.map((r) => r.run.measurement?.wallMs ?? NaN)),
  meanModelRounds: mean(cohort.map((r) => r.run.metrics.modelRounds)),
  meanMainModelMs: mean(cohort.map(modelMs)),
  meanDocsCalls: mean(cohort.map((r) => r.run.metrics.docsCalls)),
  meanPtcCalls: mean(cohort.map((r) => r.run.ptc?.ptcCalls ?? 0)),
  directCallsByCapability: sumCounts(cohort.map((r) => r.run.ptc?.directCallsByCapability)),
  operationsByCapability: sumCounts(cohort.map((r) => r.run.ptc?.operationsByCapability)),
  interactionRequests: sumCounts(cohort.map((r) => r.run.services?.requests)),
});
const fixtures = FIXTURES.map((f) => {
  const conditions = Object.fromEntries(
    ['uncached', 'warm'].map((condition) => [
      condition,
      Object.fromEntries(ARMS.map((arm) => [arm, group(measured(arm, f.id, condition))])),
    ]),
  );
  const complete = ['uncached', 'warm'].every((c) =>
    ARMS.every((arm) => conditions[c]![arm]!.trials === OPENAI_PROTOCOL.trialsPerCondition),
  );
  const m1Groups = m1.aggregates[f.kind].groups.filter((g: any) => g.fixture === f.id);
  return {
    fixture: f.id,
    kind: f.kind,
    complete,
    conditions,
    m1: Object.fromEntries(
      m1Groups.map((g: any) => [
        g.condition,
        {
          successes: g.successes,
          meanTokens: g.meanTokens,
          meanWallMs: g.meanWallMs,
          meanModelRounds: g.meanModelRounds,
        },
      ]),
    ),
  };
});
const report = {
  kind: 'ptc-m4-round3-partial',
  verdict: 'none: the matrix is incomplete (stopped runs; maintainer decision to end the round)',
  stops,
  rows: rows.length,
  measured: Object.fromEntries(
    ARMS.map((arm) => [arm, rows.filter((r) => r.arm === arm && r.phase !== 'prime').length]),
  ),
  fixtures,
  budget: {
    carry: M4_R3.carry,
    final: carry,
    roundSpentUnits: carry.spentUnits - M4_R3.carry.spentUnits,
    roundAttempts: carry.admittedAttempts - M4_R3.carry.admittedAttempts,
  },
};
const fd = createArtifact(path.join(directory, 'ptc-m4-r3-partial-report.json'));
try {
  checkpoint(fd, report);
} finally {
  closeSync(fd);
}
console.log(JSON.stringify(report));
