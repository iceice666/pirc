/**
 * The OS sandbox policy for agents (plans/sandbox.md), shared by the node,
 * which wraps each agent process in srt with it, and the agent, whose file
 * tools (PathGuard) apply the same rules so both give the same answer.
 *
 * - Reads are open, except credential stores and pirc's own state, with the
 *   session's own directories allowed back.
 * - Writes are closed, except the workspace, the session's state, temporary
 *   directories and build caches.
 * - Network goes through srt's proxy: a built-in list of package registries
 *   and code hosts, the node's configured domains, and any the human
 *   approves while a session runs.
 */
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Package registries and code hosts most builds need. */
export const DEFAULT_ALLOWED_DOMAINS = [
  // Git hosting
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'ghcr.io',
  'gitlab.com',
  'codeberg.org',
  // JavaScript
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'bun.sh',
  'jsr.io',
  'npm.jsr.io',
  // Python
  'pypi.org',
  'files.pythonhosted.org',
  // Rust
  'crates.io',
  '*.crates.io',
  'static.rust-lang.org',
  // Go
  'proxy.golang.org',
  'sum.golang.org',
  // Nix
  'cache.nixos.org',
  'channels.nixos.org',
  'releases.nixos.org',
  'tarballs.nixos.org',
  '*.cachix.org',
  // JVM and Android
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'dl.google.com',
  // Ruby
  'rubygems.org',
  'index.rubygems.org',
];

/** Credential stores and private data under $HOME that agents never read. */
export const SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.config/gh',
  '.netrc',
  '.git-credentials',
  '.password-store',
  '.pypirc',
  '.config/sops',
  '.local/share/keyrings',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Messages',
  'Library/Mail',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Arc',
];

/** Build and package caches under $HOME that sandboxed builds may write. */
export const CACHE_HOME_PATHS = [
  '.cache',
  'Library/Caches',
  '.npm',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg/mod',
  '.gradle/caches',
];

/**
 * A network entry as srt accepts it: a host with an optional `*.` prefix, or
 * an IPv4 address (how loopback services are allowed), then an optional
 * `:port`.
 */
