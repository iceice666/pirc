import { expect, test } from 'bun:test';
import { distribution, FIXTURES, type Cell, type Sample } from './gateway-runtime/baseline.js';
import { runCandidateSample } from './gateway-runtime/candidate.js';
import {
  evaluateGates,
  matrix,
  measureInterleaved,
  parseCompareArgs,
  summarize,
  type CellComparison,
} from './gateway-runtime/compare.js';

const worker = process.env.PIRC_TEST_GATEWAY_WORKER;

test('comparison CLI rejects unknown, duplicate, invalid and missing arguments', () => {
  for (const args of [
    ['--typo', 'x'],
    ['--output'],
    ['--repeats', '1'],
    ['--variants', 'baseline,baseline'],
    ['--variants', 'legacy'],
    ['--srt', 'none'],
    ['--output', 'x', '--output', 'y'],
    ['--worker', '--srt'],
  ])
    expect(() => parseCompareArgs(args)).toThrow();
  expect(parseCompareArgs([])).toEqual({
    repeats: 10,
    output: '/tmp/gateway-runtime-compare.json',
    variants: ['baseline', 'candidate'],
    worker: undefined,
    srt: 'fake',
  });
  expect(matrix()).toHaveLength(64);
});

test('interleaving alternates variant order and keeps thrown runs in the denominator', async () => {
  const cell: Cell = { fixture: 'chat', rttMs: 0, contextBytes: 1024, sessions: 1 };
  const order: string[] = [];
  const ok = (name: string) => async (value: Cell) => {
    order.push(name);
    return { cell: value, success: true, errors: [], taskMs: [1], deltaToUiMs: [1] } as never;
  };
  const result = await measureInterleaved(cell, 2, {
    baseline: ok('b'),
    candidate: async () => {
      order.push('c');
      throw new Error('candidate transport failed');
    },
  });
  expect(order).toEqual(['c', 'b', 'b', 'c', 'c', 'b']);
  expect(result.failures).toHaveLength(3);
  expect(result.comparison.variants.candidate!.successRate).toBe(0);
  expect(result.comparison.variants.candidate!.warmupSuccess).toBe(false);
  expect(result.comparison.variants.candidate!.taskMs.p50).toBeNull();
  expect(result.comparison.variants.baseline!.successRate).toBe(1);
});

function sampleOf(
  cell: Cell,
  variant: 'baseline' | 'candidate',
  task: number,
  delta: number,
  historyMessages = 0,
  nodeBytes = variant === 'baseline' ? cell.contextBytes + 1000 : 1000,
) {
  return {
    cell,
    success: true,
    errors: [],
    measuredRttMs: cell.rttMs,
    taskMs: [task],
    deltaToUiMs: [delta],
    toolQueueMs: [],
    toolExecutionMs: [],
    contextBytes: [],
    nodeToGatewayBytes: nodeBytes,
    gatewayToNodeBytes: 0,
    uiBytes: 0,
    modelCalls: 0,
    environmentCalls: 0,
    centralCalls: 0,
    peakDelayQueueBytes: 0,
    peakSocketBufferedBytes: 0,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    rssStartBytes: 0,
    rssPeakBytes: 0,
    ...(variant === 'candidate' ? { historyMessages } : {}),
  } satisfies Sample;
}
function synthetic(
  cell: Cell,
  variant: 'baseline' | 'candidate',
  task: number,
  delta: number,
  historyMessages = 0,
  nodeBytes?: number,
) {
  const sample = sampleOf(cell, variant, task, delta, historyMessages, nodeBytes);
  return summarize(cell, [sample, sample], 2, true);
}

