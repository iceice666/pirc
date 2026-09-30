import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ALLOWED_DOMAINS,
  DOMAIN_PATTERN,
  readAllowed,
  sandboxConfigSchema,
  sessionPolicy,
  writeAllowed,
} from '../src/sandbox-policy.js';
import { readAgentConfig, srtSettings } from '../src/node/sandbox.js';

function layout() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-policy-')));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const dirs = {
    root,
    home,
    state,
    session: path.join(state, 'sessions', 'pi_1'),
    memory: path.join(state, 'workspace-memory'),
    socket: path.join(state, 'i-abc', 'socket'),
    workspace: path.join(root, 'ws'),
    chat: path.join(state, 'chat', 'chats', 'sessions', 's1'),
    tmp: path.join(root, 'tmp'),
  };
  for (const dir of [
    dirs.session,
    dirs.memory,
    path.dirname(dirs.socket),
    dirs.workspace,
    dirs.chat,
    dirs.tmp,
  ])
    mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  mkdirSync(path.join(home, '.cache'), { recursive: true });
  return dirs;
}

const policyFor = (d: ReturnType<typeof layout>, workspaceRoot = d.workspace, config = {}) =>
  sessionPolicy({
    config: sandboxConfigSchema.parse(config),
    configDir: path.join(d.root, 'config'),
    home: d.home,
    privateDirs: [d.state],
    workspaceRoot,
    allowedPaths: [],
    sessionDir: d.session,
    workspaceMemoryDir: d.memory,
    inferenceSocket: d.socket,
    tmpDirs: [d.tmp],
  });

describe('session policy', () => {
  it('hides pirc state and credentials, but gives the session its own directories back', () => {
    const d = layout();
    const { paths, network } = policyFor(d);
    expect(readAllowed(paths, path.join(d.state, 'node.sqlite'))).toBe(false);
    expect(readAllowed(paths, path.join(d.state, 'sessions', 'pi_2', 'x.jsonl'))).toBe(false);
    expect(readAllowed(paths, path.join(d.session, 'session.jsonl'))).toBe(true);
    expect(readAllowed(paths, path.join(d.memory, 'k.jsonl'))).toBe(true);
    expect(readAllowed(paths, d.socket)).toBe(true);
    expect(readAllowed(paths, path.join(d.home, '.ssh', 'id_ed25519'))).toBe(false);
    expect(readAllowed(paths, path.join(d.home, 'notes.md'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.workspace, 'src', 'a.ts'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.workspace, '.pirc', 'config.json'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.home, '.cache', 'bun', 'x'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.home, '.bashrc'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.tmp, 'x'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.state, 'node.sqlite'))).toBe(false);
    expect(network.allowedDomains).toEqual(expect.arrayContaining(DEFAULT_ALLOWED_DOMAINS));
    expect(network.allowUnixSockets).toEqual([d.socket]);
  });

  it("lets a chat session work in its directory inside the node's state", () => {
    const d = layout();
    const { paths } = policyFor(d, d.chat);
    expect(readAllowed(paths, path.join(d.chat, 'notes.md'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.chat, 'notes.md'))).toBe(true);
    expect(readAllowed(paths, path.join(d.state, 'chat', 'chats', 'sessions', 's2', 'x'))).toBe(
      false,
    );
  });

  it("never lets a chat session read or write its project's instructions, even when configured writable", () => {
    const d = layout();
    const instructions = path.join(d.state, 'chat', 'chats', 'instructions.md');
    const { paths } = sessionPolicy({
      config: sandboxConfigSchema.parse({ filesystem: { allowWrite: [d.state] } }),
      configDir: path.join(d.root, 'config'),
      home: d.home,
      privateDirs: [d.state],
      workspaceRoot: d.chat,
      allowedPaths: [],
      sessionDir: d.session,
      workspaceMemoryDir: d.memory,
      tmpDirs: [d.tmp],
      protectedPaths: [instructions],
    });
    expect(readAllowed(paths, instructions)).toBe(false);
    expect(writeAllowed(paths, instructions)).toBe(false);
    expect(writeAllowed(paths, path.join(d.chat, 'notes.md'))).toBe(true);
  });

  it('keeps a deny inside an allowed region, and takes configured additions', () => {
    const d = layout();
    const { paths, network, allowGitConfig } = policyFor(d, d.workspace, {
      network: { defaultDomains: false, allowedDomains: ['api.example.com', '127.0.0.1:8080'] },
      filesystem: { denyRead: ['~/private'], allowWrite: ['~/out'], allowGitConfig: true },
    });
    expect(readAllowed(paths, path.join(d.home, 'private', 'x'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.home, 'out', 'x'))).toBe(true);
    expect(network.allowedDomains).toEqual(['api.example.com', '127.0.0.1:8080']);
    expect(allowGitConfig).toBe(true);
    // A workspace inside $HOME does not re-open credentials under it.
    const inHome = policyFor(d, d.home).paths;
    expect(readAllowed(inHome, path.join(d.home, '.ssh', 'id_ed25519'))).toBe(false);
  });

  it('renders srt settings for the platform', () => {
    const d = layout();
    const settings = srtSettings(policyFor(d), ['extra.example.com']);
    const network = settings.network as Record<string, unknown>;
    expect(settings.network.allowedDomains).toContain('extra.example.com');
    expect(settings.allowPty).toBe(true);
    if (process.platform === 'linux') expect(network.allowAllUnixSockets).toBe(true);
    else expect(network.allowUnixSockets).toEqual([d.socket]);
  });

  it('accepts hosts, wildcards, ports and IPv4 addresses only', () => {
    for (const ok of [
      'github.com',
      '*.github.com',
      'api.example.com:443',
      'localhost:3000',
      '127.0.0.1:8080',
    ])
      expect(DOMAIN_PATTERN.test(ok)).toBe(true);
    for (const bad of ['*', 'http://github.com', 'github.com/path', '*.com.', 'a b.com', ''])
      expect(DOMAIN_PATTERN.test(bad)).toBe(false);
  });
});

describe("the node's reading of the agent config", () => {
  it('keeps the defaults and reports a mistake instead of loosening anything', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pirc-policy-config-'));
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        allowedPaths: ['~/extra'],
        sandbox: { network: { allowedDomains: ['not a host'] } },
      }),
    );
    const view = readAgentConfig({ PIRC_CONFIG_DIR: dir });
    expect(view.problem).toContain('network.allowedDomains');
    expect(view.sandbox.network.defaultDomains).toBe(true);
    expect(view.sandbox.network.allowedDomains).toEqual([]);
    expect(view.allowedPaths[0]).toMatch(/extra$/);
  });
});