export const DOMAIN_PATTERN =
  /^((\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(\*\.)?localhost|(\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/i;

const paths = z.array(z.string().min(1)).default([]);

/** `sandbox` in the node's agent config.json (never the project's). */
export const sandboxConfigSchema = z
  .object({
    /** Off runs agents unconfined, with a warning in every session. */
    enabled: z.boolean().default(true),
    network: z
      .object({
        /** Include DEFAULT_ALLOWED_DOMAINS. */
        defaultDomains: z.boolean().default(true),
        allowedDomains: z.array(z.string().regex(DOMAIN_PATTERN)).default([]),
        deniedDomains: z.array(z.string().regex(DOMAIN_PATTERN)).default([]),
        /** Let dev servers listen on localhost. */
        allowLocalBinding: z.boolean().default(true),
        /** macOS: extra Unix sockets (e.g. an ssh-agent or the nix daemon). */
        allowUnixSockets: paths,
      })
      .strict()
      .default({}),
    filesystem: z
      .object({
        denyRead: paths,
        allowRead: paths,
        allowWrite: paths,
        denyWrite: paths,
        /** Let git write .git/config (remotes, upstreams); off keeps hooks and fsmonitor out of reach. */
        allowGitConfig: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/** Absolute, symlink-resolved path rules. */
export interface PathPolicy {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

/** Resolve a path the way the kernel will, following symlinks of the longest existing prefix. */
export function realResolve(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    // Inside the sandbox a denied directory can be seen but not resolved:
    // resolve its parent instead, so /var still becomes /private/var.
    const parent = path.dirname(current);
    real = parent === current ? current : path.join(realResolve(parent), path.basename(current));
  }
  return path.join(real, ...tail);
}

export const isInside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export function expandHomePath(value: string, home = os.homedir()): string {
  return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

const unique = (items: string[]) => [...new Set(items)];

/** The innermost rule containing `real` decides; allow wins a tie, like srt. */
export function readAllowed(policy: PathPolicy, real: string): boolean {
  const deny = Math.max(
    -1,
    ...policy.denyRead.filter((r) => isInside(real, r)).map((r) => r.length),
  );
  if (deny < 0) return true;
  const allow = Math.max(
    -1,
    ...policy.allowRead.filter((r) => isInside(real, r)).map((r) => r.length),
  );
  // srt: allowRead re-opens a region inside a denied one; a deny inside an
  // allowed region still holds.
  return allow >= deny;
}

export function writeAllowed(policy: PathPolicy, real: string): boolean {
  return (
    policy.allowWrite.some((root) => isInside(real, root)) &&
    !policy.denyWrite.some((root) => isInside(real, root))
  );
}

/** What the file tools apply outside a node: credential stores only. */
export function defaultPathPolicy(allowWrite: string[], home = os.homedir()): PathPolicy {
  return {
    denyRead: SENSITIVE_HOME_PATHS.map((item) => realResolve(path.join(home, item))),
    allowRead: [],
    allowWrite: allowWrite.map((item) => realResolve(item)),
    denyWrite: [],
  };
}

export interface SessionPolicyInput {
  config: SandboxConfig;
  /** Base for relative paths in `config` (the agent config directory). */
  configDir: string;
  home?: string;
  /** pirc state that no agent reads: the node's state dir and anything it keeps elsewhere. */
  privateDirs: string[];
  /** Where the agent works (the workspace, or a chat session's directory). */
  workspaceRoot: string;
  /** Other paths the agent config allows writing (global allowedPaths). */
  allowedPaths: string[];
  /** The session's own state (JSONL, team dir), inside `privateDirs`. */
  sessionDir: string;
  workspaceMemoryDir: string;
  inferenceSocket?: string | undefined;
  tmpDirs?: string[];
}

export interface SessionPolicy {
  paths: PathPolicy;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowUnixSockets: string[];
  };
  allowGitConfig: boolean;
}

/** The sandbox for one session of a node. */
export function sessionPolicy(input: SessionPolicyInput): SessionPolicy {
  const home = input.home ?? os.homedir();
  const configured = (items: string[]) =>
    items.map((item) => realResolve(path.resolve(input.configDir, expandHomePath(item, home))));
  const existing = (items: string[]) => items.filter((item) => existsSync(item));
  const workspace = realResolve(input.workspaceRoot);
  const sessionDir = realResolve(input.sessionDir);
  const memoryDir = realResolve(input.workspaceMemoryDir);
  const socketDir = input.inferenceSocket
    ? realResolve(path.dirname(input.inferenceSocket))
    : undefined;
  const tmpDirs = (input.tmpDirs ?? [os.tmpdir(), '/tmp']).map((item) => realResolve(item));
  const { filesystem, network } = input.config;
  const paths: PathPolicy = {
    denyRead: unique([
      ...input.privateDirs.map((item) => realResolve(item)),
      ...existing(SENSITIVE_HOME_PATHS.map((item) => realResolve(path.join(home, item)))),
      ...configured(filesystem.denyRead),
    ]),
    // What the session needs back from inside the private dirs. A chat
    // session's directory lives in the node's state.
    allowRead: unique([
      workspace,
      sessionDir,
      memoryDir,
      ...(socketDir ? [socketDir] : []),
      ...configured(filesystem.allowRead),
    ]),
    allowWrite: unique([
      workspace,
      ...input.allowedPaths.map((item) => realResolve(item)),
      sessionDir,
      memoryDir,
      ...tmpDirs,
      ...existing(CACHE_HOME_PATHS.map((item) => realResolve(path.join(home, item)))),
      ...configured(filesystem.allowWrite),
    ]),
    // The project's agent config; pirc keeps uploads and recordings there
    // itself, from outside the sandbox.
    denyWrite: unique([path.join(workspace, '.pirc'), ...configured(filesystem.denyWrite)]),
  };
  return {
    paths,
    network: {
      allowedDomains: unique([
        ...(network.defaultDomains ? DEFAULT_ALLOWED_DOMAINS : []),
        ...network.allowedDomains,
      ]),
      deniedDomains: unique(network.deniedDomains),
      allowLocalBinding: network.allowLocalBinding,
      allowUnixSockets: unique([
        ...(input.inferenceSocket ? [realResolve(input.inferenceSocket)] : []),
        ...configured(network.allowUnixSockets),
      ]),
    },
    allowGitConfig: filesystem.allowGitConfig,
  };
}