test('gates use per-cohort percentiles and report regressions instead of hiding them', () => {
  const build = (candidateTask: (cell: Cell) => number) =>
    matrix().map(
      (cell): CellComparison => ({
        cell,
        variants: {
          baseline: synthetic(cell, 'baseline', 100 + cell.rttMs * 2, cell.rttMs + 1),
          candidate: synthetic(cell, 'candidate', candidateTask(cell), 1),
        },
      }),
    );
  const passing = evaluateGates(build((cell) => 100 + cell.rttMs * 2 + 40));
  // 100 ms delta: 101 → 1 is the required ≥70 ms reduction.
  expect(passing.deltaToUi.pass).toBe(true);
  expect(passing.taskTime.pass).toBe(true);
  expect(passing.longContext.pass).toBe(true);
  expect(passing.environmentPtc.pass).toBe(true);
  expect(passing.correctness.pass).toBe(true);
  expect(passing.pass).toBe(true);

  // A 60 ms regression on a 100 ms loopback task exceeds max(10%, 50 ms).
  const slow = evaluateGates(build((cell) => 100 + cell.rttMs * 2 + (cell.rttMs ? 0 : 60)));
  expect(slow.taskTime.pass).toBe(false);
  expect(slow.taskTime.failed).toBe(16);
  expect(slow.pass).toBe(false);

  // Ten dependent environment operations adding one RTT each is linear growth.
  const linear = evaluateGates(
    build((cell) => 100 + cell.rttMs * (cell.fixture === 'ptc-10' ? 11 : 2)),
  );
  expect(linear.environmentPtc.pass).toBe(false);
  expect(linear.environmentPtc.rows[0]!.extraRoundTrips).toBeCloseTo(9);

  // Any node-link message carrying the long history fails, even if bytes stay small.
  const retransmit = evaluateGates(
    build((cell) => 100 + cell.rttMs * 2 + 40).map((entry) => ({
      ...entry,
      variants: {
        ...entry.variants,
        candidate: synthetic(entry.cell, 'candidate', 100 + entry.cell.rttMs * 2 + 40, 1, 1),
      },
    })),
  );
  expect(retransmit.longContext.pass).toBe(false);
  expect(retransmit.longContext.failed).toBe(32);
  // Baseline-sized node-link bytes (a whole history per run) fail as well.
  const oversize = evaluateGates(
    build((cell) => 100 + cell.rttMs * 2 + 40).map((entry) => ({
      ...entry,
      variants: {
        ...entry.variants,
        candidate: synthetic(
          entry.cell,
          'candidate',
          1,
          1,
          0,
          entry.cell.contextBytes * entry.cell.sessions + 1000,
        ),
      },
    })),
  );
  expect(oversize.longContext.rows.filter((row) => row.cell.sessions === 1)[0]!.pass).toBe(false);

  const missing = evaluateGates([]);
  expect(missing.pass).toBe(false);
});

for (const fixture of FIXTURES) {
  test(`candidate exercises gateway runtime, node WebSocket and node executor: ${fixture}`, async () => {
    const sample = await runCandidateSample(
      { fixture, rttMs: 0, contextBytes: 1024, sessions: 1 },
      { srt: 'fake', worker },
    );
    expect(sample.errors).toEqual([]);
    expect(sample.success).toBe(true);
    expect(sample.taskMs).toHaveLength(1);
    expect(sample.deltaToUiMs).toHaveLength(sample.modelCalls * 4);
    expect(sample.contextBytes.every((bytes) => bytes > 1024)).toBe(true);
    expect(sample.nodeToGatewayFrames).toBeGreaterThan(0);
    expect(sample.environmentCalls).toBe(fixture === 'chat' ? 0 : 1);
    expect(sample.centralCalls).toBe(fixture === 'mixed-ptc' ? 1 : 0);
  }, 30000);
}

test('candidate deltas skip the delayed node link and long histories stay on the gateway', async () => {
  const sample = await runCandidateSample(
    { fixture: 'chat', rttMs: 100, contextBytes: 262144, sessions: 4 },
    { srt: 'fake', worker },
  );
  expect(sample.errors).toEqual([]);
  expect(sample.taskMs).toHaveLength(4);
  expect(sample.measuredRttMs).toBeGreaterThanOrEqual(90);
  expect(distribution(sample.deltaToUiMs).p50!).toBeLessThan(50);
  expect(sample.contextBytes.every((bytes) => bytes > 262144)).toBe(true);
  // Four 256 KiB histories never cross; only descriptors/control frames do.
  expect(sample.nodeToGatewayBytes + sample.gatewayToNodeBytes).toBeLessThan(262144);
  expect(sample.historyMessages).toBe(0);
}, 30000);
