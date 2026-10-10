import { expect, it } from 'bun:test';
import { snapshot } from '../../../scripts/model-catalog.js';

it('keeps providers with only supported wire APIs, in order, without cost', () => {
  const catalog: Record<string, { id: string; api: string; cost?: unknown }[]> = {
    zeta: [{ id: 'z', api: 'openai-responses', cost: { input: 1 } }],
    mixed: [
      { id: 'a', api: 'openai-completions' },
      { id: 'g', api: 'google-generative-ai' },
    ],
    empty: [],
    alpha: [{ id: 'a', api: 'anthropic-messages', cost: {} }],
  };
  const text = snapshot('1.2.3', Object.keys(catalog), (id) => catalog[id]!);
  expect(text.endsWith('\n')).toBe(true);
  expect(JSON.parse(text)).toEqual({
    piAi: '1.2.3',
    providers: {
      zeta: [{ id: 'z', api: 'openai-responses' }],
      alpha: [{ id: 'a', api: 'anthropic-messages' }],
    },
  });
  expect(Object.keys(JSON.parse(text).providers)).toEqual(['zeta', 'alpha']);
});
