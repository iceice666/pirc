/** Aggregate-only final M1 OpenAI baseline report over the hash-pinned run chain; no spend. */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact, checkpoint } from '../apps/gateway/test/ptc-m1/artifacts.js';
import { OPENAI_PROTOCOL } from '../apps/gateway/test/ptc-m1/openai-contract.js';
import {
  APPROVED_CONTINUATIONS,
  APPROVED_OPENAI_001,
  APPROVED_REMEASURES,
  openAIOrder,
  validateOpenAIRemeasure,
  validateOpenAIContinuation,
  validateOpenAIResume,
  validateOpenAIResume002,
} from '../apps/gateway/test/ptc-m1/openai-resume.js';
import {
  authorizationEnforced,
  openAIReadiness,
} from '../apps/gateway/test/ptc-m1/openai-readiness.js';
import { summarizeOpenAI } from '../apps/gateway/test/ptc-m1/openai-report.js';
import { TEAM_ORACLE_REVISION } from '../apps/gateway/test/ptc-m1/team-evidence.js';

const directory = path.join(os.homedir(), 'pirc-ptc-m1-eval');
const read = (name: string) => readFile(path.join(directory, name), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
// Refuse to report while any run or re-measure exists that the pinned chain does not include.
const pinned = new Set([
  'openai-001',
  'openai-002',
  ...APPROVED_CONTINUATIONS.map((p) => p.name),
  ...APPROVED_REMEASURES.map((p) => p.name),
]);
for (const entry of await readdir(directory)) {
  const run = /^(openai-\d{3})\.(?:trials\.jsonl|budget\.jsonl|summary\.json)$/.exec(entry)?.[1];
  const marker = /^\.ptc-m1-openai-remeasure-(openai-\d{3})-attempted$/.exec(entry)?.[1];
  if ((run && !pinned.has(run)) || (marker && !pinned.has(marker)))
    throw new Error(`Unpinned run exists: ${run ?? marker}`);
}
const b1 = await read('openai-001.budget.jsonl');
const s1 = await read('openai-001.summary.json');
if (sha256(b1) !== APPROVED_OPENAI_001.budget || sha256(s1) !== APPROVED_OPENAI_001.summary)
  throw new Error('openai-001 pins');
let state: { rows: any[]; carry: { spentUnits: number; admittedAttempts: number }; next: any } =
  validateOpenAIResume002(
    validateOpenAIResume(
      await read('openai-001.trials.jsonl'),
      APPROVED_OPENAI_001.trials,
      JSON.parse(b1.trim().split('\n').at(-1)!),
    ),
    {
      trials: await read('openai-002.trials.jsonl'),
      budget: await read('openai-002.budget.jsonl'),
      summary: await read('openai-002.summary.json'),
    },
    {
      report: await read('openai-team-diagnostic-001.json'),
      budget: await read('openai-team-diagnostic-001.budget.jsonl'),
    },
  );
const superseded: unknown[] = [];
for (const pin of APPROVED_CONTINUATIONS) {
  const step = validateOpenAIContinuation(
    state,
    {
      trials: await read(`${pin.name}.trials.jsonl`),
      budget: await read(`${pin.name}.budget.jsonl`),
      summary: await read(`${pin.name}.summary.json`),
    },
    pin,
  );
  superseded.push(...step.superseded.map((s) => ({ run: pin.name, ...s })));
  state = step;
}
if (state.rows.length !== openAIOrder().length) throw new Error('Chain does not cover the matrix');
// The authorization-category re-measure was pre-declared (docs/evaluations/ptc/ptc-m1-openai.md).
if (APPROVED_REMEASURES.length !== 1) throw new Error('Pre-declared re-measure not pinned');
const remeasures: unknown[] = [];
for (const pin of APPROVED_REMEASURES) {
  const step = validateOpenAIRemeasure(
    state,
    {
      trials: await read(`${pin.name}.trials.jsonl`),
      budget: await read(`${pin.name}.budget.jsonl`),
      summary: await read(`${pin.name}.summary.json`),
    },
    pin,
  );
  const old = step.supersededRows.filter((row) => row.phase !== 'prime').map((row) => row.result);
  remeasures.push({
    ...pin,
    supersededMeasured: old.length,
    supersededAuthorization: Object.fromEntries(
      pin.fixtures.map((fixture) => {
        const rows = old.filter((r) => r.run.fixture === fixture);
        return [
          fixture,
          {
            trials: rows.length,
            taskSuccesses: rows.filter((r) => r.run.success).length,
            enforced: rows.filter((r) => authorizationEnforced(r.run)).length,
          },
        ];
      }),
    ),
    supersededAggregates: summarizeOpenAI(old),
  });
  state = { ...state, rows: step.rows, carry: step.carry };
}
const measured = state.rows.filter((row) => row.phase !== 'prime').map((row) => row.result);
const authorization: Record<string, Record<string, number>> = {};
for (const result of measured) {
  const run = result.run;
  if (
    !['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(
      run.fixture,
    )
  )
    continue;
  const group = (authorization[`${run.fixture}/${result.condition}`] ??= {
    trials: 0,
    enforced: 0,
    taskSuccesses: 0,
    explicitEvidence: 0,
  });
  group.trials!++;
  if (authorizationEnforced(run)) group.enforced!++;
  if (run.success) group.taskSuccesses!++;
  if (typeof run.outcome?.authorizationEnforced === 'boolean') group.explicitEvidence!++;
}
const missing = openAIReadiness(measured);
const report = {
  kind: 'ptc-m1-openai-baseline',
  protocol: OPENAI_PROTOCOL,
  chain: { openai001: APPROVED_OPENAI_001, continuations: APPROVED_CONTINUATIONS },
  supersededAttempts: superseded,
  remeasures,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  readiness: { missing, complete: missing.length === 0 },
  measuredTrials: measured.length,
  primes: state.rows.length - measured.length,
  authorization,
  aggregates: summarizeOpenAI(measured),
  budget: state.carry,
};
const last = [...pinned].at(-1)!;
const fd = createArtifact(path.join(directory, `openai-baseline-report-${last}.json`));
try {
  checkpoint(fd, report);
} finally {
  closeSync(fd);
}
console.log(JSON.stringify(report));
