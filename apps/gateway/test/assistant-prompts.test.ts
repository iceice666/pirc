import { afterEach, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectAssistantPrompt, writeAssistantPrompt } from '../src/assistant-prompts.js';
import { joinPrompt } from '../src/agent/context.js';
import { loadAgentConfig } from '../src/agent/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-prompts-'));
  dirs.push(dir);
  return dir;
}
it('round-trips regular files, normalizes, caps, deletes and protects managed links', () => {
  const dir = setup();
  expect(inspectAssistantPrompt(dir, 'soul')).toMatchObject({
    text: '',
    writable: true,
    maxChars: 8000,
  });
  expect(writeAssistantPrompt(dir, 'soul', '  Persona\r\nline  ').text).toBe('Persona\nline');
  const file = path.join(dir, 'SOUL.md');
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(() => writeAssistantPrompt(dir, 'soul', 'x'.repeat(8001))).toThrow('8000');
  expect(readFileSync(file, 'utf8')).toBe('Persona\nline\n');
  writeAssistantPrompt(dir, 'soul', '');
  expect(existsSync(file)).toBe(false);
  const target = path.join(dir, 'managed');
  writeFileSync(target, 'Managed');
  symlinkSync(target, file);
  expect(inspectAssistantPrompt(dir, 'soul')).toMatchObject({
    text: 'Managed',
    writable: false,
    reason: 'symlink',
  });
  expect(() => writeAssistantPrompt(dir, 'soul', '')).toThrow('read-only');
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('Managed');
});
it.skipIf(process.getuid?.() === 0)('checks directory and file permissions on each request', () => {
  const dir = setup();
  writeAssistantPrompt(dir, 'chat', 'Rules');
  chmodSync(dir, 0o500);
  try {
    expect(inspectAssistantPrompt(dir, 'chat')).toMatchObject({
      writable: false,
      reason: 'permission',
    });
    expect(() => writeAssistantPrompt(dir, 'chat', 'new')).toThrow('read-only');
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(inspectAssistantPrompt(dir, 'chat').writable).toBe(true);
  chmodSync(path.join(dir, 'CHAT.md'), 0o400);
  expect(inspectAssistantPrompt(dir, 'chat').writable).toBe(false);
});
it('separates chat rules and persona from all coding AGENTS files', () => {
  const dir = setup();
  const workspace = path.join(dir, 'work');
  mkdirSync(path.join(workspace, '.pirc'), { recursive: true });
  writeFileSync(path.join(dir, 'SOUL.md'), 'Unique persona');
  writeFileSync(path.join(dir, 'CHAT.md'), 'Unique chat rules');
  for (const root of [dir, workspace, path.join(workspace, '.pirc')])
    writeFileSync(path.join(root, 'AGENTS.md'), `Coding rules ${root}`);
  const env = { PIRC_CONFIG_DIR: dir, PIRC_WORKSPACE_KIND: 'chat' };
  const chat = loadAgentConfig(workspace, { providers: {} }, env);
  expect(joinPrompt(chat.systemPrompt)).toMatch(/^Unique persona\n\nThis chat/);
  expect(joinPrompt(chat.systemPrompt).endsWith('Unique chat rules')).toBe(true);
  expect(joinPrompt(chat.systemPrompt)).not.toContain('Coding rules');
  expect(chat.protectedPaths).toContain(path.join(dir, 'SOUL.md'));
  const work = loadAgentConfig(
    workspace,
    { providers: {} },
    { ...env, PIRC_WORKSPACE_KIND: 'directory' },
  );
  expect(joinPrompt(work.systemPrompt).match(/Coding rules/g)).toHaveLength(3);
  expect(joinPrompt(work.systemPrompt)).not.toContain('Unique');
  rmSync(path.join(dir, 'SOUL.md'));
  expect(joinPrompt(loadAgentConfig(workspace, { providers: {} }, env).systemPrompt)).toContain(
    "the user's personal assistant",
  );
  writeFileSync(path.join(dir, 'SOUL.md'), 'x'.repeat(9000));
  expect(
    joinPrompt(loadAgentConfig(workspace, { providers: {} }, env).systemPrompt).startsWith(
      'x'.repeat(8000) + '\n\n',
    ),
  ).toBe(true);
});
