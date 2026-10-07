/**
 * M4 acceptance bounds (plans/ptc-only.md Milestone 4, plans/ptc-m4-evaluation.md), declared
 * before any PTC data: the PTC rows against the aggregate M1 OpenAI baseline report. Coding and
 * chat are judged separately. Aggregates only; no row content leaves this module.
 */
import { FIXTURES } from './fixtures.js';
import type { OpenAICohortResult } from './openai-cohort.js';
import { authorizationEnforced, openAIReadiness } from './openai-readiness.js';
import { summarizeOpenAI } from './openai-report.js';

export const M4_BOUNDS = {
  revision: 1,
  authorizationFixtures: ['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'],
  cancellationFixtures: ['cancel-wait'],
  /** Success: per fixture, uncached and warm pooled (maintainer decision 2026-10-06). */
  successGranularity: 'fixture-pooled-conditions',
  singleCall: ['single-bash', 'single-read', 'chat-web-search'],
  maxSingleTokenRatio: 1.15,
  maxSingleWallRatio: 1.2,
  /** Batch: strictly fewer mean rounds and tokens per condition (decision 2026-10-06). */
  batch: ['multi-edit', 'dependent-edit'],
  /** Total: weighted mean tokens per kind and condition, single-bash weight 5. */
  total: 'weighted-mean-tokens-per-condition',
} as const;

