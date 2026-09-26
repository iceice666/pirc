import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defaultModelsFile } from './models.js';
import { selfCommand } from './self.js';
import { canonicalPath } from './util.js';

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : ['1', 'true', 'yes'].includes(value.toLowerCase());
const integer = (value: string | undefined, fallback: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .catch(fallback)
    .parse(value ?? fallback);

export const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
/** Node transport frames are capped at 16 MiB; a base64 upload (4/3 larger) must fit in one. */
export const MAX_UPLOAD_BYTES = 11 * 1024 * 1024;

const workspaceInput = z.object({
  id: z.string().regex(NODE_ID_PATTERN).optional(),
  path: z.string().min(1),
  displayName: z.string().min(1).optional(),
  defaults: z.record(z.unknown()).optional(),
});
export interface ConfigWorkspace {
  id: string;
  path: string;
  displayName: string;
  defaults: Record<string, unknown>;
}

/** Browser-facing authentication: identity comes from a trusted forward-auth proxy. */
export interface BrowserAuthConfig {
  trustedProxies: Set<string>;
  allowedUsers: Set<string>;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  identityHeader: string;
}

/**
 * `pirc gateway`: the central daemon. It serves the browser API, never runs
 * agents, and routes every session to the node that owns it.
 */
export interface DaemonConfig extends BrowserAuthConfig {
  host: string;
  port: number;
  stateDir: string;
  databasePath: string;
  uploadsDir: string;
  /** Node ID → shared secret; at least one node is required. */
  nodeTokens: Map<string, string>;
  eventBufferSize: number;
  websocketMaxBufferedBytes: number;
  uploadMaxBytes: number;
  /** Providers and default model pushed to every node (PIRC_MODELS_FILE). */
  modelsFile: string;
}

/**
 * `pirc node`: runs agents, terminals and workspace inspection locally and
 * connects out to the daemon. It never listens on a port.
 */
export interface NodeConfig {
  nodeId: string;
  nodeToken: string;
  daemonUrl: string;
  /** Users the daemon may act for on this node. */
  allowedUsers: Set<string>;
  stateDir: string;
  databasePath: string;
  sessionsDir: string;
  uploadsDir: string;
  /** Executable for per-session agent processes (default: this binary). */
  agentCommand: string;
  /** Arguments placed before the agent flags (default: `agent`, or `<cli.ts> agent` when unbundled). */
  agentArgs: string[];
  workspaces: ConfigWorkspace[];
  runnerLimit: number;
  eventBufferSize: number;
  rpcMaxLineBytes: number;
  rpcMaxOutputBytes: number;
  uploadMaxBytes: number;
  /** Interactive shells in the web side panel (PIRC_TERMINALS, default on). */
  terminalsEnabled: boolean;
  /** Shell for side-panel terminals (PIRC_TERMINAL_SHELL, default $SHELL). */
  terminalShell?: string;
  leaseTtlMs: number;
  interactionTtlMs: number;
  shutdownGraceMs: number;
}

/** Workspaces a node starts with; more can be added from the web client. */
export function parseWorkspaces(env: NodeJS.ProcessEnv): ConfigWorkspace[] {
  const inputs = z.array(workspaceInput).parse(JSON.parse(env.PIRC_WORKSPACES ?? '[]'));
  return inputs.map((item, index) => {
    const resolved = canonicalPath(item.path);
    return {
      id: item.id ?? `workspace-${index + 1}`,
      path: resolved,
      displayName: item.displayName ?? path.basename(resolved),
      defaults: item.defaults ?? {},
    };
  });
}

/**
 * The node re-executes itself as `pirc agent`. When running from source
 * (`bun src/cli.ts`) the executable is bun, so the script path is prepended.
 */
export function defaultAgentCommand(env: NodeJS.ProcessEnv = process.env): {
  agentCommand: string;
  agentArgs: string[];
} {
  if (env.PIRC_AGENT_COMMAND)
    return {
      agentCommand: env.PIRC_AGENT_COMMAND,
      agentArgs: env.PIRC_AGENT_ARGS ? (JSON.parse(env.PIRC_AGENT_ARGS) as string[]) : ['agent'],
    };
  const [agentCommand, ...prefix] = selfCommand();
  return { agentCommand: agentCommand!, agentArgs: [...prefix, 'agent'] };
}

function stateDirs(env: NodeJS.ProcessEnv) {
  const stateDir = path.resolve(env.PIRC_STATE_DIR ?? path.join(process.cwd(), '.state'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const uploadsDir = path.resolve(env.PIRC_UPLOADS_DIR ?? path.join(stateDir, 'uploads'));
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  return {
    stateDir,
    uploadsDir,
    databasePath: path.resolve(env.PIRC_DATABASE_PATH ?? path.join(stateDir, 'gateway.sqlite')),
  };
}

function allowedUsers(env: NodeJS.ProcessEnv): Set<string> {
  const users = new Set(csv(env.PIRC_ALLOWED_USERS));
  if (!users.size) throw new Error('PIRC_ALLOWED_USERS must explicitly name at least one user');
  return users;
}

function uploadLimit(env: NodeJS.ProcessEnv): number {
  const limit = integer(env.PIRC_UPLOAD_MAX_BYTES, 10_485_760);
  if (limit > MAX_UPLOAD_BYTES)
    throw new Error(`PIRC_UPLOAD_MAX_BYTES cannot exceed ${MAX_UPLOAD_BYTES} (node frame limit)`);
  return limit;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  for (const legacy of ['PIRC_WORKSPACES', 'PIRC_NODE_ID'])
    if (env[legacy])
      throw new Error(`${legacy} belongs to \`pirc node\`; the gateway never runs agents itself`);
  const nodeTokens = new Map<string, string>();
  const configured = z.record(z.string().min(32)).parse(JSON.parse(env.PIRC_NODE_TOKENS ?? '{}'));
  for (const [nodeId, token] of Object.entries(configured)) {
    if (!NODE_ID_PATTERN.test(nodeId)) throw new Error('Invalid node ID');
    if ([...nodeTokens.values()].includes(token)) throw new Error('Node tokens must be unique');
    nodeTokens.set(nodeId, token);
  }
  if (!nodeTokens.size)
    throw new Error('The gateway requires PIRC_NODE_TOKENS to accept at least one node');
  const trustedProxies = new Set(csv(env.PIRC_TRUSTED_PROXIES));
  const allowedOrigins = new Set(csv(env.PIRC_ALLOWED_ORIGINS));
  const allowedHosts = new Set(csv(env.PIRC_ALLOWED_HOSTS));
  if (!trustedProxies.size)
    throw new Error('PIRC_TRUSTED_PROXIES must explicitly name at least one proxy address');
  if (!allowedOrigins.size)
    throw new Error('PIRC_ALLOWED_ORIGINS must explicitly name at least one exact origin');
  if (!allowedHosts.size)
    throw new Error('PIRC_ALLOWED_HOSTS must explicitly name at least one exact Host value');
  return {
    host: env.PIRC_HOST ?? '127.0.0.1',
    port: integer(env.PIRC_PORT, 8787),
    ...stateDirs(env),
    trustedProxies,
    allowedUsers: allowedUsers(env),
    allowedOrigins,
    allowedHosts,
    identityHeader: (env.PIRC_IDENTITY_HEADER ?? 'x-pirc-user').toLowerCase(),
    nodeTokens,
    eventBufferSize: integer(env.PIRC_EVENT_BUFFER_SIZE, 1000),
    websocketMaxBufferedBytes: integer(env.PIRC_WS_MAX_BUFFERED_BYTES, 1_048_576),
    uploadMaxBytes: uploadLimit(env),
    modelsFile: path.resolve(defaultModelsFile(env)),
  };
}

export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const nodeId = env.PIRC_NODE_ID;
  const nodeToken = env.PIRC_NODE_TOKEN;
  const daemonUrl = env.PIRC_DAEMON_URL;
  if (!nodeId || !NODE_ID_PATTERN.test(nodeId)) throw new Error('Invalid PIRC_NODE_ID');
  if (!nodeToken || nodeToken.length < 32)
    throw new Error('PIRC_NODE_TOKEN must be at least 32 characters');
  if (!daemonUrl || !/^wss?:\/\//.test(daemonUrl))
    throw new Error('PIRC_DAEMON_URL must be a ws(s):// URL');
  // Plain ws:// never leaves the machine when the daemon is on loopback (single-host setups).
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(daemonUrl).hostname);
  if (
    !daemonUrl.startsWith('wss://') &&
    !loopback &&
    !bool(env.PIRC_ALLOW_INSECURE_NODE_TRANSPORT, false)
  )
    throw new Error(
      'Node transport requires wss:// off loopback (or explicit development-only insecure override)',
    );
  const dirs = stateDirs(env);
  const sessionsDir = path.resolve(env.PIRC_SESSIONS_DIR ?? path.join(dirs.stateDir, 'sessions'));
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  return {
    nodeId,
    nodeToken,
    daemonUrl,
    allowedUsers: allowedUsers(env),
    ...dirs,
    sessionsDir,
    ...defaultAgentCommand(env),
    workspaces: parseWorkspaces(env),
    runnerLimit: integer(env.PIRC_RUNNER_LIMIT, 2),
    eventBufferSize: integer(env.PIRC_EVENT_BUFFER_SIZE, 1000),
    rpcMaxLineBytes: integer(env.PIRC_RPC_MAX_LINE_BYTES, 1_048_576),
    rpcMaxOutputBytes: integer(env.PIRC_RPC_MAX_OUTPUT_BYTES, 16_777_216),
    uploadMaxBytes: uploadLimit(env),
    terminalsEnabled: bool(env.PIRC_TERMINALS, true),
    ...(env.PIRC_TERMINAL_SHELL ? { terminalShell: env.PIRC_TERMINAL_SHELL } : {}),
    leaseTtlMs: integer(env.PIRC_LEASE_TTL_MS, 30_000),
    interactionTtlMs: integer(env.PIRC_INTERACTION_TTL_MS, 3_600_000),
    shutdownGraceMs: integer(env.PIRC_SHUTDOWN_GRACE_MS, 5_000),
  };
}
