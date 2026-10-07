/** Enforces actual initial-body evidence, with hashes retained only in memory. */
import type { Fixture } from './fixtures.js';
import type { Trial } from './metrics.js';
import type { InitialRequest } from './initial-request.js';
import { DisposablePair } from './disposable-pair.js';
import { initialCacheEvidence } from './cache-evidence.js';
import { runFixture } from './fixture-runner.js';
import type { LiveBudget } from './live-budget.js';

export class CacheController {
  private pair: DisposablePair | undefined;
  private prime: ReturnType<InitialRequest['snapshot']> = null;
  private pairing: { fixture: string; index: number } | undefined;
  private lastFinished: number;
  private primeValid = false;
  private busy = false;
  private failed = false;
  private readonly now: () => number;
  private readonly run: typeof runFixture;
  constructor(
    private readonly options: {
      nodeBinary: string;
      chatBinary: string;
      endpoint: string;
      apiKey: string;
      budget: LiveBudget;
      signal?: AbortSignal;
    },
    /** Offline test seam; injected runs can never produce real-model provenance. */
    private readonly test?: { now: () => number; run: typeof runFixture },
  ) {
    this.now = test?.now ?? Date.now;
    this.run = test?.run ?? runFixture;
    this.lastFinished = this.now();
  }

  async execute(
    fixture: Fixture,
    cache: 'cold' | 'warm',
    phase: 'warmup' | 'measured',
    index: number,
  ) {
    if (this.busy || this.failed) throw new Error('Cache controller unavailable');
    if (!Number.isSafeInteger(index) || index < 0 || (phase === 'warmup' && cache !== 'warm'))
      throw new Error('Invalid cohort phase');
    this.busy = true;
    try {
      const elapsed = this.now() - this.lastFinished;
      if (phase === 'warmup') {
        if (this.pair) throw new Error('Previous warm pair not closed');
        this.pair = await DisposablePair.create();
        this.pairing = { fixture: fixture.id, index };
      } else if (
        cache === 'warm' &&
        (!this.pair ||
          !this.primeValid ||
          this.pairing?.fixture !== fixture.id ||
          this.pairing.index !== index)
      )
        throw new Error('Missing matching warm prime');
      let evidence: ReturnType<InitialRequest['snapshot']> = null;
      const result = await this.run({
        fixture,
        binary: fixture.kind === 'chat' ? this.options.chatBinary : this.options.nodeBinary,
        endpoint: this.options.endpoint,
        apiKey: this.options.apiKey,
        budget: this.options.budget,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(cache === 'warm' && this.pair ? { pair: this.pair } : {}),
        onInitialEvidence: (value) => {
          evidence = value;
        },
      });
      this.lastFinished = result.requestFinishedAt;
      const observed = evidence as ReturnType<InitialRequest['snapshot']>;
      const identical = !!observed && !!this.prime && observed.bodyHash === this.prime.bodyHash;
      const cacheVerified = initialCacheEvidence(cache, observed?.attempt, {
        elapsedSinceLastProviderRequestMs: elapsed,
        identicalPrefixPrimed: phase === 'measured' && identical,
      });
      if (phase === 'warmup') {
        this.prime = observed;
        this.primeValid =
          result.success &&
          result.allAttemptsAccounted &&
          !!observed?.attempt.usage &&
          observed.attempt.completion === 'complete';
      }
      let infrastructureValid = result.infrastructureValid;
      if (cache === 'warm' && phase === 'measured') {
        try {
          await this.pair!.close();
        } catch {
          infrastructureValid = false;
          this.failed = true;
        }
        this.pair = undefined;
        this.prime = null;
        this.pairing = undefined;
      }
      const trial: Trial = {
        fixture: fixture.id,
        kind: fixture.kind,
        cache,
        success: result.success,
        metrics: result.metrics,
        wallMs: result.measurement?.wallMs ?? 0,
        cpuMs: result.measurement?.cpuMs ?? null,
        cgroupMemoryPeakBytes: result.measurement?.cgroupMemoryPeakBytes ?? null,
        provenance: this.test ? 'synthetic' : 'real-opus-5.5',
        cacheVerified,
        childrenAccounted: result.childrenAccounted,
        allAttemptsAccounted: result.allAttemptsAccounted,
        authorizationOracle: [
          'approval-denial',
          'permission-rejection',
          'chat-permission',
          'schedule',
        ].includes(fixture.id)
          ? result.authorizationProof &&
            !!result.services?.serviceValid &&
            !!result.outcome?.success
          : null,
        cancellationOracle:
          fixture.id === 'cancel-wait'
            ? !!result.outcome?.cancellationObserved && result.success
            : null,
      };
      return {
        trial,
        infrastructureValid,
        requestFinishedAt: result.requestFinishedAt,
        diagnostics: {
          startupMs: result.measurement?.startupMs ?? null,
          resourceStartLeadMs: result.measurement?.resourceStartLeadMs ?? null,
          resourceEndLagMs: result.measurement?.resourceEndLagMs ?? null,
          cpuWindow: result.measurement?.cpuWindow ?? null,
          memoryWindow: result.measurement?.memoryWindow ?? null,
          drain: result.drain,
          firstRequestObserved: !!observed,
          identicalPrimedBody: identical,
          phase,
        },
        attempts: result.attempts,
      };
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async close(): Promise<void> {
    if (this.busy) throw new Error('Cannot close an executing cache controller');
    this.failed = true;
    await this.pair?.close();
    this.pair = undefined;
  }
}
