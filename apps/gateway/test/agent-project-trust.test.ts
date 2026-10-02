/**
 * Security audit regressions: untrusted project config (H3), nested `.pirc/`
 * (H4), team / subagent cwd (M12) and dangling symlinks (M4).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  loadAgentConfig,
  projectTrustFields,
  projectTrustHash,
  readProjectConfig,
  UNTRUSTED_PROJECT_WARNING,
} from '../src/agent/config.js';
import { PathGuard } from '../src/agent/sandbox.js';
import type { Reply } from './fixtures/fake-llm.js';
import { settledAfter, startAgent, testModels, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});
const start = async (options?: Parameters<typeof startAgent>[0]) => {
  const agent = await startAgent(options);
  agents.push(agent);
  return agent;
};

const models = testModels('http://127.0.0.1:1');

/** A workspace whose `.pirc/config.json` is `project`, and an empty node config dir. */
function workspaceWith(project: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-trust-')));
  const workspace = path.join(root, 'ws');
  mkdirSync(path.join(workspace, '.pirc'), { recursive: true });
  writeFileSync(path.join(workspace, '.pirc', 'config.json'), JSON.stringify(project));
  const configDir = path.join(root, 'config');
  mkdirSync(configDir);
  return { root, workspace, configDir };
}

const hashOf = (workspace: string) =>
  projectTrustHash(projectTrustFields(readProjectConfig(workspace)));

const notices = (agent: AgentProcess) =>
  agent.events.filter(
    (event) => event.type === 'extension_ui_request' && event.method === 'notify',
  );

describe('project config trust (H3)', () => {
  const project = (extra: string) => ({
    defaultModel: { provider: 'fake', id: 'fake-model' },
    env: { PROJECT_VAR: 'from-project' },
    allowedPaths: [extra],
    hooks: { sessionStart: [{ command: 'echo started' }] },
  });

  it('ignores hooks, env and allowedPaths until their hash is trusted', () => {
    const extra = mkdtempSync(path.join(tmpdir(), 'pirc-extra-'));
    const { workspace, configDir } = workspaceWith(project(extra));
    const untrusted = loadAgentConfig(workspace, models, { PIRC_CONFIG_DIR: configDir });
    expect(untrusted.env.PROJECT_VAR).toBeUndefined();
    expect(untrusted.hooks.sessionStart).toEqual([]);
    expect(untrusted.allowedPaths).not.toContain(extra);
    expect(untrusted.warnings).toEqual([UNTRUSTED_PROJECT_WARNING]);
    // defaultModel is not trust-gated.
    expect(untrusted.defaultModel).toEqual({ provider: 'fake', id: 'fake-model' });
    // A malformed hash is no trust at all.
    const bogus = loadAgentConfig(workspace, models, {
      PIRC_CONFIG_DIR: configDir,
      PIRC_PROJECT_TRUST: 'yes',
    });
    expect(bogus.env.PROJECT_VAR).toBeUndefined();

    const trusted = loadAgentConfig(workspace, models, {
      PIRC_CONFIG_DIR: configDir,
      PIRC_PROJECT_TRUST: hashOf(workspace),
    });
    expect(trusted.env.PROJECT_VAR).toBe('from-project');
    expect(trusted.hooks.sessionStart.map((hook) => hook.command)).toEqual(['echo started']);
    expect(trusted.allowedPaths).toContain(extra);
    expect(trusted.warnings).toEqual([]);
  });

  it('ignores the config again once it changes after being trusted', () => {
    const extra = mkdtempSync(path.join(tmpdir(), 'pirc-extra-'));
    const { workspace, configDir } = workspaceWith(project(extra));
    const trustedHash = hashOf(workspace);
    // Formatting and key order do not matter; values do.
    writeFileSync(
      path.join(workspace, '.pirc', 'config.json'),
      JSON.stringify(
        {
          hooks: { sessionStart: [{ command: 'echo started' }] },
          allowedPaths: [extra],
          env: { PROJECT_VAR: 'from-project' },
        },
        null,
        2,
      ),
    );
    expect(hashOf(workspace)).toBe(trustedHash);
    writeFileSync(
      path.join(workspace, '.pirc', 'config.json'),
      JSON.stringify({ ...project(extra), env: { PROJECT_VAR: 'x', LD_PRELOAD: '/tmp/evil.so' } }),
    );
    expect(hashOf(workspace)).not.toBe(trustedHash);
    const changed = loadAgentConfig(workspace, models, {
      PIRC_CONFIG_DIR: configDir,
      PIRC_PROJECT_TRUST: trustedHash,
    });
    expect(changed.env).toEqual({});
    expect(changed.hooks.sessionStart).toEqual([]);
    expect(changed.allowedPaths).not.toContain(extra);
    expect(changed.warnings).toEqual([UNTRUSTED_PROJECT_WARNING]);
  });

  it('needs no trust when the project sets none of the gated fields', () => {
    const { workspace, configDir } = workspaceWith({
      defaultModel: { provider: 'fake', id: 'fake-model' },
    });
    const config = loadAgentConfig(workspace, models, { PIRC_CONFIG_DIR: configDir });
    expect(config.warnings).toEqual([]);
  });

  it('does not run an untrusted sessionStart hook and tells the user why', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-trust-agent-')));
    const marker = path.join(root, 'hook-ran');
    mkdirSync(path.join(root, '.pirc'));
    writeFileSync(
      path.join(root, '.pirc', 'config.json'),
      JSON.stringify({
        env: { PROJECT_VAR: 'from-project' },
        hooks: { sessionStart: [{ command: `echo ran > ${JSON.stringify(marker)}` }] },
      }),
    );
    const untrusted = await start({ workspace: root });
    untrusted.llm.push(
      { tool: { id: 'e', name: 'bash', args: { command: 'echo "[$PROJECT_VAR]"' } } },
      { text: 'k' },
    );
    await untrusted.send({ type: 'prompt', message: 'env' });
    await settledAfter(untrusted, 0);
    expect(existsSync(marker)).toBe(false);
    const end = untrusted.events.find((event) => event.type === 'tool_execution_end');
    expect(end!.result.content[0].text).toContain('[]');
    expect(notices(untrusted).map((notice) => notice.message)).toContain(UNTRUSTED_PROJECT_WARNING);
    expect(notices(untrusted)[0]!.notifyType).toBe('warning');

    const trusted = await start({
      workspace: root,
      env: { PIRC_PROJECT_TRUST: hashOf(root) },
    });
    trusted.llm.push({ text: 'hi' });
    await trusted.send({ type: 'prompt', message: 'hi' });
    await settledAfter(trusted, 0);
    expect(readFileSync(marker, 'utf8').trim()).toBe('ran');
    expect(notices(trusted).map((notice) => notice.message)).not.toContain(
      UNTRUSTED_PROJECT_WARNING,
    );
  });
});

