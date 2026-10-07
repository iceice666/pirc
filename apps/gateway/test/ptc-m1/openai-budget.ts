/** Separate OpenAI ledger: never reuse Opus units, prices or spent amounts. */
import {
  OPENAI_PROTOCOL,
  openAICostUnits,
  openAIUsageWithinBounds,
  type OpenAIUsage,
} from './openai-contract.js';
export type BudgetDenialReason =
  | 'halted'
  | 'attempt_limit'
  | 'spend_limit'
  | 'outstanding_pressure'
  | 'checkpoint_failure';
/** One attempt's worst case: full supported input at long-context cache-write price plus maximum output. */
export const ATTEMPT_RESERVATION_UNITS =
  OPENAI_PROTOCOL.maxInputTokens * 50 + OPENAI_PROTOCOL.maxOutputTokens * 150;
export class OpenAIBudgetDenial extends Error {
  constructor(readonly reason: BudgetDenialReason) {
    super(`OpenAI budget exhausted or halted: ${reason}`);
  }
}
export class OpenAIBudget {
  private spent = 0;
  private reservations = new Map<number, number>();
  private unknown = new Set<number>();
  private next = 0;
  private halted = false;
  private denials: Record<BudgetDenialReason, number> = {
    halted: 0,
    attempt_limit: 0,
    spend_limit: 0,
    outstanding_pressure: 0,
    checkpoint_failure: 0,
  };
  private readonly limit: number;
  private invocationLimit: number;
  private attemptLimit = Number.MAX_SAFE_INTEGER;
  constructor(
    private readonly checkpoint?: () => void,
    carry?: { spentUnits: number; admittedAttempts: number },
    bounds?: { additionalUnits: number; maxAttempts: number },
    /** The independent budget's limit; the protocol's unless raised by a recorded amendment. */
    readonly limitUsd: number = OPENAI_PROTOCOL.limitUsd,
  ) {
    if (!Number.isSafeInteger(limitUsd) || limitUsd < OPENAI_PROTOCOL.limitUsd || limitUsd > 1000)
      throw new Error('Invalid OpenAI budget limit');
    this.limit = limitUsd * OPENAI_PROTOCOL.unitsPerUsd;
    this.invocationLimit = this.limit;
    if (carry) {
      if (
        !Number.isSafeInteger(carry.spentUnits) ||
        carry.spentUnits < 0 ||
        carry.spentUnits > this.limit ||
        !Number.isSafeInteger(carry.admittedAttempts) ||
        carry.admittedAttempts < 0
      )
        throw new Error('Invalid OpenAI budget carry');
      this.spent = carry.spentUnits;
      this.next = carry.admittedAttempts;
    }
    if (bounds) {
      if (
        !Number.isSafeInteger(bounds.additionalUnits) ||
        bounds.additionalUnits <= 0 ||
        !Number.isSafeInteger(bounds.maxAttempts) ||
        bounds.maxAttempts <= 0 ||
        !Number.isSafeInteger(this.spent + bounds.additionalUnits) ||
        !Number.isSafeInteger(this.next + bounds.maxAttempts)
      )
        throw new Error('Invalid diagnostic budget bounds');
      this.invocationLimit = Math.min(this.limit, this.spent + bounds.additionalUnits);
      this.attemptLimit = this.next + bounds.maxAttempts;
    }
  }
  private save() {
    try {
      this.checkpoint?.();
    } catch {
      this.halted = true;
      throw new Error('OpenAI budget checkpoint failed');
    }
  }
  private reserved() {
    return [...this.reservations.values()].reduce((a, b) => a + b, 0);
  }
  reserve(): number {
    const deny = (reason: BudgetDenialReason): never => {
      this.denials[reason]++;
      this.save();
      throw new OpenAIBudgetDenial(reason);
    };
    if (this.halted) deny('halted');
    const amount = ATTEMPT_RESERVATION_UNITS;
    if (this.next >= this.attemptLimit) deny('attempt_limit');
    if (this.spent + amount > this.invocationLimit) deny('spend_limit');
    if (this.spent + this.reserved() + amount > this.invocationLimit) deny('outstanding_pressure');
    const id = ++this.next;
    this.reservations.set(id, amount);
    try {
      this.save();
    } catch {
      this.denials.checkpoint_failure++;
      throw new OpenAIBudgetDenial('checkpoint_failure');
    }
    return id;
  }
  settle(id: number, usage: OpenAIUsage): void {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) throw new Error('Unknown OpenAI reservation');
    let actual: number;
    try {
      actual = openAICostUnits(usage);
    } catch {
      this.uncertain(id);
      throw new Error('Invalid OpenAI cost');
    }
    this.reservations.delete(id);
    this.spent += actual;
    const exceeded = actual > reservation || !openAIUsageWithinBounds(usage);
    if (exceeded) this.halted = true;
    this.save();
    if (exceeded) throw new Error('OpenAI usage exceeded admitted bounds');
  }
  uncertain(id: number): void {
    if (!this.reservations.has(id)) throw new Error('Unknown OpenAI reservation');
    this.halted = true;
    this.unknown.add(id);
    this.save();
  }
  halt(): void {
    this.halted = true;
    this.save();
  }
  snapshot() {
    return {
      currency: 'USD',
      provider: 'openai',
      limitUsd: this.limitUsd,
      spentUnits: this.spent,
      reservedUnits: this.reserved(),
      spentUsd: this.spent / OPENAI_PROTOCOL.unitsPerUsd,
      reservedUsd: this.reserved() / OPENAI_PROTOCOL.unitsPerUsd,
      unknownAttempts: this.unknown.size,
      admittedAttempts: this.next,
      halted: this.halted,
      localDenials: { ...this.denials },
    };
  }
}
