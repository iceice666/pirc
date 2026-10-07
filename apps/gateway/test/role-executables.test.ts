import { version } from '../../../package.json';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { defaultAgentCommand, loadNodeConfig } from '../src/config.js';
import { selfCommand, setExecutableRole, type ExecutableRole } from '../src/self.js';
import { workerLogin, workerRefresh } from '../src/backends/oauth-worker.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';
import type { Reply } from './fixtures/fake-llm.js';
import { GatewayDatabase } from '../src/database.js';
import { buildNodeApp } from '../src/node/app.js';
import { testConfig } from './helpers.js';

const roles = ['gateway', 'chat', 'node'] as const;
const gatewayDir = path.resolve(import.meta.dir, '..');
const entry = (role: ExecutableRole) => path.join(gatewayDir, 'src', 'entry', `${role}.ts`);
// Normal tests never compile executables. CI can point this at independently built artifacts.
const defaultExecutableDir = path.join(gatewayDir, 'dist');
const executableDir = path.resolve(process.env.PIRC_ROLE_EXECUTABLE_DIR ?? defaultExecutableDir);
const testCompiled = process.env.PIRC_TEST_COMPILED_ROLES === '1';
const executable = (role: ExecutableRole) => path.join(executableDir, `pirc-${role}`);
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(PIRC_|PI_CODING_AGENT_)/.test(name)),
  );
const roots: string[] = [];
const agents: AgentProcess[] = [];
const temporaryDirectory = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-role-test-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setExecutableRole('node');
});

