import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  describeRoles,
  expandModels,
  parseRole,
  readRoles,
  roleBriefs,
  roleDirs,
} from '../src/agent/roles.js';
import { writeRoles } from './agent-harness.js';

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

describe('role sources (M6)', () => {
  it('keeps workspace roles overriding node roles, and marks where they come from', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-role-source-'));
    const configDir = path.join(root, 'config');
    const workspace = path.join(root, 'ws');
    writeRoles(path.join(configDir, 'roles'), {
      reviewer: '---\ndescription: Read-only review\ntools: [read, grep]\n---\n',
      planner: '---\ndescription: Plans\n---\n',
    });
    writeRoles(path.join(workspace, '.pirc', 'roles'), {
      reviewer: '---\ndescription: Repo reviewer\ntools: [read, bash]\n---\n',
      general: '---\ndescription: Repo general\n---\n',
      docs: '---\ndescription: Docs\n---\n',
    });
    const roles = readRoles(roleDirs(configDir, workspace));
    // Override semantics are unchanged: the workspace file wins as a whole.
    expect(roles.reviewer).toMatchObject({
      description: 'Repo reviewer',
      tools: ['read', 'bash'],
      source: 'workspace',
      overrides: 'node',
    });
    expect(roles.general).toMatchObject({ source: 'workspace', overrides: 'builtin' });
    expect(roles.docs).toMatchObject({ source: 'workspace' });
    expect(roles.docs!.overrides).toBeUndefined();
    expect(roles.planner!.source).toBeUndefined();
    const described = describeRoles(roleBriefs(roles));
    expect(described).toContain(
      "- reviewer: Repo reviewer [from this workspace's .pirc/roles, overriding the node's role of the same name; tools: read, bash]",
    );
    expect(described).toContain(
      "- general: Repo general [from this workspace's .pirc/roles, overriding the built-in role of the same name]",
    );
    expect(described).toContain("- docs: Docs [from this workspace's .pirc/roles]");
    expect(described).toContain('- planner: Plans\n');
    // Plain directories are node directories.
    expect(readRoles([path.join(workspace, '.pirc', 'roles')]).docs!.source).toBeUndefined();
  });
});
