import { distribution, type Cell, type Sample } from './baseline.js';

export function parseArgs(args: string[]) {
  let repeats = 10;
  let output = '/tmp/gateway-runtime-baseline.json';
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!['--repeats', '--output'].includes(key) || !value || seen.has(key))
      throw new Error('Usage: --repeats 2..100 --output PATH');
    seen.add(key);
    if (key === '--repeats') repeats = Number(value);
    else output = value;
  }
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 100 || output.startsWith('--'))
    throw new Error('Usage: --repeats 2..100 --output PATH');
  return { repeats, output };
}

export interface Failure {
  cell: Cell;
  phase: 'warmup' | 'measurement';
  repeat: number;
  error: string;
}

/** Thrown transport/setup failures remain in the denominator, never become absent runs. */
export async function measureCell(
  cell: Cell,
  repeats: number,
  run: (cell: Cell) => Promise<Sample>,
) {
  const samples: Sample[] = [];
  const failures: Failure[] = [];
  let warmupSuccess = false;
  for (let repeat = -1; repeat < repeats; repeat++) {
    const phase = repeat < 0 ? 'warmup' : 'measurement';
    try {
      const sample = await run(cell);
      if (phase === 'warmup') {
        warmupSuccess = sample.success;
        if (!sample.success)
          failures.push({ cell, phase, repeat, error: sample.errors.join('; ') });
      } else samples.push(sample);
    } catch (error) {
      failures.push({
        cell,
        phase,
        repeat,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    samples,
    failures,
    summary: {
      cell,
      runs: repeats,
      warmupSuccess,
      successRate: samples.filter((s) => s.success).length / repeats,
      // Missing spans from failed runs stay missing, not zero latency. Failures are reported separately.
      measuredRttMs: distribution(samples.map((s) => s.measuredRttMs)),
      taskMs: distribution(samples.flatMap((s) => s.taskMs)),
      deltaToUiMs: distribution(samples.flatMap((s) => s.deltaToUiMs)),
      toolQueueMs: distribution(samples.flatMap((s) => s.toolQueueMs)),
      toolExecutionMs: distribution(samples.flatMap((s) => s.toolExecutionMs)),
      contextBytes: distribution(samples.flatMap((s) => s.contextBytes)),
      nodeLinkBytes: distribution(samples.map((s) => s.nodeToGatewayBytes + s.gatewayToNodeBytes)),
      uiBytes: distribution(samples.map((s) => s.uiBytes)),
      peakDelayQueueBytes: distribution(samples.map((s) => s.peakDelayQueueBytes)),
      peakSocketBufferedBytes: distribution(samples.map((s) => s.peakSocketBufferedBytes)),
      cpuUserMs: distribution(samples.map((s) => s.cpuUserMs)),
      cpuSystemMs: distribution(samples.map((s) => s.cpuSystemMs)),
      rssPeakBytes: distribution(samples.map((s) => s.rssPeakBytes)),
    },
  };
}
