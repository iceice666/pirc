/** Approved evaluation-only wire controls; does not change prompt text or tool schemas. */
import { OPENAI_PROTOCOL } from './openai-contract.js';
export type OpenAICondition = 'uncached' | 'warm';
export function openAIControlledBody(
  value: unknown,
  condition: OpenAICondition,
): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Responses request');
  const body = structuredClone(value) as Record<string, any>;
  if (
    body.model !== OPENAI_PROTOCOL.model ||
    body.stream !== true ||
    body.store !== false ||
    !Number.isSafeInteger(body.max_output_tokens) ||
    body.max_output_tokens <= 0 ||
    body.max_output_tokens > OPENAI_PROTOCOL.maxOutputTokens ||
    !Array.isArray(body.input)
  )
    throw new Error('Unsupported Responses evaluation request');
  // The installed adapter generates per-session keys; these are not physical cache isolation.
  delete body.prompt_cache_key;
  delete body.prompt_cache_retention;
  // Equivalent content representation in BOTH cohorts; text stays byte-identical.
  for (const message of body.input)
    if (message.role === 'developer' && typeof message.content === 'string')
      message.content = [{ type: 'input_text', text: message.content }];
  // Do not walk tools/JSON schemas: a property named prompt_cache_breakpoint there is data.
  for (const message of body.input)
    if (Array.isArray(message.content)) {
      for (const part of message.content)
        if (part && typeof part === 'object') delete part.prompt_cache_breakpoint;
    }
  body.service_tier = OPENAI_PROTOCOL.serviceTier;
  body.prompt_cache_options = { mode: 'explicit' };
  if (condition === 'warm') {
    // A fixed developer-message endpoint includes tools and stable system instructions.
    const developer = body.input.find(
      (item: any) => item.role === 'developer' && Array.isArray(item.content),
    );
    const part = developer?.content?.findLast((item: any) => item.type === 'input_text');
    if (!part) throw new Error('No supported developer cache breakpoint');
    part.prompt_cache_breakpoint = { mode: 'explicit' };
    body.prompt_cache_options.ttl = '30m';
  }
  return body;
}