type Kind = 'coding' | 'chat';
type Condition = 'uncached' | 'warm';
interface Group {
  fixture: string;
  condition: string;
  weight: number;
  trials: number;
  successes: number;
  meanTokens: number | null;
  meanWallMs: number | null;
  meanModelRounds: number | null;
  meanRequests: number | null;
}
export interface BaselineReport {
  readiness: { complete: boolean; missing: string[] };
  measuredTrials: number;
  authorization: Record<string, { trials: number; enforced: number; taskSuccesses: number }>;
  aggregates: Record<
    Kind,
    {
      groups: Group[];
      aggregates: Array<{ condition: string; weightedMeanTokens: number | null }>;
    }
  >;
}
export interface Check {
  bound: 'readiness' | 'authorization' | 'cancellation' | 'success' | 'single' | 'batch' | 'total';
  fixture?: string;
  condition?: Condition;
  metric: string;
  baseline: number | null;
  ptc: number | null;
  limit: string;
  pass: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function evaluateM4(baseline: BaselineReport, rows: readonly OpenAICohortResult[]) {
  if (!baseline.readiness.complete || baseline.measuredTrials !== 300)
    throw new Error('Baseline report is not the accepted M1 baseline');
  const ptc = summarizeOpenAI(rows) as unknown as BaselineReport['aggregates'];
  const missing = openAIReadiness(rows);
  const group = (source: BaselineReport['aggregates'], kind: Kind, fixture: string, c: string) =>
    source[kind].groups.find((g) => g.fixture === fixture && g.condition === c);
  const kinds: Kind[] = ['coding', 'chat'];
  const conditions: Condition[] = ['uncached', 'warm'];
  const verdicts = Object.fromEntries(
    kinds.map((kind) => {
      const checks: Check[] = [
        {
          bound: 'readiness',
          metric: 'missing',
          baseline: 0,
          ptc: missing.length,
          limit: 'complete PTC matrix under the M1 readiness function',
          pass: missing.length === 0,
        },
      ];
      const fixtures = FIXTURES.filter((f) => f.kind === kind);
      for (const fixture of fixtures) {
        for (const condition of conditions) {
          const cohort = rows.filter(
            (r) => r.run.fixture === fixture.id && r.condition === condition,
          );
          if ((M4_BOUNDS.authorizationFixtures as readonly string[]).includes(fixture.id)) {
            const base = baseline.authorization[`${fixture.id}/${condition}`];
            const enforced = cohort.filter((r) => authorizationEnforced(r.run)).length;
            checks.push({
              bound: 'authorization',
              fixture: fixture.id,
              condition,
              metric: 'enforced trials',
              baseline: base?.enforced ?? null,
              ptc: enforced,
              limit: 'every trial enforced, as in every baseline trial',
              pass:
                !!base &&
                base.enforced === base.trials &&
                cohort.length === base.trials &&
                enforced === cohort.length,
            });
          }
          if ((M4_BOUNDS.cancellationFixtures as readonly string[]).includes(fixture.id)) {
            const base = group(baseline.aggregates, kind, fixture.id, condition);
            const ok = cohort.filter(
              (r) => r.run.success && r.run.outcome?.cancellationObserved === true,
            ).length;
            checks.push({
              bound: 'cancellation',
              fixture: fixture.id,
              condition,
              metric: 'cancelled trials',
              baseline: base?.successes ?? null,
              ptc: ok,
              limit: 'every trial cancelled, as in every baseline trial',
              pass:
                !!base &&
                base.successes === base.trials &&
                cohort.length === base.trials &&
                ok === cohort.length,
            });
          }
          const base = group(baseline.aggregates, kind, fixture.id, condition);
          const mine = group(ptc, kind, fixture.id, condition);
          if ((M4_BOUNDS.singleCall as readonly string[]).includes(fixture.id)) {
            for (const [metric, key, ratio] of [
              ['mean tokens', 'meanTokens', M4_BOUNDS.maxSingleTokenRatio],
              ['mean wall ms', 'meanWallMs', M4_BOUNDS.maxSingleWallRatio],
            ] as const) {
              const b = base?.[key] ?? null,
                p = mine?.[key] ?? null;
              checks.push({
                bound: 'single',
                fixture: fixture.id,
                condition,
                metric,
                baseline: b,
                ptc: p,
                limit: `<= ${ratio} x baseline`,
                pass: finite(b) && finite(p) && p <= b * ratio,
              });
            }
          }
          if ((M4_BOUNDS.batch as readonly string[]).includes(fixture.id))
            for (const [metric, key] of [
              ['mean model rounds', 'meanModelRounds'],
              ['mean tokens', 'meanTokens'],
            ] as const) {
              const b = base?.[key] ?? null,
                p = mine?.[key] ?? null;
              checks.push({
                bound: 'batch',
                fixture: fixture.id,
                condition,
                metric,
                baseline: b,
                ptc: p,
                limit: '< baseline',
                pass: finite(b) && finite(p) && p < b,
              });
            }
        }
        const pooled = (source: BaselineReport['aggregates']) => {
          const groups = conditions.map((c) => group(source, kind, fixture.id, c));
          return groups.every(Boolean)
            ? {
                trials: groups.reduce((s, g) => s + g!.trials, 0),
                successes: groups.reduce((s, g) => s + g!.successes, 0),
              }
            : null;
        };
        const b = pooled(baseline.aggregates),
          p = pooled(ptc);
        checks.push({
          bound: 'success',
          fixture: fixture.id,
          metric: 'successes (uncached + warm)',
          baseline: b?.successes ?? null,
          ptc: p?.successes ?? null,
          limit: '>= baseline, same trial count',
          pass: !!b && !!p && b.trials === p.trials && p.successes >= b.successes,
        });
      }
      for (const condition of conditions) {
        const b = baseline.aggregates[kind].aggregates.find(
          (a) => a.condition === condition,
        )?.weightedMeanTokens;
        const p = ptc[kind].aggregates.find((a) => a.condition === condition)?.weightedMeanTokens;
        checks.push({
          bound: 'total',
          condition,
          metric: 'weighted mean tokens',
          baseline: b ?? null,
          ptc: p ?? null,
          limit: '<= baseline',
          pass: finite(b) && finite(p) && p <= b,
        });
      }
      return [kind, { pass: checks.every((c) => c.pass), checks }];
    }),
  ) as Record<Kind, { pass: boolean; checks: Check[] }>;
  return {
    bounds: M4_BOUNDS,
    readiness: { missing, complete: missing.length === 0 },
    verdicts,
    pass: kinds.every((kind) => verdicts[kind].pass),
    aggregates: ptc,
  };
}
