import { expect, it } from 'bun:test';
import { modelsSchema, publicModels } from '../src/models.js';

it('projects explicit metadata without endpoints, keys, headers, arbitrary compat or transport', () => {
  const source = modelsSchema.parse({
    providers: {
      main: {
        api: 'anthropic-messages',
        piProvider: 'anthropic',
        baseUrl: 'https://private.example/secret-endpoint',
        apiKey: 'secret-key',
        headers: { authorization: 'secret-header' },
        compat: { secret: 'secret-compat', supportsLongCacheRetention: true },
        models: [
          {
            id: 'm',
            api: 'openai-responses',
            baseUrl: 'https://secret-model.example',
            canonicalProvider: 'secret-alias',
            compat: { secret: 'secret-model-compat', supportsLongCacheRetention: false },
            thinkingLevelMap: { high: 'high', xhigh: null },
          },
        ],
      },
    },
    defaultModel: { provider: 'main', id: 'm' },
    inference: { socketPath: '/private/socket', token: 'secret-local' },
  });
  const result = publicModels(source);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result.inference).toBeUndefined();
  expect(result.providers.main!.compat.supportsLongCacheRetention).toBe(true);
  expect(result.providers.main!.models[0]!.compat.supportsLongCacheRetention).toBe(false);
  expect(result.providers.main!.models[0]!.api).toBe('openai-responses');
  expect(result.defaultModel).toEqual(source.defaultModel);
  expect(modelsSchema.parse(result)).toEqual(result);
  expect(source.providers.main!.apiKey).toBe('secret-key');
});
