import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { TOOL_PROMPT_NAMES, toolPrompt } from '../src/agent/prompts/tools.js';

const DIR = path.resolve(import.meta.dir, '../src/agent/prompts/tools');

describe('tool descriptions', () => {
  it('registers every description file, and nothing else', () => {
    const files = readdirSync(DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -3));
    expect([...TOOL_PROMPT_NAMES].sort()).toEqual(files.sort());
  });

  it('fills values and keeps flagged text only when the flag is on', () => {
    const today = toolPrompt('web_search', { today: '2026-10-02' });
    expect(today).toContain('(today is 2026-10-02)');
    expect(today).not.toContain('{{');

    const all = toolPrompt('memory_search', { recall: true, delegation: true });
    expect(all).toEndWith(
      "are marked. Open a note's sources with recall (12-hex ids). See a delegation with delegation_status.",
    );
    const none = toolPrompt('memory_search', { recall: false, delegation: false });
    expect(none).toEndWith('superseded ones are marked.');
    expect(toolPrompt('memory_search', { recall: false, delegation: true })).toEndWith(
      'are marked. See a delegation with delegation_status.',
    );
    expect(toolPrompt('recall', { chatSearch: false })).toContain(
      'from an earlier session. Use when',
    );
  });

  it('refuses a missing value, a flag for text, and an unknown tool', () => {
    expect(() => toolPrompt('web_search')).toThrow('no value for {{today}}');
    expect(() => toolPrompt('web_search', { today: true })).toThrow('needs text');
    expect(() => toolPrompt('memory_search', { recall: true })).toThrow(
      'no value for {{delegation}}',
    );
    expect(() => toolPrompt('nope')).toThrow('No description for tool nope');
  });

  it('leaves no placeholder in a description without values', () => {
    for (const name of TOOL_PROMPT_NAMES) {
      let text: string;
      try {
        text = toolPrompt(name);
      } catch {
        continue; // takes values: covered above and by the agent tests
      }
      expect(text).not.toMatch(/\{\{|\}\}/);
      expect(text).toBe(text.trim());
    }
  });
});
