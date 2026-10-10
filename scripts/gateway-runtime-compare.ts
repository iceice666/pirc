/**
 * M5 comparison of the M0 baseline and the opt-in gateway runtime candidate.
 * No credentials, paid providers, private histories or deployment operations.
 * The daemon logs to stdout; redirect it (`>/dev/null`). Progress goes to stderr.
 * Gate results are decisional only with the constrained worker (`--worker`) and both
 * variants. The exit code reflects run failures only; inspect `gates` for pass/fail.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { runSample, type Sample } from '../apps/gateway/test/gateway-runtime/baseline.js';
import { candidateRunner } from '../apps/gateway/test/gateway-runtime/candidate.js';
import {
  evaluateGates,
  markdownSummary,
  matrix,
  measureInterleaved,
  parseCompareArgs,
  type CellComparison,
  type Variant,
} from '../apps/gateway/test/gateway-runtime/compare.js';

const options = parseCompareArgs(process.argv.slice(2));
const harness = [
  'apps/gateway/test/gateway-runtime/baseline.ts',
  'apps/gateway/test/gateway-runtime/candidate.ts',
  'apps/gateway/test/gateway-runtime/compare.ts',
  'scripts/gateway-runtime-compare.ts',
];
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const metadata = {
  schema: 1,
  started: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0,
  environment: {
    bun: Bun.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    loadAverageAtStart: loadavg(),
  },
  repeats: options.repeats,
  warmupsPerCellPerVariant: 1,
  variants: options.variants,
  candidate: {
    worker: options.worker ? 'constrained' : 'synthetic-in-process',
    workerSha256: options.worker ? sha256(options.worker) : null,
    srt: options.srt,
  },
  harnessSha256: Object.fromEntries(harness.map((file) => [file, sha256(file)])),
};
const runners: Partial<
  Record<Variant, (cell: Parameters<typeof runSample>[0]) => Promise<Sample>>
> = {};
if (options.variants.includes('baseline')) runners.baseline = runSample;
if (options.variants.includes('candidate'))
  runners.candidate = candidateRunner({ worker: options.worker, srt: options.srt });
const cells: CellComparison[] = [];
const samples: Array<Sample & { variant: Variant }> = [];
const failures: Awaited<ReturnType<typeof measureInterleaved>>['failures'] = [];
async function checkpoint(complete: boolean) {
  const temporary = `${options.output}.${process.pid}.tmp`;
  const both = options.variants.length === 2;
  await Bun.write(
    temporary,
    JSON.stringify(
      {
        ...metadata,
        complete,
        ...(complete
          ? {
              finished: new Date().toISOString(),
              loadAverageAtEnd: loadavg(),
              ...(both ? { gatesDecisional: !!options.worker, gates: evaluateGates(cells) } : {}),
            }
          : {}),
        cells,
        samples,
        failures,
      },
      null,
      2,
    ) + '\n',
  );
  await rename(temporary, options.output);
}
await checkpoint(false);
const all = matrix();
for (const cell of all) {
  const result = await measureInterleaved(cell, options.repeats, runners);
  for (const [variant, list] of result.samples)
    samples.push(...list.map((sample) => ({ ...sample, variant })));
  failures.push(...result.failures);
  cells.push(result.comparison);
  await checkpoint(false);
  console.error(`${cells.length}/${all.length} ${JSON.stringify(cell)}`);
}
await checkpoint(true);
console.error(markdownSummary(cells));
if (options.variants.length === 2) {
  const gates = evaluateGates(cells);
  console.error(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(gates).map(([name, value]) =>
          typeof value === 'boolean'
            ? [name, value]
            : [name, { pass: value.pass, failed: value.failed }],
        ),
      ),
    ),
  );
}
if (failures.length || samples.some((sample) => !sample.success)) process.exitCode = 1;
console.error(`Saved ${samples.length} runs and ${failures.length} failures to ${options.output}`);
process.exit();
