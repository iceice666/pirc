/**
 * M5 comparison: interleaved baseline/candidate runs and the gates accepted at M1.
 * Every cohort is evaluated separately; RTT/context/session cohorts are never pooled.
 */
import { distribution, FIXTURES, type Cell, type Fixture, type Sample } from './baseline.js';
import type { Failure } from './report.js';

export const VARIANTS = ['baseline', 'candidate'] as const;
export type Variant = (typeof VARIANTS)[number];
type Runner = (cell: Cell) => Promise<Sample>;
type Distribution = ReturnType<typeof distribution>;

export function matrix(): Cell[] {
  const cells: Cell[] = [];
  for (const rttMs of [0, 30, 100, 200])
    for (const contextBytes of [1024, 262144])
      for (const sessions of [1, 4])
        for (const fixture of FIXTURES) cells.push({ rttMs, contextBytes, sessions, fixture });
  return cells;
}

export function parseCompareArgs(args: string[]) {
  const usage =
    'Usage: --repeats 2..100 --output PATH [--variants baseline,candidate] [--worker PATH] [--srt fake|embedded]';
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (
      !['--repeats', '--output', '--variants', '--worker', '--srt'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      values.has(key)
    )
      throw new Error(usage);
    values.set(key, value);
  }
  const repeats = Number(values.get('--repeats') ?? 10);
  const variants = (values.get('--variants') ?? 'baseline,candidate').split(',');
  const srt = values.get('--srt') ?? 'fake';
  if (
    !Number.isInteger(repeats) ||
    repeats < 2 ||
    repeats > 100 ||
    !variants.length ||
    new Set(variants).size !== variants.length ||
    variants.some((variant) => !VARIANTS.includes(variant as Variant)) ||
    (srt !== 'fake' && srt !== 'embedded')
  )
    throw new Error(usage);
  return {
    repeats,
    output: values.get('--output') ?? '/tmp/gateway-runtime-compare.json',
    variants: variants as Variant[],
    worker: values.get('--worker'),
    srt: srt as 'fake' | 'embedded',
  };
}

export function summarize(cell: Cell, samples: Sample[], repeats: number, warmupSuccess: boolean) {
  const frames = samples.flatMap((sample) => {
    const value = sample as Sample & { nodeToGatewayFrames?: number; gatewayToNodeFrames?: number };
    return value.nodeToGatewayFrames === undefined
      ? []
      : [value.nodeToGatewayFrames + (value.gatewayToNodeFrames ?? 0)];
  });
  const spans: Record<string, Distribution> = {};
  for (const sample of samples) {
    for (const name of Object.keys((sample as { spans?: object }).spans ?? {}))
      spans[name] ??= distribution([]);
  }
  for (const name of Object.keys(spans))
    spans[name] = distribution(
      samples.flatMap(
        (sample) => (sample as { spans?: Record<string, number[]> }).spans?.[name] ?? [],
      ),
    );
  return {
    cell,
    runs: repeats,
    warmupSuccess,
    successRate: samples.filter((sample) => sample.success).length / repeats,
    measuredRttMs: distribution(samples.map((s) => s.measuredRttMs)),
    taskMs: distribution(samples.flatMap((s) => s.taskMs)),
    deltaToUiMs: distribution(samples.flatMap((s) => s.deltaToUiMs)),
    toolQueueMs: distribution(samples.flatMap((s) => s.toolQueueMs)),
    toolExecutionMs: distribution(samples.flatMap((s) => s.toolExecutionMs)),
    contextBytes: distribution(samples.flatMap((s) => s.contextBytes)),
    nodeLinkBytes: distribution(samples.map((s) => s.nodeToGatewayBytes + s.gatewayToNodeBytes)),
    nodeLinkFrames: distribution(frames),
    uiBytes: distribution(samples.map((s) => s.uiBytes)),
    peakDelayQueueBytes: distribution(samples.map((s) => s.peakDelayQueueBytes)),
    peakSocketBufferedBytes: distribution(samples.map((s) => s.peakSocketBufferedBytes)),
    cpuUserMs: distribution(samples.map((s) => s.cpuUserMs)),
    cpuSystemMs: distribution(samples.map((s) => s.cpuSystemMs)),
    rssPeakBytes: distribution(samples.map((s) => s.rssPeakBytes)),
    /** Candidate-only attribution spans; absent for the M0 baseline. */
    spans,
  };
}
export type Summary = ReturnType<typeof summarize>;
export interface CellComparison {
  cell: Cell;
  variants: Partial<Record<Variant, Summary>>;
}

/**
 * One warmup per variant, then alternate variant order on each repeat so slow host
 * drift does not systematically favour either side. Thrown runs remain failures.
 */
