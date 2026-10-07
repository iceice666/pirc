import { expect, test } from 'bun:test';
import { openAIControlledBody } from './ptc-m1/openai-cache.js';
import { OPENAI_PROTOCOL } from './ptc-m1/openai-contract.js';
const body = () => ({
  model: OPENAI_PROTOCOL.model,
  stream: true,
  store: false,
  max_output_tokens: 16384,
  prompt_cache_key: 'synthetic-session',
  prompt_cache_retention: '24h',
  input: [
    { role: 'developer', content: 'EXACT SYSTEM' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'task', prompt_cache_breakpoint: { mode: 'explicit' } },
      ],
    },
  ],
  tools: [
    {
      type: 'function',
      name: 'read',
      parameters: { type: 'object', properties: { prompt_cache_breakpoint: { type: 'string' } } },
    },
  ],
});
test('uncached explicitly has no content breakpoints without changing tool-schema properties', () => {
  const source = body();
  const result = openAIControlledBody(source, 'uncached');
  expect(result.prompt_cache_options).toEqual({ mode: 'explicit' });
  expect(result.service_tier).toBe('default');
  expect(result.prompt_cache_key).toBeUndefined();
  expect(result.prompt_cache_retention).toBeUndefined();
  expect(result.input[0].content).toEqual([{ type: 'input_text', text: 'EXACT SYSTEM' }]);
  expect(result.input[1].content[0].prompt_cache_breakpoint).toBeUndefined();
  expect(result.tools).toEqual(source.tools);
  expect(source.input[1]!.content).not.toEqual(result.input[1].content);
});
test('warm has one fixed developer endpoint and unchanged prompt/schema text', () => {
  const source = body();
  const result = openAIControlledBody(source, 'warm');
  expect(result.input[0].content[0]).toEqual({
    type: 'input_text',
    text: 'EXACT SYSTEM',
    prompt_cache_breakpoint: { mode: 'explicit' },
  });
  expect(result.input[1].content[0]).toEqual({ type: 'input_text', text: 'task' });
  expect(result.tools).toEqual(source.tools);
  expect(result.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
  expect(() => openAIControlledBody({ ...source, model: 'other' }, 'warm')).toThrow();
  expect(() =>
    openAIControlledBody({ ...source, max_output_tokens: 100000 }, 'uncached'),
  ).toThrow();
});