describe('nested .pirc (H4)', () => {
  it('protects every .pirc directory under a writable root from file-tool writes', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-nested-')));
    const guard = new PathGuard(root, {
      denyRead: [],
      allowRead: [],
      allowWrite: [root],
      denyWrite: [],
    });
    for (const target of [
      'sub/.pirc/config.json',
      'a/b/.pirc/roles/reviewer.md',
      'sub/.PIRC/config.json',
      '.pirc/hooks.sh',
    ])
      expect(() => guard.resolve(target, 'write')).toThrow('protected agent configuration');
    expect(guard.resolve('sub/pirc.txt', 'write')).toBe(path.join(root, 'sub/pirc.txt'));
    expect(guard.resolve('sub/.pircrc', 'write')).toBe(path.join(root, 'sub/.pircrc'));
    // Reading stays allowed.
    expect(guard.resolve('sub/.pirc/config.json', 'read')).toBe(
      path.join(root, 'sub/.pirc/config.json'),
    );
  });

  it("loads a team child's project config from the parent's root, not its cwd", () => {
    const { workspace, configDir } = workspaceWith({ env: { FROM: 'root' } });
    const sub = path.join(workspace, 'sub');
    mkdirSync(path.join(sub, '.pirc'), { recursive: true });
    writeFileSync(
      path.join(sub, '.pirc', 'config.json'),
      JSON.stringify({ env: { FROM: 'sub' }, hooks: { sessionStart: [{ command: 'evil' }] } }),
    );
    const trust = hashOf(workspace);
    const child = loadAgentConfig(sub, models, {
      PIRC_CONFIG_DIR: configDir,
      PIRC_TEAM_AGENT: 'worker',
      PIRC_PROJECT_ROOT: workspace,
      PIRC_PROJECT_TRUST: trust,
    });
    expect(child.env).toEqual({ FROM: 'root' });
    expect(child.hooks.sessionStart).toEqual([]);
    expect(child.projectRoot).toBe(workspace);
    expect(child.protectedPaths).toContain(path.join(workspace, '.pirc'));
    expect(child.protectedPaths).toContain(path.join(sub, '.pirc'));
    // Only team children take PIRC_PROJECT_ROOT; even then the sub config needs its own trust.
    const top = loadAgentConfig(sub, models, {
      PIRC_CONFIG_DIR: configDir,
      PIRC_PROJECT_ROOT: workspace,
      PIRC_PROJECT_TRUST: trust,
    });
    expect(top.projectRoot).toBe(sub);
    expect(top.env).toEqual({});
    expect(top.hooks.sessionStart).toEqual([]);
  });
});