async function runCli(command: string[], args: string[], stdin?: string) {
  const proc = Bun.spawn([...command, ...args], {
    cwd: gatewayDir,
    env: cleanEnv(),
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    proc.kill('SIGKILL');
  }
}

function cliContract(role: ExecutableRole, command: string[]) {
  for (const flag of ['version', '--version']) {
    it(`prints the version with ${flag}`, async () => {
      const result = await runCli(command, [flag]);
      expect(result).toEqual({ code: 0, stdout: version + '\n', stderr: '' });
    });
  }
  for (const flag of ['help', '--help', '-h']) {
    it(`prints role-specific help with ${flag}`, async () => {
      const result = await runCli(command, [flag]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Usage: pirc-${role}`);
      expect(result.stdout).toContain('with no arguments');
      expect(result.stdout).not.toContain('oauth-worker');
      expect(result.stdout).not.toContain('ptc-worker');
      expect(result.stdout).not.toContain('ptc-guest');
    });
  }
  const invalid = [
    'gateway',
    'chat',
    'node',
    'unknown',
    ...(role === 'gateway' ? ['agent', 'ptc-guest', 'ptc-worker', 'srt'] : ['oauth-worker']),
  ];
  for (const argument of invalid) {
    it(`rejects ${argument} rather than dispatching another role`, async () => {
      const result = await runCli(command, [argument]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`Unknown command: ${argument}`);
      expect(result.stderr).toContain(`Usage: pirc-${role}`);
    });
  }
  it('starts its fixed service with no arguments', async () => {
    // Missing required configuration must reach the role runtime, not CLI usage or a dispatcher.
    const result = await runCli(command, []);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('Usage:');
    expect(result.stderr).not.toContain('Unknown command:');
    expect(result.stderr).toContain(
      role === 'gateway' ? 'The gateway requires PIRC_NODE_TOKENS' : 'Invalid PIRC_NODE_ID',
    );
  });
  if (role === 'gateway') {
    it('runs its private OAuth worker with a JSONL protocol and no network', async () => {
      const result = await runCli(
        command,
        ['oauth-worker'],
        `${JSON.stringify({ providerId: 'pirc-test-nonexistent-provider' })}\n`,
      );
      expect(result).toEqual({ code: 0, stdout: '{"type":"error"}\n', stderr: '' });
    });
  } else {
    it('accepts the agent command and reaches agent argument validation', async () => {
      const result = await runCli(command, ['agent']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--session-dir is required');
      expect(result.stderr).not.toContain('Unknown command:');
    });
    it('carries its own srt for the agent sandbox', async () => {
      const result = await runCli(command, ['srt', '--version']);
      expect(result).toEqual({ code: 0, stdout: '0.0.78\n', stderr: '' });
    });
    it('accepts the private ptc-guest command but requires an agent IPC channel', async () => {
      const result = await runCli(command, ['ptc-guest']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('ptc-guest must be started by a pirc agent');
      expect(result.stderr).not.toContain('Unknown command:');
    });
    it('no longer accepts the retired Bun ptc-worker command', async () => {
      const result = await runCli(command, ['ptc-worker']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Unknown command: ptc-worker');
    });
  }
}

for (const role of roles) {
  describe(`pirc-${role} source entry`, () => cliContract(role, [process.execPath, entry(role)]));
  describe.skipIf(!testCompiled)(`pirc-${role} compiled entry`, () =>
    cliContract(role, [executable(role)]),
  );
}

describe.skipIf(!testCompiled)('compiled artifact contract', () => {
  it('requires every role binary when compiled verification is requested', () => {
    for (const role of roles) expect(existsSync(executable(role))).toBe(true);
  });
  it.skipIf(executableDir !== defaultExecutableDir)(
    'removes the legacy dispatcher artifacts',
    () => {
      expect(existsSync(path.join(defaultExecutableDir, 'pirc'))).toBe(false);
      expect(existsSync(path.join(defaultExecutableDir, 'pirc.map'))).toBe(false);
    },
  );
});

describe('fixed-role configuration and subprocess commands', () => {
  const nodeEnvironment = (): NodeJS.ProcessEnv => ({
    PIRC_NODE_ID: 'test-node',
    PIRC_NODE_TOKEN: 'x'.repeat(32),
    PIRC_DAEMON_URL: 'ws://127.0.0.1:8787',
    PIRC_ALLOWED_USERS: 'test-user',
    PIRC_STATE_DIR: temporaryDirectory(),
    PIRC_BROWSER: 'false',
  });

  it('defaults test subprocesses to the node source entry', () => {
    expect(selfCommand()).toEqual([process.execPath, entry('node')]);
    expect(defaultAgentCommand({})).toEqual({
      agentCommand: process.execPath,
      agentArgs: [entry('node'), 'agent'],
    });
  });
  for (const role of roles) {
    it(`selects the ${role} source entry explicitly and after role initialization`, () => {
      expect(selfCommand(role)).toEqual([process.execPath, entry(role)]);
      setExecutableRole(role);
      expect(selfCommand()).toEqual([process.execPath, entry(role)]);
    });
  }
  for (const role of ['chat', 'node'] as const) {
    it(`fixes config.chat and the agent command from the ${role} executable role`, () => {
      const config = loadNodeConfig(nodeEnvironment(), role);
      expect(config.chat).toBe(role === 'chat');
      expect(config.agentCommand).toBe(process.execPath);
      expect(config.agentArgs).toEqual([entry(role), 'agent']);
      expect(defaultAgentCommand({}, role).agentArgs).toEqual([entry(role), 'agent']);
    });
    for (const value of ['', '0', '1', 'false', 'true']) {
      it(`rejects legacy PIRC_CHAT=${JSON.stringify(value)} for ${role}`, () => {
        expect(() => loadNodeConfig({ PIRC_CHAT: value }, role)).toThrow('PIRC_CHAT was removed');
      });
    }
  }
  it('defaults loadNodeConfig to the node role even in a chat-initialized process', () => {
    setExecutableRole('chat');
    const config = loadNodeConfig(nodeEnvironment());
    expect(config.chat).toBe(false);
    expect(config.agentArgs).toEqual([entry('node'), 'agent']);
  });
  it('rejects project workspaces for chat but retains them on a project node', () => {
    const env = nodeEnvironment();
    env.PIRC_WORKSPACES = JSON.stringify([{ id: 'project', path: env.PIRC_STATE_DIR }]);
    expect(() => loadNodeConfig(env, 'chat')).toThrow('PIRC_WORKSPACES must be empty');
    expect(loadNodeConfig(env, 'node').workspaces[0]?.id).toBe('project');
  });
  it('retains an explicit external agent command override', () => {
    expect(
      defaultAgentCommand(
        { PIRC_AGENT_COMMAND: 'external-agent', PIRC_AGENT_ARGS: '["rpc"]' },
        'chat',
      ),
    ).toEqual({ agentCommand: 'external-agent', agentArgs: ['rpc'] });
  });
  it('spawns the gateway source OAuth worker even when the caller defaults to node', async () => {
    const callbacks = {
      signal: AbortSignal.timeout(5000),
      onAuth: () => {
        throw new Error('An unknown provider must not initiate authentication');
      },
      onPrompt: async () => {
        throw new Error('An unknown provider must not prompt');
      },
    };
    await expect(workerLogin('pirc-test-nonexistent-provider', callbacks)).rejects.toThrow(
      'OAuth provider failed',
    );
    await expect(
      workerRefresh(
        'pirc-test-nonexistent-provider',
        { access: 'test', refresh: 'test', expires: 0 },
        callbacks.signal,
      ),
    ).rejects.toThrow('OAuth provider failed');
  });
});

describe('persisted state cannot change executable roles', () => {
  for (const role of ['chat', 'node'] as const) {
    it(`rejects incompatible persisted workspaces on ${role} without mutating them`, async () => {
      const config = testConfig({ chat: role === 'chat' });
      roots.push(config.stateDir);
      const db = new GatewayDatabase(config.databasePath);
      // Reuse a configured workspace id on the project node: syncWorkspaces would
      // convert an existing chat row to directory if validation ran after sync.
      const workspaceId = role === 'node' ? config.workspaces[0]!.id : 'chats';
      const original = db.addWorkspace(
        workspaceId,
        config.nodeId,
        'Original workspace',
        config.stateDir,
        role === 'chat' ? 'directory' : 'chat',
      );
      db.close();
      await expect(buildNodeApp(config)).rejects.toThrow(
        `State contains workspaces incompatible with pirc-${role}`,
      );
      const reopened = new GatewayDatabase(config.databasePath);
      try {
        expect(reopened.listWorkspaces()).toEqual([original]);
      } finally {
        reopened.close();
      }
    });
  }
});

describe('role bundle dependency boundaries', () => {
  for (const role of roles) {
    it(`bundles ${role} without the other runtime`, async () => {
      const modules = new Set<string>();
      const result = await Bun.build({
        entrypoints: [entry(role)],
        target: 'bun',
        outdir: temporaryDirectory(),
        external: ['chromium-bidi'],
        plugins: [
          {
            name: 'record-role-module-graph',
            setup(build) {
              // Not srt's embedded seccomp helpers (`with { type: 'file' }`):
              // an onLoad hook on those crashes Bun 1.4's bundler.
              build.onLoad({ filter: /^(?!.*\/vendor\/seccomp\/).*/ }, (args) => {
                modules.add(args.path.replaceAll('\\', '/'));
                return undefined;
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      const graph = [...modules];
      expect(graph).toContain(entry(role));
      const hasModule = (suffix: string) => graph.some((module) => module.endsWith(suffix));
      expect(hasModule('/src/cli.ts')).toBe(false);
      if (role === 'gateway') {
        expect(hasModule('/src/daemon/app.ts')).toBe(true);
        expect(hasModule('/src/backends/oauth-worker.ts')).toBe(true);
        expect(graph.filter((module) => /\/src\/node\//.test(module))).toEqual([
          path.join(gatewayDir, 'src/node/browser-executable.ts'),
        ]);
        for (const suffix of ['/src/agent/main.ts', '/src/agent/agent.ts'])
          expect(hasModule(suffix)).toBe(false);
        expect(graph.some((module) => module.includes('/node_modules/playwright-core/'))).toBe(
          false,
        );
      } else {
        expect(hasModule('/src/node/runtime.ts')).toBe(true);
        expect(hasModule('/src/agent/main.ts')).toBe(true);
        expect(hasModule('/src/agent/ptc/runtime.ts')).toBe(true);
        expect(hasModule('/src/agent/ptc/guest.ts')).toBe(true);
        expect(graph.filter((module) => /\/src\/(daemon|backends)\//.test(module))).toEqual([]);
        expect(graph.some((module) => module.includes('/node_modules/web-push/'))).toBe(false);
      }
    }, 30_000);
  }
});

async function exerciseAgentWorkers(role: 'chat' | 'node', compiled: boolean) {
  const agent = await startAgent({ role, ...(compiled ? { executable: executable(role) } : {}) });
  agents.push(agent);
  writeFileSync(path.join(agent.workspace, 'role.txt'), `pirc-${role}`);
  // PTC scripts run in the QuickJS WASM module the binary carries, with no host process access.
  agent.llm.push(
    {
      tool: {
        id: 'role-ptc',
        name: 'ptc',
        args: {
          code: `return { text: (await tools.read({ path: 'role.txt' })).text, process: typeof (globalThis as any).process };`,
        },
      },
    },
    { text: 'worker finished' },
  );
  await agent.send({ type: 'prompt', message: 'read role.txt through ptc' });
  await settledAfter(agent, 0);
  const ptcEnd = agent.events.find(
    (event) =>
      event.type === 'tool_execution_end' &&
      !event.parentToolCallId &&
      event.toolCallId === 'role-ptc',
  );
  expect(ptcEnd?.isError).toBe(false);
  expect(JSON.parse(ptcEnd?.result.content[0].text)).toEqual({
    text: expect.stringContaining(`pirc-${role}`),
    process: 'undefined',
  });

  // Team workers re-execute this binary; the child records that it runs as a teammate.
  const child: Reply[] = [
    ptcReply(
      'child-bash',
      `return (await tools.bash({ command: 'printf %s "$PIRC_TEAM_AGENT" > child-role.txt' })).text;`,
    ),
    ptcReply(
      'child-board',
      `return (await tools.board_post({ topic: 'role', body: 'recorded' })).text;`,
    ),
    { text: 'role child finished' },
  ];
  const parent: Reply[] = [
    ptcReply(
      'role-spawn',
      `return (await tools.agent_spawn({ name: 'helper', task: 'report role' })).text;`,
    ),
    { text: 'role child spawned' },
    ptcReply('role-board', `return (await tools.board_read({})).text;`),
    { text: 'role team finished' },
  ];
  agent.llm.route = (body) =>
    (JSON.stringify(body.messages).includes('Team message (agent data')
      ? child.shift()
      : parent.shift()) ?? { text: 'extra' };
  await agent.send({ type: 'prompt', message: 'spawn a role helper' });
  await agent.waitFor(
    (event) =>
      event.type === 'message_end' && event.message.content?.[0]?.text === 'role team finished',
    15_000,
  );
  const spawnEnd = agent.events.find(
    (event) =>
      event.type === 'tool_execution_end' &&
      !event.parentToolCallId &&
      event.toolCallId === 'role-spawn',
  );
  expect(spawnEnd?.isError).toBeFalsy();
  const boardEnd = agent.events.find(
    (event) =>
      event.type === 'tool_execution_end' &&
      !event.parentToolCallId &&
      event.toolCallId === 'role-board',
  );
  const note = JSON.parse(boardEnd?.result.content[0].text).items[0];
  expect(note).toMatchObject({ from: 'helper', topic: 'role' });
  expect(readFileSync(path.join(agent.workspace, 'child-role.txt'), 'utf8')).toBe('helper');
}

const ptcReply = (id: string, code: string): Reply => ({
  tool: { id, name: 'ptc', args: { code } },
});

for (const role of ['chat', 'node'] as const) {
  it(
    `${role} source agent re-executes PTC and team workers`,
    () => exerciseAgentWorkers(role, false),
    30_000,
  );
  it.skipIf(!testCompiled)(
    `${role} compiled agent re-executes PTC and team workers`,
    () => exerciseAgentWorkers(role, true),
    30_000,
  );
}
