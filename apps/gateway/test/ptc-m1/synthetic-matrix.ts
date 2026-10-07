/** Synthetic complete OpenAI matrix for offline readiness/bounds tests; never live evidence. */
import { FIXTURES } from './fixtures.js';
import { newMetrics } from './metrics.js';
import { OpenAIBudget } from './openai-budget.js';
import type { OpenAICohortResult } from './openai-cohort.js';
export function matrix(): OpenAICohortResult[] {
  return FIXTURES.flatMap((f) =>
    ['uncached', 'warm'].flatMap((condition) =>
      Array.from({ length: 10 }, () => ({
        condition: condition as 'uncached' | 'warm',
        cacheVerified: true,
        infrastructureValid: true,
        provenance: 'real-openai' as const,
        run: {
          fixture: f.id,
          kind: f.kind,
          condition: condition as 'uncached' | 'warm',
          infrastructureValid: true,
          budgetValid: true,
          budget: new OpenAIBudget().snapshot(),
          success: true,
          measurement: {
            wallMs: 2,
            startupMs: 1,
            cpuMs: 1,
            cgroupMemoryPeakBytes: 1024,
            resourceStartLeadMs: 0,
            resourceEndLagMs: 0,
            cpuWindow: 'pre-dispatch-through-post-settled-sample' as const,
            memoryWindow: 'unit-start-through-post-settled-sample' as const,
          },
          requestFinishedAt: 1,
          drain: null,
          outcome: {
            success: true,
            authorizationEnforced: null as boolean | null,
            filesMatch: true,
            toolsCompleted: true,
            toolErrors: 0,
            imageDelivered: true,
            cancellationObserved: true,
            schedulePending: true,
          },
          services: {
            serviceValid: true,
            questions: 0,
            denials: 0,
            unexpected: { gateway: 0, browser: 0, interaction: 0 },
          },
          authorizationProof: true,
          teamEvidence: null,
          metrics: {
            ...newMetrics(),
            modelRounds: 1,
            requestCount: 1,
            input: 100,
            output: 20,
            totalTokens: 120,
          },
          reasoningTokens: 5,
          attempts: [
            {
              schemaBytes: 1,
              contextBytes: 1,
              requestBytes: 1,
              responseBytes: 1,
              durationMs: 1,
              status: 200,
              usage: {
                input: 100,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 5,
                totalTokens: 120,
              },
              completion: 'complete' as const,
              evidence: 'complete' as const,
              condition: condition as 'uncached' | 'warm',
              generationComplete: true,
              cacheConditionValid: true,
              requestedReasoning: 'medium',
              effectiveReasoning: 'medium',
              outputCap: 16384,
            },
          ],
          cacheVerified: true,
          accounting: {
            verified: true,
            requests: 1,
            owners: { parent: 1, child: 0, auxiliary: 0, unknown: 0 },
            attempts: 1,
            completeAttempts: 1,
            pending: 0,
            unmatchedRequests: 0,
            localDeniedRequests: 0,
          },
          childrenAccounted: true,
          allAttemptsAccounted: true,
        },
      })),
    ),
  );
}