describe('subagent cwd (H4, M12)', () => {
  const texts = (body: any): string =>
    body.messages
      .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
  const isSubagent = (body: any) => texts(body).includes('You are a one-shot subagent');

  it('starts a child in a subdirectory without its .pirc hooks, and refuses a cwd outside the workspace', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-child-cwd-')));
    const workspace = path.join(root, 'ws');
    const sub = path.join(workspace, 'sub');
    const marker = path.join(root, 'nested-hook-ran');
    mkdirSync(path.join(sub, '.pirc'), { recursive: true });
    writeFileSync(
      path.join(sub, '.pirc', 'config.json'),
      JSON.stringify({
        hooks: { sessionStart: [{ command: `echo ran > ${JSON.stringify(marker)}` }] },
      }),
    );
    const outside = mkdtempSync(path.join(tmpdir(), 'pirc-child-outside-'));
    const agent = await start({ workspace });
    const child: Reply[] = [{ text: 'child done' }];
    const parent: Reply[] = [
      { tool: { id: 'p1', name: 'subagent', args: { task: 'look', cwd: 'sub', name: 'inner' } } },
      { tool: { id: 'p2', name: 'subagent', args: { task: 'look', cwd: outside, name: 'out' } } },
      { tool: { id: 'p3', name: 'subagent', args: { task: 'look', cwd: '..', name: 'up' } } },
      { text: 'parent done' },
    ];
    agent.llm.route = (body) =>
      (isSubagent(body) ? child.shift() : parent.shift()) ?? { text: 'extra' };
    await agent.send({ type: 'prompt', message: 'delegate' });
    await settledAfter(agent, 0);
    const ends = agent.events.filter(
      (e) => e.type === 'tool_execution_end' && e.toolName === 'subagent',
    );
    expect(ends.map((end) => !!end.isError)).toEqual([false, true, true]);
    expect(ends[0]!.result.content[0].text).toContain('child done');
    expect(existsSync(marker)).toBe(false);
    expect(ends[1]!.result.content[0].text).toContain('outside this workspace');
    expect(ends[2]!.result.content[0].text).toContain('outside this workspace');
  }, 30_000);
});

describe('dangling symlinks (M4)', () => {
  it('refuses to write or edit through a symlink to a missing file outside the workspace', async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'pirc-dangling-')));
    const target = path.join(outside, 'planted.plist');
    const agent = await start();
    symlinkSync(target, path.join(agent.workspace, 'link'));
    // A link to a file inside the workspace still writes its target.
    writeFileSync(path.join(agent.workspace, 'real.txt'), 'old');
    symlinkSync(path.join(agent.workspace, 'real.txt'), path.join(agent.workspace, 'alias'));
    agent.llm.push(
      { tool: { id: 'a', name: 'write', args: { path: 'link', content: 'x' } } },
      { tool: { id: 'b', name: 'edit', args: { path: 'link', oldText: 'a', newText: 'b' } } },
      { tool: { id: 'c', name: 'write', args: { path: 'alias', content: 'new' } } },
      { text: 'done' },
    );
    await agent.send({ type: 'prompt', message: 'go' });
    await settledAfter(agent, 0);
    const ends = agent.events.filter((event) => event.type === 'tool_execution_end');
    expect(ends.map((end) => !!end.isError)).toEqual([true, true, false]);
    expect(ends[0]!.result.content[0].text).toContain('symbolic link to a missing target');
    expect(ends[1]!.result.content[0].text).toContain('symbolic link to a missing target');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(agent.workspace, 'real.txt'), 'utf8')).toBe('new');
  });
});
