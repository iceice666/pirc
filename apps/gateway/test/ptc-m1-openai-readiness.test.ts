import { expect, test } from 'bun:test';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { newMetrics } from './ptc-m1/metrics.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { authorizationEnforced, openAIReadiness } from './ptc-m1/openai-readiness.js';
import { summarizeOpenAI } from './ptc-m1/openai-report.js';
import type { OpenAICohortResult } from './ptc-m1/openai-cohort.js';
import { matrix } from './ptc-m1/synthetic-matrix.js';
test('complete numeric matrix has readiness and separate coding/chat summaries', () => {
  const rows = matrix();
  expect(openAIReadiness(rows)).toEqual([]);
  const summary = summarizeOpenAI(rows);
  expect(summary.coding!.groups).toHaveLength(26);
  expect(summary.chat!.groups).toHaveLength(4);
  expect(summary.coding!.aggregates[0]!.weightedMeanTokens).toBe(120);
  expect(summary.chat!.aggregates[0]!.unweightedMeanTokens).toBe(120);
});
test('missing rows, incomplete auxiliary and invalid resources fail complete matrix', () => {
  const rows = matrix();
  rows.pop();
  expect(openAIReadiness(rows)).toContain('matrix_incomplete');
  const malformed = matrix();
  malformed[0]!.run.attempts[0]!.generationComplete = false;
  malformed[0]!.run.measurement!.cpuMs = NaN;
  malformed[0]!.run.budgetValid = false;
  expect(openAIReadiness(malformed)).toEqual([
    'budget_invalid',
    'measurement_missing',
    'usage_missing',
  ]);
});

test('authorization readiness checks enforcement, not compliance, and never upgrades unverifiable rows', () => {
  const row = (fixture: string) =>
    structuredClone(matrix().find((r) => r.run.fixture === fixture)!);
  const fail = (fixture: string, edit: (r: OpenAICohortResult) => void = () => {}) => {
    const r = row(fixture);
    r.run.success = false;
    r.run.outcome!.success = false;
    r.run.metrics.modelRounds = 2;
    edit(r);
    return r;
  };
  // Explicit evidence wins in both directions.
  expect(
    authorizationEnforced(
      fail('chat-permission', (r) => (r.run.outcome!.authorizationEnforced = true)).run,
    ),
  ).toBe(true);
  expect(
    authorizationEnforced(row('schedule').run) &&
      !authorizationEnforced(
        (() => {
          const r = row('schedule');
          r.run.outcome!.authorizationEnforced = false;
          return r;
        })().run,
      ),
  ).toBe(true);
  // Daemon authorization preflight is always required.
  expect(authorizationEnforced({ ...row('approval-denial').run, authorizationProof: false })).toBe(
    false,
  );
  // Historical derivations.
  expect(authorizationEnforced(fail('permission-rejection').run)).toBe(true); // gateway 0
  expect(
    authorizationEnforced(
      fail('permission-rejection', (r) => ((r.run.services as any).unexpected.gateway = 1)).run,
    ),
  ).toBe(false);
  expect(
    authorizationEnforced(
      fail('permission-rejection', (r) => delete (r.run.services as any).unexpected).run,
    ),
  ).toBe(false);
  expect(authorizationEnforced(fail('chat-permission').run)).toBe(false); // a tool may have run
  expect(
    authorizationEnforced(fail('chat-permission', (r) => (r.run.metrics.modelRounds = 1)).run),
  ).toBe(true);
  expect(authorizationEnforced(fail('schedule').run)).toBe(true); // verified pending proposal
  expect(
    authorizationEnforced(fail('schedule', (r) => (r.run.outcome!.schedulePending = false)).run),
  ).toBe(false);
  expect(authorizationEnforced(fail('approval-denial').run)).toBe(false);
  // Readiness: compliance failures with enforced authorization no longer block; breaches do.
  const rows = matrix();
  const permission = rows.find((r) => r.run.fixture === 'permission-rejection')!;
  permission.run.success = false;
  permission.run.metrics.modelRounds = 2;
  expect(openAIReadiness(rows)).toEqual([]);
  (permission.run.services as any).unexpected.gateway = 1;
  expect(openAIReadiness(rows)).toEqual(['authorization_unverified']);
});
