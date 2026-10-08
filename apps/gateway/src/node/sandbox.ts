/**
 * The node side of the agent sandbox (docs/history/sandbox.md): every agent process
 * runs under srt (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap
 * on Linux) with a per-session policy from sandbox-policy.ts. The srt is the
 * one built into this executable (node/srt.ts) unless PIRC_SANDBOX_SRT names
 * another. There is no way around it: when srt cannot sandbox on this host,
 * no agent starts.
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
import { ApiError } from '../errors.js';
import { defaultConfigDir, expandHome } from '../models.js';
import {
  isInside,
  realResolve,
  sandboxConfigSchema,
  sessionPolicy,
  type SandboxConfig,
  type SessionPolicy,
} from '../sandbox-policy.js';
import { selfCommand } from '../self.js';
import { embeddedSeccomp } from './srt.js';

export type SandboxStatus =
  | {
      active: true;
      /** The srt command line: an external binary, or this executable's `srt`. */
      srt: string[];
      /** Linux, built-in srt: the seccomp helper it cannot find by itself. */
      seccompApplyPath?: string | undefined;
    }
  | { active: false; reason: string };

/** How long a failed probe stands before the next agent start probes again. */
const PROBE_RETRY_MS = 30_000;

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
  // `enabled` turned the sandbox off before it became mandatory: drop it, and
  // say so when it asked for that.
  let sandbox = raw.sandbox;
  let legacy: string | undefined;
  if (sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox) && 'enabled' in sandbox) {
    const { enabled, ...rest } = sandbox as Record<string, unknown>;
    sandbox = rest;
    if (enabled === false)
      legacy = `${file}: "sandbox.enabled" is no longer supported; agents always run sandboxed`;
  }
  const parsed = sandboxConfigSchema.safeParse(sandbox);
  return parsed.success
    ? { configDir, allowedPaths, sandbox: parsed.data, ...(legacy ? { problem: legacy } : {}) }
    : {
        configDir,
        allowedPaths,
        // Invalid settings must not loosen anything: keep the defaults.
        sandbox: sandboxConfigSchema.parse(undefined),
        problem: `${file}: invalid "sandbox": ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      };
}

/** srt settings (its `--settings` / `--control-fd` JSON) for a session policy. */
export function srtSettings(
  policy: SessionPolicy,
  extraDomains: Iterable<string> = [],
  seccompApplyPath?: string,
) {
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
    ...(seccompApplyPath ? { seccomp: { applyPath: seccompApplyPath } } : {}),
  };
}

/** Run `srt` once to learn whether it can sandbox anything on this host. */
function probe(
  srt: string[],
  stateDir: string,
  seccompApplyPath: string | undefined,
): Promise<SandboxStatus> {
  const dir = path.join(stateDir, 'sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = path.join(dir, 'probe.json');
  writeFileSync(
    settings,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      ...(seccompApplyPath ? { seccomp: { applyPath: seccompApplyPath } } : {}),
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
    const [command, ...prefix] = srt;
    const child = spawn(
      command!,
      [...prefix, '--settings', settings, '--', '/bin/sh', '-c', 'exit 0'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
          ? { active: true, srt, seccompApplyPath }
          : {
              active: false,
              reason: `srt cannot sandbox on this host (exit ${code}): ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`,
            },
      ),
    );
  });
}

export interface PreparedSandbox {
  status: Extract<SandboxStatus, { active: true }>;
  policy: SessionPolicy;
  /** srt's settings file for this session. */
  settingsFile: string;
  /** The command to spawn: srt around the agent. */
  command: string;
  args: string[];
  /** Added to the agent's environment. */
  env: Record<string, string>;
  /** Human-readable warnings for the session (config problems). */
  warnings: string[];
  /** The settings with the domains the human approved since, for srt's control fd. */
  settings(extraDomains: Iterable<string>): ReturnType<typeof srtSettings>;
  cleanup(): void;
}

/** Where the node keeps the built-in srt's helper binaries; agents may read, never write. */
export const sandboxBinDir = (stateDir: string) => path.join(stateDir, 'sandbox', 'bin');

export class NodeSandbox {
  private status: Promise<SandboxStatus> | undefined;
  private failedAt = 0;

  constructor(
    private readonly config: NodeConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Whether srt can sandbox on this host. A success holds for the node's
   * lifetime; a failure is probed again after PROBE_RETRY_MS.
   */
  check(): Promise<SandboxStatus> {
    if (this.status && this.failedAt && Date.now() - this.failedAt > PROBE_RETRY_MS)
      this.status = undefined;
    this.status ??= (async (): Promise<SandboxStatus> => {
      const external = this.config.sandbox.srt;
      let status: SandboxStatus;
      try {
        status = await probe(
          external ? [external] : [...selfCommand(), 'srt'],
          this.config.stateDir,
          external ? undefined : embeddedSeccomp(sandboxBinDir(this.config.stateDir)),
        );
      } catch (error) {
        status = { active: false, reason: `srt: ${(error as Error).message}` };
      }
      this.failedAt = status.active ? 0 : Date.now();
      return status;
    })();
    return this.status;
  }

  async prepare(input: {
    sessionId: string;
    workspaceRoot: string;
    sessionDir: string;
    inferenceSocket?: string | undefined;
    protectedPaths?: string[];
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
    const privateDirs = [
      this.config.stateDir,
      this.config.sessionsDir,
      this.config.uploadsDir,
      path.dirname(this.config.databasePath),
      this.config.browser.profilesDir,
      // systemd credentials (the NixOS module hands the node its token there).
      ...(this.env.CREDENTIALS_DIRECTORY ? [this.env.CREDENTIALS_DIRECTORY] : []),
    ].map((item) => realResolve(item));
    const policy = sessionPolicy({
      config: agentConfig.sandbox,
      configDir: agentConfig.configDir,
      home: os.homedir(),
      privateDirs,
      workspaceRoot: input.workspaceRoot,
      allowedPaths: agentConfig.allowedPaths,
      sessionDir: input.sessionDir,
      workspaceMemoryDir: this.config.workspaceMemoryDir,
      inferenceSocket: input.inferenceSocket,
      tmpDirs: [tmp, '/tmp'],
      protectedPaths: input.protectedPaths ?? [],
      // The built-in srt's seccomp helper runs inside the sandbox.
      readOnlyDirs: [sandboxBinDir(this.config.stateDir)],
    });
    const exposed = policy.paths.allowWrite.filter((root) =>
      privateDirs.some((dir) => isInside(dir, realResolve(root)) && dir !== realResolve(root)),
    );
    if (exposed.length)
      warnings.push(
        `pirc's state lies inside a writable path of this session (${exposed.join(', ')}). What exists now is protected, but anything the node creates there later (other sessions) is not: move PIRC_STATE_DIR out of it.`,
      );
    const status = await this.check();
    if (!status.active) {
      rmSync(tmp, { recursive: true, force: true });
      throw new ApiError(
        503,
        'runner_unavailable',
        `Agents on this node must run in the sandbox, and it is unavailable: ${status.reason}`,
      );
    }
    const agent = { command: this.config.agentCommand, args: [...this.config.agentArgs] };
    const dir = path.join(this.config.stateDir, 'sandbox');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(dir, `${path.basename(input.sessionId)}.json`);
    const settings = (extraDomains: Iterable<string>) =>
      srtSettings(policy, extraDomains, status.seccompApplyPath);
    writeFileSync(settingsFile, JSON.stringify(settings([])), { mode: 0o600 });
    chmodSync(settingsFile, 0o600);
    const [command, ...prefix] = status.srt;
    return {
      status,
      policy,
      settingsFile,
      command: command!,
      // fd 3 carries network allowlist updates (runtime approvals).
      args: [
        ...prefix,
        '--settings',
        settingsFile,
        '--control-fd',
        '3',
        '--',
        agent.command,
        ...agent.args,
      ],
      env: { CLAUDE_CODE_TMPDIR: tmp },
      warnings,
      settings,
      cleanup: () => {
        rmSync(settingsFile, { force: true });
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  }
}
