/** Numeric baseline summaries; primes excluded from measured means, budget remains separate. */
import type { OpenAICohortResult } from './openai-cohort.js';
import { FIXTURES } from './fixtures.js';
export function summarizeOpenAI(rows: readonly OpenAICohortResult[]) {
  const kinds = ['coding', 'chat'] as const;
  return Object.fromEntries(
    kinds.map((kind) => {
      const groups = FIXTURES.filter((f) => f.kind === kind).flatMap((f) =>
        ['uncached', 'warm'].map((condition) => {
          const cohort = rows.filter(
            (row) =>
              row.run.fixture === f.id && row.run.kind === kind && row.condition === condition,
          );
          const mean = (fn: (r: OpenAICohortResult) => number) =>
            cohort.length ? cohort.reduce((s, r) => s + fn(r), 0) / cohort.length : null;
          return {
            fixture: f.id,
            condition,
            weight: f.weight,
            trials: cohort.length,
            successes: cohort.filter((r) => r.run.success).length,
            meanTokens: mean((r) => r.run.metrics.totalTokens),
            meanWallMs: mean((r) => r.run.measurement?.wallMs ?? NaN),
            meanModelRounds: mean((r) => r.run.metrics.modelRounds),
            meanRequests: mean((r) => r.run.metrics.requestCount),
          };
        }),
      );
      const aggregates = ['uncached', 'warm'].map((condition) => {
        const selected = groups.filter((g) => g.condition === condition);
        const ready = selected.every(
          (g) => g.trials > 0 && g.meanTokens !== null && g.meanWallMs !== null,
        );
        const totalWeight = selected.reduce((s, g) => s + g.weight, 0);
        return {
          condition,
          weightedMeanTokens: ready
            ? selected.reduce((s, g) => s + g.meanTokens! * g.weight, 0) / totalWeight
            : null,
          unweightedMeanTokens: ready
            ? selected.reduce((s, g) => s + g.meanTokens!, 0) / selected.length
            : null,
          weightedMeanWallMs: ready
            ? selected.reduce((s, g) => s + g.meanWallMs! * g.weight, 0) / totalWeight
            : null,
        };
      });
      return [kind, { groups, aggregates }];
    }),
  );
}
