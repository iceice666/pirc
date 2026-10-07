import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { PathGuard } from '../src/agent/sandbox.js';

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
    expect(writeAllowed(paths, path.join(d.workspace, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.workspace, '.git', 'config'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.workspace, '.git', 'index'))).toBe(true);
    expect(
      writeAllowed(
        policyFor(d, d.workspace, { filesystem: { allowGitConfig: true } }).paths,
        path.join(d.workspace, '.git', 'config'),
      ),
    ).toBe(true);
    expect(writeAllowed(paths, path.join(d.home, '.cache', 'bun', 'x'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.home, '.bashrc'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.tmp, 'x'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.state, 'node.sqlite'))).toBe(false);
    // Temp dirs and build caches are shared by every session: no write lease.
    expect(paths.sharedWrite).toEqual([d.tmp, path.join(d.home, '.cache')]);
    expect(paths.sharedWrite).not.toContain(d.workspace);
    expect(network.allowedDomains).toEqual(expect.arrayContaining(DEFAULT_ALLOWED_DOMAINS));
    expect(network.allowUnixSockets).toEqual([d.socket]);
  });

  it('takes no write lease for shared roots, the innermost root otherwise', () => {
    const d = layout();
    const guard = new PathGuard(d.workspace, policyFor(d).paths);
    expect(guard.leaseRoot(path.join(d.tmp, 'x', 'y'))).toBeUndefined();
    expect(guard.leaseRoot(path.join(d.home, '.cache', 'bun', 'x'))).toBeUndefined();
    expect(guard.leaseRoot(path.join(d.workspace, 'src', 'a.ts'))).toBe(d.workspace);
    // A workspace inside a shared root is still leased.
    const nested = path.join(d.tmp, 'ws');
    mkdirSync(nested);
    const inTmp = new PathGuard(nested, policyFor(d, nested).paths);
    expect(inTmp.leaseRoot(path.join(nested, 'a.ts'))).toBe(nested);
    expect(inTmp.leaseRoot(path.join(d.tmp, 'other'))).toBeUndefined();
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

  it('protects global prompt configuration inside writable roots, including absent files', () => {
    const d = layout();
    const configDir = path.join(d.tmp, 'config');
    mkdirSync(configDir);
    const { paths } = sessionPolicy({
      config: sandboxConfigSchema.parse({}),
      configDir,
      home: d.home,
      privateDirs: [d.state],
      workspaceRoot: d.workspace,
      allowedPaths: [d.root],
      sessionDir: d.session,
      workspaceMemoryDir: d.memory,
      tmpDirs: [d.tmp],
    });
    for (const name of ['SOUL.md', 'CHAT.md', 'config.json']) {
      expect(readAllowed(paths, path.join(configDir, name))).toBe(true);
      expect(writeAllowed(paths, path.join(configDir, name))).toBe(false);
    }
    expect(writeAllowed(paths, path.join(d.tmp, 'ordinary.txt'))).toBe(true);
  });

  it('protects the prospective targets of dangling managed prompt symlinks', () => {
    const d = layout();
    const configDir = path.join(d.tmp, 'config');
    mkdirSync(configDir);
    for (const name of ['SOUL.md', 'CHAT.md'])
      symlinkSync(path.join(d.workspace, name), path.join(configDir, name));
    const { paths } = sessionPolicy({
      config: sandboxConfigSchema.parse({}),
      configDir,
      home: d.home,
      privateDirs: [d.state],
      workspaceRoot: d.workspace,
      allowedPaths: [],
      sessionDir: d.session,
      workspaceMemoryDir: d.memory,
      tmpDirs: [d.tmp],
    });
    for (const name of ['SOUL.md', 'CHAT.md'])
      expect(writeAllowed(paths, path.join(d.workspace, name))).toBe(false);
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

  it("keeps the node's state and credentials unwritable even inside a writable root", () => {
    const d = layout();
    // Development layout: the node's state lives inside the workspace.
    const workspace = d.root;
    writeFileSync(path.join(d.state, 'node.sqlite'), '');
    mkdirSync(path.join(d.state, 'sandbox', 'bin'), { recursive: true });
    // Only what exists now: the node warns that later entries are open
    // (node/sandbox.ts) and refuses to register such workspaces (node/app.ts).
    mkdirSync(path.join(d.state, 'sessions', 'pi_2'), { recursive: true });
    const { paths } = sessionPolicy({
      config: sandboxConfigSchema.parse({}),
      configDir: path.join(d.root, 'config'),
      home: d.home,
      privateDirs: [d.state],
      workspaceRoot: workspace,
      allowedPaths: [d.home],
      sessionDir: d.session,
      workspaceMemoryDir: d.memory,
      tmpDirs: [d.tmp],
      readOnlyDirs: [path.join(d.state, 'sandbox', 'bin')],
    });
    expect(writeAllowed(paths, path.join(workspace, 'src', 'a.ts'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.state, 'node.sqlite'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.state, 'sessions', 'pi_2', 'x.jsonl'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.session, 'session.jsonl'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.memory, 'k.jsonl'))).toBe(true);
    expect(writeAllowed(paths, path.join(d.state, 'sandbox', 'bin', 'apply-seccomp'))).toBe(false);
    expect(readAllowed(paths, path.join(d.state, 'sandbox', 'bin', 'apply-seccomp'))).toBe(true);
    expect(readAllowed(paths, path.join(d.state, 'sandbox', 'other.json'))).toBe(false);
    // `~` in allowedPaths does not open credential stores.
    expect(writeAllowed(paths, path.join(d.home, '.ssh', 'authorized_keys'))).toBe(false);
    expect(writeAllowed(paths, path.join(d.home, 'notes.md'))).toBe(true);
  });

  it('hides host sockets from Linux sandboxes, where Unix sockets cannot be filtered by path', () => {
    const d = layout();
    const agentSocket = path.join(d.root, 'ssh-agent.sock');
    writeFileSync(agentSocket, '');
    const input = {
      config: sandboxConfigSchema.parse({}),
      configDir: path.join(d.root, 'config'),
      home: d.home,
      privateDirs: [d.state],
      workspaceRoot: d.workspace,
      allowedPaths: [],
      sessionDir: d.session,
      workspaceMemoryDir: d.memory,
      tmpDirs: [d.tmp],
      sshAuthSock: agentSocket,
      uid: 1000,
    };
    const linux = sessionPolicy({ ...input, platform: 'linux' }).paths;
    expect(readAllowed(linux, agentSocket)).toBe(false);
    const mac = sessionPolicy({ ...input, platform: 'darwin' }).paths;
    expect(readAllowed(mac, agentSocket)).toBe(true);
  });

  it('renders srt settings for the platform', () => {
    const d = layout();
    const settings = srtSettings(policyFor(d), ['extra.example.com']);
    const network = settings.network as Record<string, unknown>;
    expect(settings.network.allowedDomains).toContain('extra.example.com');
    expect(settings.allowPty).toBe(true);
    if (process.platform === 'linux') expect(network.allowAllUnixSockets).toBe(true);
    else expect(network.allowUnixSockets).toEqual([d.socket]);
    expect('seccomp' in settings).toBe(false);
    // The built-in srt is told where its seccomp helper is.
    expect(srtSettings(policyFor(d), [], '/x/apply-seccomp').seccomp).toEqual({
      applyPath: '/x/apply-seccomp',
    });
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

  it('drops the removed sandbox.enabled switch and says so when it was off', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pirc-policy-config-'));
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        sandbox: { enabled: false, network: { allowedDomains: ['api.example.com'] } },
      }),
    );
    const view = readAgentConfig({ PIRC_CONFIG_DIR: dir });
    expect(view.problem).toContain('sandbox.enabled');
    expect(view.sandbox.network.allowedDomains).toEqual(['api.example.com']);
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sandbox: { enabled: true } }));
    expect(readAgentConfig({ PIRC_CONFIG_DIR: dir }).problem).toBeUndefined();
  });
});
