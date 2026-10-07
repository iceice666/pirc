/** OpenAI cache cohort controller, no TTL sleeps or old Opus budget carry-forward. */
import type { Fixture } from './fixtures.js';
import { DisposablePair } from './disposable-pair.js';
import type { InitialRequest } from './initial-request.js';
import { runOpenAIFixture } from './openai-runner.js';
import type { OpenAIBudget } from './openai-budget.js';
import type { OpenAICohortResult } from './openai-cohort.js';
import type { OpenAIAttemptSummary } from './openai-provider.js';
export class OpenAIController {
  private pair: DisposablePair | undefined;
  private prime: ReturnType<InitialRequest['snapshot']> = null;
  private pairing = '';
  private primeValid = false;
  private busy = false;
  private failed = false;
  constructor(
    private readonly options: {
      nodeBinary: string;
      chatBinary: string;
      endpoint: string;
      apiKey: string;
      budget: OpenAIBudget;
      signal: AbortSignal;
      /** Default true (historical). False only pairs with cohort primeOutcome 'record'. */
      requirePrimeSuccess?: boolean;
      /** Feature settings for every measured agent's disposable config. */
      features?: Record<string, unknown>;
      trialDeadlineMs?: number;
    },
    private readonly test?: { run: typeof runOpenAIFixture },
  ) {}
  async execute(
    fixture: Fixture,
    phase: 'uncached' | 'prime' | 'warm',
    index: number,
  ): Promise<OpenAICohortResult> {
    if (this.failed || this.busy) throw new Error('OpenAI controller unavailable');
    this.options.signal.throwIfAborted();
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid OpenAI trial index');
    this.busy = true;
    try {
      const condition = phase === 'uncached' ? 'uncached' : 'warm';
      if (phase === 'prime') {
        if (this.pair) throw new Error('OpenAI pair already active');
        this.pair = await DisposablePair.create();
        this.pairing = `${fixture.id}:${index}`;
      } else if (
        phase === 'warm' &&
        (!this.pair || !this.primeValid || this.pairing !== `${fixture.id}:${index}`)
      )
        throw new Error('OpenAI matching prime missing');
      else if (phase === 'uncached' && this.pair) throw new Error('OpenAI pending warm pair');
      let evidence: ReturnType<InitialRequest['snapshot']> = null;
      const run = await (this.test?.run ?? runOpenAIFixture)({
        fixture,
        condition,
        binary: fixture.kind === 'chat' ? this.options.chatBinary : this.options.nodeBinary,
        endpoint: this.options.endpoint,
        apiKey: this.options.apiKey,
        budget: this.options.budget,
        signal: this.options.signal,
        ...(this.pair ? { pair: this.pair } : {}),
        ...(this.options.features ? { features: this.options.features } : {}),
        ...(this.options.trialDeadlineMs ? { trialDeadlineMs: this.options.trialDeadlineMs } : {}),
        onInitialEvidence: (value) => {
          evidence = value;
        },
      });
      const observed = evidence as ReturnType<InitialRequest['snapshot']>;
      const initial = observed?.attempt as OpenAIAttemptSummary | undefined;
      const initialValid =
        !!initial?.usage &&
        initial.completion === 'complete' &&
        initial.generationComplete &&
        initial.cacheConditionValid;
      const identical = !!observed && !!this.prime && observed.bodyHash === this.prime.bodyHash;
      const cacheVerified =
        phase === 'uncached'
          ? run.cacheVerified && initialValid
          : phase === 'warm' && initialValid && identical && initial!.usage!.cacheRead > 0;
      if (phase === 'prime') {
        this.prime = observed;
        this.primeValid =
          (run.success || this.options.requirePrimeSuccess === false) &&
          run.infrastructureValid &&
          run.allAttemptsAccounted &&
          initialValid;
      }
      let infrastructureValid = run.infrastructureValid;
      if (phase === 'warm') {
        try {
          await this.pair!.close();
        } catch {
          infrastructureValid = false;
          this.failed = true;
        }
        this.pair = undefined;
        this.prime = null;
        this.primeValid = false;
        this.pairing = '';
      }
      return {
        run,
        condition,
        cacheVerified,
        infrastructureValid,
        provenance: this.test ? 'synthetic' : 'real-openai',
        cacheDiagnostics: {
          firstRequestObserved: !!observed,
          identicalPrimedBody: identical,
          initialComplete: !!initialValid,
          initialCacheRead: initial?.usage?.cacheRead ?? null,
        },
      };
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async close() {
    if (this.busy) throw new Error('OpenAI controller active');
    this.failed = true;
    await this.pair?.close();
    this.pair = undefined;
  }
}
