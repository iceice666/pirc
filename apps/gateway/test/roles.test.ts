import { describe, expect, it } from 'bun:test';
import { expandModels, parseRole } from '../src/agent/roles.js';

const providers = {
  openai: { models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
  azure: { models: [{ id: 'gpt-5' }, { id: 'o3' }] },
  anthropic: { models: [{ id: 'claude-sonnet' }] },
};

describe('role model patterns', () => {
  it('reads one pattern, a YAML list or a comma-separated string', () => {
    expect(parseRole('a', '---\nmodel: openai/gpt-5\n---\n').models).toEqual(['openai/gpt-5']);
    expect(parseRole('a', '---\nmodel:\n  - anthropic/*\n  - "*/gpt-5"\n---\n').models).toEqual([
      'anthropic/*',
      '*/gpt-5',
    ]);
    expect(parseRole('a', '---\nmodel: anthropic/*, */gpt-5\n---\n').models).toEqual([
      'anthropic/*',
      '*/gpt-5',
    ]);
    expect(() => parseRole('a', '---\nmodel: gpt-5\n---\n')).toThrow(/use provider\/model-id/);
    expect(() => parseRole('a', '---\nmodel: []\n---\n')).toThrow(/1–20/);
  });

  it('expands in pattern order, then catalog order, without duplicates', () => {
    expect(expandModels(['*/gpt-5'], providers)).toEqual([
      { provider: 'openai', id: 'gpt-5' },
      { provider: 'azure', id: 'gpt-5' },
    ]);
    expect(expandModels(['openai/*'], providers)).toEqual([
      { provider: 'openai', id: 'gpt-5' },
      { provider: 'openai', id: 'gpt-5-mini' },
    ]);
    expect(
      expandModels(['nope/x', 'anthropic/claude-sonnet', '*/gpt-5', 'openai/gpt-5*'], providers),
    ).toEqual([
      { provider: 'anthropic', id: 'claude-sonnet' },
      { provider: 'openai', id: 'gpt-5' },
      { provider: 'azure', id: 'gpt-5' },
      { provider: 'openai', id: 'gpt-5-mini' },
    ]);
    // Only * is special; dots and the rest match literally.
    expect(expandModels(['openai/gpt.5'], providers)).toEqual([]);
  });
});
