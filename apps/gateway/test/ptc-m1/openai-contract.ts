/** OpenAI evaluation only. Old Opus artifacts/contracts remain unchanged. */
export const OPENAI_PROTOCOL = {
  version: 1,
  model: 'gpt-6.1-sol',
  api: 'openai-responses',
  endpoint: 'https://api.openai.com/v1',
  conditions: ['uncached', 'warm'],
  trialsPerCondition: 10,
  mainReasoning: 'medium',
  maxOutputTokens: 16_384,
  maxInputTokens: 922_000,
  serviceTier: 'default', // API value for Standard, not auto/flex/priority.
  limitUsd: 100,
  initialSpentUnits: 0,
  unitsPerUsd: 10_000_000,
  longInputThreshold: 272_000,
} as const;

export interface OpenAIUsage {
  /** Noncached, non-write input. OpenAI input_tokens includes both cache buckets. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  totalTokens: number;
}
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export function parseOpenAIUsage(value: unknown): OpenAIUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, any>;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cacheRead = usage.input_tokens_details?.cached_tokens;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  const total = usage.total_tokens;
  if (
    ![input, output, cacheRead, cacheWrite, reasoning, total].every(integer) ||
    !Number.isSafeInteger(input + output) ||
    input + output !== total ||
    cacheRead + cacheWrite > input ||
    reasoning > output
  )
    return null;
  return {
    input: input - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    totalTokens: total,
  };
}

/** Prices in $0.0000001 units/token. Standard; all-input threshold affects full request. */
export function openAICostUnits(usage: OpenAIUsage): number {
  if (
    !usage ||
    !(['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'totalTokens'] as const).every(
      (key) => integer(usage[key]),
    )
  )
    throw new Error('Invalid OpenAI usage');
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (
    !Number.isSafeInteger(input) ||
    usage.totalTokens !== input + usage.output ||
    usage.reasoning > usage.output
  )
    throw new Error('Inconsistent OpenAI usage');
  const long = input > OPENAI_PROTOCOL.longInputThreshold;
  const cost =
    (usage.input * 20 + usage.cacheRead + usage.cacheWrite * 25) * (long ? 2 : 1) +
    usage.output * (long ? 150 : 100);
  if (!Number.isSafeInteger(cost)) throw new Error('OpenAI cost overflow');
  return cost;
}

export function openAIUsageWithinBounds(usage: OpenAIUsage): boolean {
  return (
    usage.input + usage.cacheRead + usage.cacheWrite <= OPENAI_PROTOCOL.maxInputTokens &&
    usage.output <= OPENAI_PROTOCOL.maxOutputTokens
  );
}

/** Fixed numeric classifications only; no response text/IDs retained. */
export class OpenAIStreamEvidence {
  private created = false;
  private terminal = false;
  private invalid = false;
  private resultUsage: OpenAIUsage | null = null;
  private completed = false;
  observe(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.invalid = true;
      return;
    }
    const event = value as Record<string, any>;
    if (this.terminal) {
      this.invalid = true;
      return;
    }
    if (event.type === 'response.created') {
      if (this.created || event.response?.model !== OPENAI_PROTOCOL.model) this.invalid = true;
      this.created = true;
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      this.terminal = true;
      const response = event.response;
      const expected = event.type.slice('response.'.length);
      if (
        !this.created ||
        response?.model !== OPENAI_PROTOCOL.model ||
        response?.status !== expected ||
        response?.service_tier !== OPENAI_PROTOCOL.serviceTier
      )
        this.invalid = true;
      this.resultUsage = parseOpenAIUsage(response?.usage);
      this.completed = expected === 'completed';
    }
    if (event.type === 'error') this.invalid = true;
  }
  usage(): OpenAIUsage | null {
    return this.terminal && !this.invalid ? this.resultUsage : null;
  }
  success(): boolean {
    const usage = this.usage();
    return this.completed && usage !== null && openAIUsageWithinBounds(usage);
  }
}