export async function measureInterleaved(
  cell: Cell,
  repeats: number,
  runners: Partial<Record<Variant, Runner>>,
) {
  const names = VARIANTS.filter((name) => runners[name]);
  const samples = new Map<Variant, Sample[]>(names.map((name) => [name, []]));
  const warmups = new Map<Variant, boolean>();
  const failures: Array<Failure & { variant: Variant }> = [];
  for (let repeat = -1; repeat < repeats; repeat++) {
    const order = repeat % 2 === 0 ? names : [...names].reverse();
    for (const variant of order) {
      const phase = repeat < 0 ? 'warmup' : 'measurement';
      try {
        const sample = await runners[variant]!(cell);
        if (phase === 'warmup') {
          warmups.set(variant, sample.success);
          if (!sample.success)
            failures.push({ variant, cell, phase, repeat, error: sample.errors.join('; ') });
        } else samples.get(variant)!.push(sample);
      } catch (error) {
        if (phase === 'warmup') warmups.set(variant, false);
        failures.push({
          variant,
          cell,
          phase,
          repeat,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const variants: CellComparison['variants'] = {};
  for (const name of names)
    variants[name] = summarize(cell, samples.get(name)!, repeats, warmups.get(name) ?? false);
  return { comparison: { cell, variants } as CellComparison, samples, failures };
}

const key = (cell: Omit<Cell, 'fixture'> & { fixture: Fixture }) =>
  `${cell.rttMs}/${cell.contextBytes}/${cell.sessions}/${cell.fixture}`;
const allowance = (baseline: number) => Math.max(baseline * 0.1, 50);
const lessOrEqual = (value: number | null, limit: number | null) =>
  value !== null && limit !== null && value <= limit;

/** Gates accepted at M1 review; never relaxed after seeing results. */
export function evaluateGates(cells: CellComparison[]) {
  const find = new Map(cells.map((entry) => [key(entry.cell), entry]));
  const pair = (cell: Cell) => {
    const entry = find.get(key(cell));
    return { baseline: entry?.variants.baseline, candidate: entry?.variants.candidate };
  };
  const p50 = (value: Distribution | undefined) => value?.p50 ?? null;
  const p95 = (value: Distribution | undefined) => value?.p95 ?? null;

  // 1. 100 ms RTT, low load (one session, 1 KiB history): ≥70 ms p50 delta→UI reduction, no p95 regression.
  const delta = FIXTURES.map((fixture) => {
    const { baseline, candidate } = pair({ rttMs: 100, contextBytes: 1024, sessions: 1, fixture });
    const baseP50 = p50(baseline?.deltaToUiMs);
    const candP50 = p50(candidate?.deltaToUiMs);
    return {
      fixture,
      baselineP50: baseP50,
      candidateP50: candP50,
      baselineP95: p95(baseline?.deltaToUiMs),
      candidateP95: p95(candidate?.deltaToUiMs),
      pass:
        baseP50 !== null &&
        lessOrEqual(candP50, baseP50 - 70) &&
        lessOrEqual(p95(candidate?.deltaToUiMs), p95(baseline?.deltaToUiMs)),
    };
  });

  // 2. Environment-only PTC: ten dependent reads must not add WAN round trips over one read.
  const ptc = [] as Array<{
    contextBytes: number;
    sessions: number;
    rttMs: number;
    extraRoundTrips: number | null;
    /** Informational cross-check: node-link frames per run, ptc-10 versus single-tool. */
    ptcFramesP50: number | null;
    singleFramesP50: number | null;
    pass: boolean;
  }>;
  for (const contextBytes of [1024, 262144])
    for (const sessions of [1, 4]) {
      const at = (rttMs: number, fixture: Fixture) =>
        p50(pair({ rttMs, contextBytes, sessions, fixture }).candidate?.taskMs);
      const zero = [at(0, 'ptc-10'), at(0, 'single-tool')];
      for (const rttMs of [100, 200]) {
        const values = [at(rttMs, 'ptc-10'), at(rttMs, 'single-tool'), ...zero];
        const extra = values.every((value) => value !== null)
          ? (values[0]! - values[1]! - (values[2]! - values[3]!)) / rttMs
          : null;
        // Linear growth would be ≈9 extra round trips; allow less than one for noise.
        const frames = (fixture: Fixture) =>
          p50(pair({ rttMs, contextBytes, sessions, fixture }).candidate?.nodeLinkFrames);
        ptc.push({
          contextBytes,
          sessions,
          rttMs,
          extraRoundTrips: extra,
          ptcFramesP50: frames('ptc-10'),
          singleFramesP50: frames('single-tool'),
          pass: extra !== null && extra < 1,
        });
      }
    }

  // 3. Task time: chat/single-tool/mixed fixtures and every loopback cohort.
  const task = cells
    .filter((entry) => entry.cell.fixture !== 'ptc-10' || entry.cell.rttMs === 0)
    .map((entry) => {
      const { baseline, candidate } = pair(entry.cell);
      const base50 = p50(baseline?.taskMs);
      const base95 = p95(baseline?.taskMs);
      return {
        cell: entry.cell,
        baselineP50: base50,
        candidateP50: p50(candidate?.taskMs),
        limitP50: base50 === null ? null : base50 + allowance(base50),
        baselineP95: base95,
        candidateP95: p95(candidate?.taskMs),
        limitP95: base95 === null ? null : base95 + allowance(base95),
        pass:
          base50 !== null &&
          base95 !== null &&
          lessOrEqual(p50(candidate?.taskMs), base50 + allowance(base50)) &&
          lessOrEqual(p95(candidate?.taskMs), base95 + allowance(base95)),
      };
    });

  // 4. Long context never crosses the node link in full; provider traffic is not counted.
  // Per session: below one 256 KiB history, and independent of history size (versus the
  // matching 1 KiB cohort). An aggregate threshold would count four sessions' control
  // traffic against a single history.
  const longContext = cells
    .filter((entry) => entry.cell.contextBytes === 262144)
    .map((entry) => {
      const { baseline, candidate } = pair(entry.cell);
      const small = pair({ ...entry.cell, contextBytes: 1024 }).candidate;
      const candidateP95 = p95(candidate?.nodeLinkBytes);
      const baselineP50 = p50(baseline?.nodeLinkBytes);
      const candidateP50 = p50(candidate?.nodeLinkBytes);
      const smallP50 = p50(small?.nodeLinkBytes);
      const smallP95 = p95(small?.nodeLinkBytes);
      const perSessionP95 = candidateP95 === null ? null : candidateP95 / entry.cell.sessions;
      const growthPerSession =
        candidateP50 === null || smallP50 === null
          ? null
          : (candidateP50 - smallP50) / entry.cell.sessions;
      // p95 too, so retransmission in a minority of runs cannot hide behind the median.
      const growthP95PerSession =
        candidateP95 === null || smallP95 === null
          ? null
          : (candidateP95 - smallP95) / entry.cell.sessions;
      return {
        cell: entry.cell,
        baselineP50,
        candidateP50,
        candidateP95,
        perSessionP95,
        growthPerSession,
        growthP95PerSession,
        savedP50: baselineP50 === null || candidateP50 === null ? null : baselineP50 - candidateP50,
        pass:
          perSessionP95 !== null &&
          perSessionP95 < 262144 &&
          growthPerSession !== null &&
          Math.abs(growthPerSession) < 262144 / 100 &&
          growthP95PerSession !== null &&
          Math.abs(growthP95PerSession) < 262144 / 100,
      };
    });

  // 5. Correctness: every measured run and warmup succeeded for both sides.
  const correctness = cells.map((entry) => ({
    cell: entry.cell,
    baselineSuccess: entry.variants.baseline?.successRate ?? null,
    candidateSuccess: entry.variants.candidate?.successRate ?? null,
    pass: VARIANTS.every(
      (variant) =>
        entry.variants[variant]?.successRate === 1 && entry.variants[variant]?.warmupSuccess,
    ),
  }));
  const gate = <T extends { pass: boolean }>(rows: T[]) => ({
    pass: rows.length > 0 && rows.every((row) => row.pass),
    failed: rows.filter((row) => !row.pass).length,
    rows,
  });
  const gates = {
    deltaToUi: gate(delta),
    environmentPtc: gate(ptc),
    taskTime: gate(task),
    longContext: gate(longContext),
    correctness: gate(correctness),
  };
  return { pass: Object.values(gates).every((value) => value.pass), ...gates };
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toFixed(1);

/** Compact Markdown for review; the JSON remains the authoritative record. */
export function markdownSummary(cells: CellComparison[]) {
  const lines = [
    '| RTT | History | Sessions | Fixture | Base delta p50/p95 | Cand delta p50/p95 | Base task p50/p95 | Cand task p50/p95 | Base / cand node bytes p50 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { cell, variants } of cells) {
    const b = variants.baseline;
    const c = variants.candidate;
    lines.push(
      `| ${cell.rttMs} | ${cell.contextBytes === 1024 ? '1 KiB' : '256 KiB'} | ${cell.sessions} | ${cell.fixture} | ${ms(b?.deltaToUiMs.p50)} / ${ms(b?.deltaToUiMs.p95)} | ${ms(c?.deltaToUiMs.p50)} / ${ms(c?.deltaToUiMs.p95)} | ${ms(b?.taskMs.p50)} / ${ms(b?.taskMs.p95)} | ${ms(c?.taskMs.p50)} / ${ms(c?.taskMs.p95)} | ${b?.nodeLinkBytes.p50 ?? '—'} / ${c?.nodeLinkBytes.p50 ?? '—'} |`,
    );
  }
  return lines.join('\n') + '\n';
}
