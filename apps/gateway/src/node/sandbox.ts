/**
 * The node side of the agent sandbox (plans/sandbox.md): every agent process
 * runs under srt (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap
 * on Linux) with a per-session policy from sandbox-policy.ts. When srt is
 * missing or cannot sandbox on this host, agents run unconfined and every
 * session shows a warning.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeConfig } from '../config.js';
import { defaultConfigDir, expandHome } from '../models.js';
import {
  sandboxConfigSchema,
  sessionPolicy,
  type SandboxConfig,
  type SessionPolicy,
} from '../sandbox-policy.js';

export type SandboxStatus =
  | { active: true; srt: string }
  | { active: false; reason: string; disabled?: boolean };

/** The node's agent config.json, as the agent itself reads it. */
interface AgentConfigView {
  configDir: string;
  allowedPaths: string[];
  sandbox: SandboxConfig;
  /** Set when config.json is unreadable or its `sandbox` invalid; defaults apply. */
  problem?: string;
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfigView {
  const configDir = defaultConfigDir(env);
  const file = path.join(configDir, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      configDir,
      allowedPaths: [],
      sandbox: sandboxConfigSchema.parse(undefined),
      problem: `${file}: ${(error as Error).message}`,
    };
  }
  const allowedPaths = Array.isArray(raw.allowedPaths)
    ? raw.allowedPaths
        .filter((item): item is string => typeof item === 'string')
        .map((item) => path.resolve(configDir, expandHome(item)))
    : [];
  const parsed = sandboxConfigSchema.safeParse(raw.sandbox);
  return parsed.success
    ? { configDir, allowedPaths, sandbox: parsed.data }
    : {
        configDir,
        allowedPaths,
        // Invalid settings must not loosen anything: keep the defaults.
        sandbox: sandboxConfigSchema.parse(undefined),
        problem: `${file}: invalid "sandbox": ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      };
}

/** srt settings (its `--settings` / `--control-fd` JSON) for a session policy. */
export function srtSettings(policy: SessionPolicy, extraDomains: Iterable<string> = []) {
  const linux = process.platform === 'linux';
  return {
    network: {
      allowedDomains: [...new Set([...policy.network.allowedDomains, ...extraDomains])],
      deniedDomains: policy.network.deniedDomains,
      allowLocalBinding: policy.network.allowLocalBinding,
      // Linux filters Unix sockets with seccomp, which cannot tell paths
      // apart, and the agent must reach the node's inference socket. The
      // read rules still hide sockets in denied directories.
      ...(linux
        ? { allowAllUnixSockets: true }
        : { allowUnixSockets: policy.network.allowUnixSockets }),
    },
    filesystem: {
      denyRead: policy.paths.denyRead,
      allowRead: policy.paths.allowRead,
      allowWrite: policy.paths.allowWrite,
      denyWrite: policy.paths.denyWrite,
      allowGitConfig: policy.allowGitConfig,
    },
    // background_task tty:true and PTY-driven tools.
    allowPty: true,
  };
}

/** Run `srt` once to learn whether it can sandbox anything on this host. */
function probe(srt: string, stateDir: string): Promise<SandboxStatus> {
  const dir = path.join(stateDir, 'sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = path.join(dir, 'probe.json');
  writeFileSync(
    settings,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }),
    { mode: 0o600 },
  );
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (status: SandboxStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const child = spawn(srt, ['--settings', settings, '--', '/bin/sh', '-c', 'exit 0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ active: false, reason: 'srt did not answer within 30 seconds' });
    }, 30_000);
    const collect = (chunk: Buffer) => (output = (output + chunk.toString('utf8')).slice(-2000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => done({ active: false, reason: `srt: ${error.message}` }));
    child.once('exit', (code) =>
      done(
        code === 0
          ? { active: true, srt }
          : {
              active: false,
              reason: `srt cannot sandbox on this host (exit ${code}): ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`,
            },
      ),
    );
  });
}

export interface PreparedSandbox {
  status: SandboxStatus;
  policy: SessionPolicy;
  /** srt's settings file for this session, when sandboxed. */
  settingsFile?: string;
  /** The command to spawn: srt around the agent, or the agent itself. */
  command: string;
  args: string[];
  /** Added to the agent's environment. */
  env: Record<string, string>;
  /** Human-readable warnings for the session (unconfined, config problems). */
  warnings: string[];
  cleanup(): void;
}

export class NodeSandbox {
  private status?: Promise<SandboxStatus>;

  constructor(
    private readonly config: NodeConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Probed once per node process; `PIRC_SANDBOX=off` or `sandbox.enabled: false` skip it. */
  check(): Promise<SandboxStatus> {
    this.status ??= (async (): Promise<SandboxStatus> => {
      if (!this.config.sandbox.enabled)
        return { active: false, disabled: true, reason: 'PIRC_SANDBOX=off on this node' };
      const srt = this.config.sandbox.srt;
      if (!srt)
        return {
          active: false,
          reason: 'srt (sandbox-runtime) is not installed on this node; set PIRC_SANDBOX_SRT',
        };
      return probe(srt, this.config.stateDir);
    })();
    return this.status;
  }

  async prepare(input: {
    sessionId: string;
    workspaceRoot: string;
    sessionDir: string;
    inferenceSocket?: string | undefined;
  }): Promise<PreparedSandbox> {
    const agentConfig = readAgentConfig(this.env);
    const warnings: string[] = [];
    // The session's own temporary directory: srt points TMPDIR inside the
    // sandbox at CLAUDE_CODE_TMPDIR, and it is the only temp dir it may write
    // besides /tmp.
    // Kept short: srt may put Unix sockets there, and macOS caps their paths
    // at 104 bytes.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pirc-'));
    if (agentConfig.problem) warnings.push(`Sandbox settings ignored: ${agentConfig.problem}`);
    const policy = sessionPolicy({
      config: agentConfig.sandbox,
      configDir: agentConfig.configDir,
      home: os.homedir(),
      privateDirs: [
        this.config.stateDir,
        this.config.sessionsDir,
        this.config.uploadsDir,
        path.dirname(this.config.databasePath),
        this.config.browser.profilesDir,
        // systemd credentials (the NixOS module hands the node its token there).
        ...(this.env.CREDENTIALS_DIRECTORY ? [this.env.CREDENTIALS_DIRECTORY] : []),
      ],
      workspaceRoot: input.workspaceRoot,
      allowedPaths: agentConfig.allowedPaths,
      sessionDir: input.sessionDir,
      workspaceMemoryDir: this.config.workspaceMemoryDir,
      inferenceSocket: input.inferenceSocket,
      tmpDirs: [tmp, '/tmp'],
    });
    let status: SandboxStatus;
    if (!agentConfig.sandbox.enabled)
      status = {
        active: false,
        disabled: true,
        reason: 'sandbox.enabled is false in the agent config',
      };
    else status = await this.check();
    const agent = { command: this.config.agentCommand, args: [...this.config.agentArgs] };
    if (!status.active) {
      warnings.push(
        `This agent is not sandboxed: ${status.reason}. Its shell commands run with the node account's full access.`,
      );
      rmSync(tmp, { recursive: true, force: true });
      return { status, policy, ...agent, env: {}, warnings, cleanup: () => undefined };
    }
    const dir = path.join(this.config.stateDir, 'sandbox');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(dir, `${path.basename(input.sessionId)}.json`);
    writeFileSync(settingsFile, JSON.stringify(srtSettings(policy)), { mode: 0o600 });
    chmodSync(settingsFile, 0o600);
    return {
      status,
      policy,
      settingsFile,
      command: status.srt,
      // fd 3 carries network allowlist updates (runtime approvals).
      args: ['--settings', settingsFile, '--control-fd', '3', '--', agent.command, ...agent.args],
      env: { CLAUDE_CODE_TMPDIR: tmp },
      warnings,
      cleanup: () => {
        rmSync(settingsFile, { force: true });
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  }
}
