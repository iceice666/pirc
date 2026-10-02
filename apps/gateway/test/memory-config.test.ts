import { afterEach, describe, expect, it } from 'bun:test';
import { memoryConfigFrom, validateMemoryConfig } from '../src/agent/features/memory/config.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});
const warnings = (agent: AgentProcess) =>
  agent.events.filter(
    (event) =>
      event.type === 'extension_ui_request' &&
      String(event.message).startsWith('Observational memory configuration:'),
  );

describe('observational memory configuration diagnostics', () => {
  it('accepts defaults and valid disabled settings without a warning', () => {
    expect(validateMemoryConfig({}).warning).toBeUndefined();
    const settings = { observationalMemory: { enabled: false, workspace: { enabled: false } } };
    const result = validateMemoryConfig(settings);
    expect(result.warning).toBeUndefined();
    expect(result.config.enabled).toBe(false);
    expect(result.config.workspace.enabled).toBe(false);
    expect(result.config.fallbackModels).toEqual([]);
    expect(validateMemoryConfig(settings)).toBe(result);
  });

  it('warns that one malformed fallback resets the whole config, including disabled flags', () => {
    const settings = {
      observationalMemory: {
        enabled: false,
        workspace: { enabled: false },
        observeAfterTokens: 42,
        fallbackModels: [
          { provider: 'fake', id: 'model' },
          { provider: '', id: 'private-model-value' },
        ],
      },
    };
    const { config, warning } = validateMemoryConfig(settings);
    expect(config.enabled).toBe(true);
    expect(config.workspace.enabled).toBe(true);
    expect(config.observeAfterTokens).toBe(10_000);
    expect(config.fallbackModels).toEqual([]);
    expect(warning).toContain('entire configuration uses defaults');
    expect(warning).toContain('even if you configured it as disabled');
    expect(warning).toContain('features.observationalMemory.fallbackModels[1].provider');
    expect(warning).not.toContain('private-model-value');
    expect(memoryConfigFrom(settings).enabled).toBe(true);
  });

  it('reports invalid enabled/workspace fields and multiple reasons without rejected values', () => {
    const { warning } = validateMemoryConfig({
      observationalMemory: {
        enabled: 'private-enabled-value',
        workspace: { enabled: 'private-workspace-value', shutdownTimeoutMs: -1 },
        model: {
          provider: 'private-provider',
          id: 'private-model',
          thinking: 'private-enum-value',
        },
      },
    });
    expect(warning).toContain('features.observationalMemory.enabled: expected boolean');
    expect(warning).toContain('features.observationalMemory.workspace.enabled: expected boolean');
    expect(warning).toContain(
      'features.observationalMemory.workspace.shutdownTimeoutMs: must be greater than 0',
    );
    expect(warning).toContain(
      'features.observationalMemory.model.thinking: expected a supported option',
    );
    expect(warning).not.toContain('private-');
  });

  it('warns about unknown keys at every schema object while preserving valid settings', () => {
    const result = validateMemoryConfig({
      observationalMemory: {
        enabled: false,
        observeAfterTokens: 123,
        legacy: 'secret-value',
        model: { provider: 'p', id: 'm', thinking: 'max', extra: 'secret-value' },
        fallbackModels: [{ provider: 'p', id: 'fallback', typo: 'secret-value' }],
        workspace: { enabled: false, other: 'secret-value' },
      },
    });
    expect(result.config.enabled).toBe(false);
    expect(result.config.workspace.enabled).toBe(false);
    expect(result.config.observeAfterTokens).toBe(123);
    expect(result.config.model?.thinking).toBe('xhigh');
    expect(result.config.fallbackModels).toEqual([{ provider: 'p', id: 'fallback' }]);
    expect(result.config).not.toHaveProperty('legacy');
    for (const field of [
      '["legacy"]',
      'model["extra"]',
      'fallbackModels[0]["typo"]',
      'workspace["other"]',
    ])
      expect(result.warning).toContain(field);
    expect(result.warning).toContain('valid settings remain in effect');
    expect(result.warning).not.toContain('secret-value');
  });

  it.each([[false], [[]], ['private-whole-object']])(
    'reports invalid whole-object input without its value: %j',
    (value) => {
      const result = validateMemoryConfig({ observationalMemory: value });
      expect(result.config.enabled).toBe(true);
      expect(result.warning).toContain('features.observationalMemory: expected object');
      expect(result.warning).not.toContain('private-whole-object');
    },
  );

  it('emits one startup warning, not on every turn, worker check or panel refresh', async () => {
    const agent = await startAgent({
      config: {
        features: {
          observationalMemory: {
            enabled: false,
            showWorkerNotifications: false,
            workspace: { enabled: false },
            fallbackModels: [{ provider: 'fake' }],
          },
        },
      },
      env: { PIRC_MEMORY_PASSIVE: 'true' },
    });
    agents.push(agent);
    await agent.send({ type: 'get_state' });
    expect(warnings(agent)).toHaveLength(1);
    expect(warnings(agent)[0]!.notifyType).toBe('warning');
    expect(warnings(agent)[0]!.message).toContain('fallbackModels[0].id');
    for (let i = 0; i < 2; i++) {
      const from = agent.events.length;
      await agent.send({ type: 'prompt', message: `configuration check ${i}` });
      await settledAfter(agent, from);
      await agent.send({ type: 'get_panel_state' });
      await agent.send({ type: 'prompt', message: '/om:status' });
    }
    expect(warnings(agent)).toHaveLength(1);
    expect(agent.events.some((event) => String(event.message).includes('Mode: passive'))).toBe(
      true,
    );
  });

  it('shows unknown-key warnings even when worker notifications and memory are disabled', async () => {
    const agent = await startAgent({
      config: {
        features: {
          observationalMemory: {
            enabled: false,
            showWorkerNotifications: false,
            oldOption: 'private-value',
          },
        },
      },
    });
    agents.push(agent);
    await agent.send({ type: 'get_state' });
    expect(warnings(agent)).toHaveLength(1);
    expect(warnings(agent)[0]!.message).toContain('unknown field (ignored)');
    expect(warnings(agent)[0]!.message).not.toContain('private-value');
    await agent.send({ type: 'prompt', message: '/om:status' });
    expect(warnings(agent)).toHaveLength(1);
  });
});
