/** No credentials, paid providers, private histories or deployment operations. */
import { execFileSync } from 'node:child_process';
import { rename } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { FIXTURES, runSample, type Sample } from '../apps/gateway/test/gateway-runtime/baseline.js';
import {
  measureCell,
  parseArgs,
  type Failure,
} from '../apps/gateway/test/gateway-runtime/report.js';

const { repeats, output } = parseArgs(process.argv.slice(2));
const samples: Sample[] = [];
const failures: Failure[] = [];
const cells: Awaited<ReturnType<typeof measureCell>>['summary'][] = [];
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
  },
  repeats,
  warmupsPerCell: 1,
};
async function checkpoint(complete: boolean) {
  const temporary = `${output}.${process.pid}.tmp`;
  await Bun.write(
    temporary,
    JSON.stringify(
      {
        ...metadata,
        complete,
        ...(complete ? { finished: new Date().toISOString() } : {}),
        cells,
        samples,
        failures,
      },
      null,
      2,
    ) + '\n',
  );
  await rename(temporary, output);
}
await checkpoint(false);
for (const rttMs of [0, 30, 100, 200]) {
  for (const contextBytes of [1024, 262144]) {
    for (const sessions of [1, 4]) {
      for (const fixture of FIXTURES) {
        const cell = { rttMs, contextBytes, sessions, fixture };
        const result = await measureCell(cell, repeats, runSample);
        samples.push(...result.samples);
        failures.push(...result.failures);
        cells.push(result.summary);
        await checkpoint(false);
        console.error(`${cells.length}/64 ${JSON.stringify(cell)}`);
      }
    }
  }
}
await checkpoint(true);
if (failures.length || samples.some((sample) => !sample.success)) process.exitCode = 1;
console.error(`Saved ${samples.length} runs and ${failures.length} failures to ${output}`);
