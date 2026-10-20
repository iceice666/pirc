import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openCodeCatalog, pinnedOpenCodeCatalog } from '../opencode-catalog.ts';
import { snapshot } from '../model-catalog.ts';

const base = 'https://opencode.ai/inference/openai/v1';
const model = (npm, extra = {}) => ({
  name: 'Test model',
  reasoning: true,
  provider: { npm, api: npm === '@ai-sdk/anthropic' ? base.replace('openai', 'anthropic') : base },
  limit: { context: 1000000, output: 128000 },
  modalities: { input: ['text', 'image', 'pdf'] },
  ...extra,
});
function sources() {
  return {
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      api: base,
      models: {
        chat: model('@ai-sdk/openai-compatible', { interleaved: { field: 'reasoning_content' } }),
        responses: model('@ai-sdk/openai'),
        anthropic: model('@ai-sdk/anthropic'),
        google: model('@ai-sdk/google'),
      },
    },
    'opencode-go': {
      npm: '@ai-sdk/openai-compatible',
      api: base.replace('/inference/', '/inference/go/'),
      models: {},
    },
  };
}
const live = () =>
  Object.fromEntries(
    ['opencode', 'opencode-go'].map((p) => [
      p,
      {
        data: ['responses', 'chat', 'anthropic', 'google', 'unknown', 'chat'].map((id) => ({ id })),
      },
    ]),
  );

test('OpenCode keeps native protocols and normalizes Anthropic paths on the correct plan', () => {
  const { providers, omitted } = openCodeCatalog(sources(), live());
  for (const p of ['opencode', 'opencode-go']) {
    const [anthropic, chat, responses] = providers[p];
    const root =
      p === 'opencode' ? 'https://opencode.ai/inference' : 'https://opencode.ai/inference/go';
    assert.deepEqual(
      providers[p].map((m) => m.id),
      ['anthropic', 'chat', 'responses'],
    );
    assert.equal(anthropic.api, 'anthropic-messages');
    assert.equal(anthropic.baseUrl, `${root}/anthropic`);
    assert.equal(responses.api, 'openai-responses');
    assert.equal(chat.api, 'openai-completions');
    assert.equal(responses.baseUrl, `${root}/openai/v1`);
    assert.equal(chat.contextWindow, 1000000);
    assert.equal(chat.maxTokens, 128000);
    assert.deepEqual(chat.input, ['text', 'image']);
    assert.deepEqual(chat.compat, { requiresReasoningContentOnAssistantMessages: true });
    assert.deepEqual(
      omitted[p].map((m) => m.id),
      ['google', 'unknown'],
    );
  }
});

test('models absent from the official live list are not advertised', () => {
  const metadata = sources();
  metadata.opencode.models.removed = model('@ai-sdk/openai');
  const result = openCodeCatalog(metadata, live());
  assert(!result.providers.opencode.some((m) => m.id === 'removed'));
});

test('source endpoints and limits fail closed instead of guessing request metadata', () => {
  for (const change of [
    (m) => {
      m.provider.api = 'https://other.example/v1';
    },
    (m) => {
      m.limit.output = 0;
    },
    (m) => {
      m.limit.context = 1.5;
    },
    (m) => {
      m.modalities.input = ['audio'];
    },
  ]) {
    const metadata = sources();
    change(metadata.opencode.models.chat);
    assert.throws(() => openCodeCatalog(metadata, live()));
  }
});

test('snapshot preserves same-API compatibility while replacing stale limits', () => {
  const previous = {
    id: 'chat',
    api: 'openai-completions',
    cost: {},
    contextWindow: 10,
    compat: { thinkingFormat: 'deepseek' },
    thinkingLevelMap: { high: 'high' },
  };
  const fresh = openCodeCatalog(sources(), live()).providers;
  const generated = snapshot(
    'test',
    ['other', 'opencode'],
    (p) => (p === 'other' ? [{ ...previous, id: 'other' }] : p === 'opencode' ? [previous] : []),
    fresh,
  );
  const result = JSON.parse(generated);
  const chat = result.providers.opencode.find((m) => m.id === 'chat');
  assert.equal(chat.contextWindow, 1000000);
  assert.deepEqual(chat.compat, {
    thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true,
  });
  assert.deepEqual(chat.thinkingLevelMap, { high: 'high' });
  assert(!('cost' in chat));
  assert.equal(result.providers.other[0].contextWindow, 10);
  assert(!('thinkingLevelMap' in fresh.opencode.find((m) => m.id === 'chat')));
  assert.equal(
    snapshot(
      'test',
      ['other', 'opencode'],
      (p) => (p === 'other' ? [{ ...previous, id: 'other' }] : p === 'opencode' ? [previous] : []),
      fresh,
    ),
    generated,
  );
});

test('a protocol change does not carry old API-specific compatibility', () => {
  const fresh = openCodeCatalog(sources(), live()).providers;
  const result = JSON.parse(
    snapshot(
      'test',
      ['opencode'],
      () => [
        {
          id: 'anthropic',
          api: 'openai-completions',
          compat: { thinkingFormat: 'qwen' },
        },
      ],
      fresh,
    ),
  );
  assert(!('compat' in result.providers.opencode.find((m) => m.id === 'anthropic')));
});

test('pinning records source hashes and explicit unsupported omissions', () => {
  const data = {
    metadata: JSON.stringify(sources()),
    ...Object.fromEntries(Object.entries(live()).map(([p, d]) => [p, JSON.stringify(d)])),
  };
  const pin = pinnedOpenCodeCatalog(data, '2026-10-20');
  assert.equal(pin.sources.length, 3);
  assert(pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(pin.updated, '2026-10-20');
  assert.equal(pin.omitted['opencode-go'].length, 2);
});

test('the committed catalog has new Go models with all three supported wire APIs', () => {
  const pin = JSON.parse(readFileSync(new URL('../catalog/opencode.json', import.meta.url)));
  const byId = new Map(pin.providers['opencode-go'].map((m) => [m.id, m]));
  assert.equal(byId.get('gpt-6-luna').api, 'openai-responses');
  assert.equal(byId.get('claude-haiku-5-5').api, 'anthropic-messages');
  assert.equal(byId.get('deepseek-v4.1-flash').api, 'openai-completions');
  assert(!byId.has('glm-5'));
  assert(!byId.has('gemini-4-argon-contributor'));
  assert(pin.omitted['opencode-go'].some((m) => m.id === 'gemini-4-argon-contributor'));
});
