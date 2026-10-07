/** Test-only live evaluation ledger. No credentials, prompts or provider bodies are retained. */
export const LIVE_MODEL = 'claude-opus-5-5';
export const LIVE_OUTPUT_CAP = 16_384;
export const LIVE_CONTEXT_CAP = 1_000_000;
// Integer units of USD 0.0000002. Cache writes use the higher 1h price even for 5m writes.
const UNITS_PER_USD = 5_000_000;
const rates = { input: 20, output: 100, cacheWrite: 40, cacheRead: 1 } as const;
export interface WireUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export function usageUnits(usage: WireUsage): number {
  if (!Object.keys(rates).every((key) => count(usage[key as keyof WireUsage])))
    throw new Error('Invalid provider usage');
  const units = Object.entries(rates).reduce(
    (sum, [key, rate]) => sum + usage[key as keyof WireUsage] * rate,
    0,
  );
  if (!Number.isSafeInteger(units)) throw new Error('Usage overflow');
  return units;
}

/** Synchronous admission reserves liability before async network I/O, including child requests. */
export class LiveBudget {
  private spent: number;
  private reserved = new Map<number, number>();
  private next = 0;
  private halted = false;
  private unknown = new Set<number>();
  private attempts = 0;
  private readonly limit: number;

  private readonly checkpoint: (() => void) | undefined;

  constructor(options: { limitUsd: number; priorUnits: number; checkpoint?: () => void }) {
    this.checkpoint = options.checkpoint;
    this.limit = options.limitUsd * UNITS_PER_USD;
    if (
      !count(this.limit) ||
      this.limit <= 0 ||
      !count(options.priorUnits) ||
      options.priorUnits > this.limit
    )
      throw new Error('Invalid budget');
    this.spent = options.priorUnits;
  }

  reserve(inputTokenBound = LIVE_CONTEXT_CAP, outputTokenBound = LIVE_OUTPUT_CAP): number {
    if (
      this.halted ||
      !count(inputTokenBound) ||
      !count(outputTokenBound) ||
      inputTokenBound > LIVE_CONTEXT_CAP ||
      outputTokenBound > LIVE_OUTPUT_CAP
    )
      throw new Error('Live budget admission blocked');
    // All input could be a 1h cache write. Never assume cache hits when admitting requests.
    const amount = inputTokenBound * rates.cacheWrite + outputTokenBound * rates.output;
    if (this.spent + this.outstanding() + amount > this.limit)
      throw new Error('Live budget exhausted');
    const id = ++this.next;
    this.reserved.set(id, amount);
    this.attempts++;
    this.save();
    return id;
  }

  settle(id: number, usage: WireUsage): void {
    const reservation = this.reserved.get(id);
    if (reservation === undefined) throw new Error('Unknown budget reservation');
    let actual: number;
    try {
      actual = usageUnits(usage);
    } catch {
      this.uncertain(id);
      throw new Error('Invalid provider usage');
    }
    if (actual > reservation) {
      this.halted = true;
      this.reserved.delete(id);
      this.spent += actual;
      this.save();
      throw new Error('Provider exceeded reserved liability');
    }
    this.reserved.delete(id);
    this.spent += actual;
    this.save();
  }

  /** A lost/truncated/error reply may still be billed. Retain its full reservation and stop. */
  uncertain(id: number): void {
    if (!this.reserved.has(id)) throw new Error('Unknown budget reservation');
    this.halted = true;
    this.unknown.add(id);
    this.save();
  }

  private save(): void {
    try {
      this.checkpoint?.();
    } catch {
      this.halted = true;
      throw new Error('Budget checkpoint failed');
    }
  }

  private outstanding(): number {
    return [...this.reserved.values()].reduce((sum, value) => sum + value, 0);
  }

  snapshot() {
    return {
      spentUnits: this.spent,
      reservedUnits: this.outstanding(),
      limitUsdEquivalent: this.limit / UNITS_PER_USD,
      spentUsdEquivalent: this.spent / UNITS_PER_USD,
      reservedUsdEquivalent: this.outstanding() / UNITS_PER_USD,
      unknownAttempts: this.unknown.size,
      admittedAttempts: this.attempts,
      halted: this.halted,
    };
  }
}

/** Raw usage fields must be present: normalized adapter zeros are not evidence. */
export function anthropicUsage(value: unknown): WireUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ];
  if (!keys.every((key) => count(raw[key]))) return null;
  return {
    input: raw.input_tokens as number,
    output: raw.output_tokens as number,
    cacheWrite: raw.cache_creation_input_tokens as number,
    cacheRead: raw.cache_read_input_tokens as number,
  };
}

/** Content-blind wire evidence. A truncated stream never becomes a complete zero-cost call. */
export class AnthropicEvidence {
  private usage: WireUsage | null = null;
  private started = false;
  private finalUsage = false;
  private stopped = false;
  private invalid = false;

  observe(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.invalid = true;
      return;
    }
    const event = value as Record<string, any>;
    if (this.stopped) this.invalid = true;
    switch (event.type) {
      case 'message_start':
        if (this.started || event.message?.model !== LIVE_MODEL) this.invalid = true;
        this.started = true;
        this.usage = anthropicUsage(event.message?.usage);
        if (!this.usage) this.invalid = true;
        break;
      case 'message_delta':
        if (
          !this.started ||
          !this.usage ||
          !count(event.usage?.output_tokens) ||
          event.usage.output_tokens < this.usage.output
        ) {
          this.invalid = true;
          break;
        }
        for (const [wire, key] of [
          ['input_tokens', 'input'],
          ['cache_creation_input_tokens', 'cacheWrite'],
          ['cache_read_input_tokens', 'cacheRead'],
        ] as const) {
          if (Object.hasOwn(event.usage, wire)) {
            const value = event.usage[wire];
            if (!count(value) || value < this.usage[key]) this.invalid = true;
            else this.usage[key] = value;
          }
        }
        this.usage.output = event.usage.output_tokens;
        this.finalUsage = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(
          event.delta?.stop_reason,
        );
        break;
      case 'message_stop':
        if (!this.started || !this.finalUsage) this.invalid = true;
        this.stopped = true;
        break;
      case 'error':
        this.invalid = true;
        break;
    }
  }

  status(): 'complete' | 'invalid' | 'missing_start' | 'missing_final_usage' | 'missing_stop' {
    if (this.invalid) return 'invalid';
    if (!this.started) return 'missing_start';
    if (!this.finalUsage) return 'missing_final_usage';
    if (!this.stopped) return 'missing_stop';
    return 'complete';
  }

  result(): WireUsage | null {
    return !this.invalid && this.stopped && this.finalUsage && this.usage
      ? { ...this.usage }
      : null;
  }
}
