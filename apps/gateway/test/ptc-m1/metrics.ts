/** Aggregate-only report boundary; never serialize raw requests/events/transcripts. */
export const BASELINE_COMMIT = '16c80846da64c07114d8cd43bab68748e5474127';
export const EVALUATION_PROTOCOL = {
  version: 3, // Shared image-perception fixture revision approved before live baseline.
  memoryMetric: 'linux-cgroup-v2-memory.peak',
  cpuMetric: 'linux-cgroup-v2-cpu.stat',
  baseline: BASELINE_COMMIT,
  model: 'Claude Opus 5.5',
  trialsPerCacheCondition: 10,
  cacheConditions: ['cold', 'warm'],
  singleBashWeight: 5,
  maxSingleTokenRatio: 1.15,
  maxSingleWallRatio: 1.2,
  runtimeBoundary: 'agent-and-descendants',
} as const;

export interface Metrics {
  modelRounds: number;
  transportRetries: number;
  toolErrors: number;
  docsCalls: number;
  docsBytes: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  schemaBytes: number;
  contextBytes: number;
  requestCount: number;
  missingUsage: number;
}
export function newMetrics(): Metrics {
  return {
    modelRounds: 0,
    transportRetries: 0,
    toolErrors: 0,
    docsCalls: 0,
    docsBytes: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    schemaBytes: 0,
    contextBytes: 0,
    requestCount: 0,
    missingUsage: 0,
  };
}
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Feed each raw RPC event once; callers must not persist that event into reports. */
export function collectEvent(metrics: Metrics, event: Record<string, any>): void {
  if (event.type === 'auto_retry_start') metrics.transportRetries++;
  if (event.type === 'tool_execution_end') {
    if (event.isError) metrics.toolErrors++;
    if (event.toolName === 'ptc_docs') {
      metrics.docsCalls++;
      metrics.docsBytes += Buffer.byteLength(JSON.stringify(event.result ?? null));
    }
  }
  if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
  metrics.modelRounds++;
  const usage = event.message.usage;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  if (!usage || keys.some((key) => count(usage[key]) === null)) {
    metrics.missingUsage++;
    return;
  }
  for (const key of keys) metrics[key] += usage[key];
}
/** Provider observer supplies lengths only, including failed/retried/child requests. */
export function collectRequestSizes(
  metrics: Metrics,
  schemaBytes: number,
  contextBytes: number,
): void {
  if (count(schemaBytes) === null || count(contextBytes) === null)
    throw new Error('Invalid metric');
  metrics.requestCount++;
  metrics.schemaBytes += schemaBytes;
  metrics.contextBytes += contextBytes;
}
export interface Trial {
  fixture: string;
  kind: 'coding' | 'chat';
  cache: 'cold' | 'warm';
  success: boolean;
  metrics: Metrics;
  wallMs: number;
  cpuMs: number | null;
  cgroupMemoryPeakBytes: number | null;
  provenance: 'real-opus-5.5' | 'synthetic';
  cacheVerified: boolean;
  childrenAccounted: boolean;
  allAttemptsAccounted: boolean;
  authorizationOracle: boolean | null;
  cancellationOracle: boolean | null;
}

/** Missing data is never treated as zero or as a successful baseline. */
export function baselineReadiness(
  trials: Trial[],
  fixtures: readonly { id: string; kind: string }[],
): string[] {
  const missing = new Set<string>();
  for (const fixture of fixtures)
    for (const cache of EVALUATION_PROTOCOL.cacheConditions) {
      const rows = trials.filter(
        (row) => row.fixture === fixture.id && row.kind === fixture.kind && row.cache === cache,
      );
      if (rows.length !== EVALUATION_PROTOCOL.trialsPerCacheCondition)
        missing.add('trial_matrix_incomplete');
    }
  for (const row of trials) {
    if (!fixtures.some((fixture) => fixture.id === row.fixture && fixture.kind === row.kind))
      missing.add('unknown_fixture');
    if (row.provenance !== 'real-opus-5.5') missing.add('synthetic_usage');
    if (row.cache !== 'cold' && row.cache !== 'warm') missing.add('cache_unverified');
    if (row.cacheVerified !== true) missing.add('cache_unverified');
    if (row.childrenAccounted !== true || row.allAttemptsAccounted !== true)
      missing.add('usage_scope_incomplete');
    const keys = Object.keys(newMetrics()) as Array<keyof Metrics>;
    if (
      !row.metrics ||
      keys.some((key) => !Number.isSafeInteger(row.metrics[key]) || row.metrics[key] < 0) ||
      row.metrics.missingUsage !== 0 ||
      row.metrics.modelRounds <= 0 ||
      row.metrics.requestCount <= 0
    )
      missing.add('usage_missing');
    if (
      count(row.cpuMs) === null ||
      count(row.cgroupMemoryPeakBytes) === null ||
      row.cgroupMemoryPeakBytes! <= 0
    )
      missing.add('resources_missing');
    if (!Number.isFinite(row.wallMs) || row.wallMs <= 0) missing.add('wall_missing');
    if (
      ['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(
        row.fixture,
      ) &&
      row.authorizationOracle !== true
    )
      missing.add('authorization_unverified');
    if (row.fixture === 'cancel-wait' && row.cancellationOracle !== true)
      missing.add('cancellation_unverified');
  }
  return [...missing].sort();
}
