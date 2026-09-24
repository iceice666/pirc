import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
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

const workspaceInput = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
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
export interface GatewayConfig {
  host: string;
  port: number;
  stateDir: string;
  databasePath: string;
  sessionsDir: string;
  uploadsDir: string;
  piCommand: string;
  piArgs: string[];
  hostId: string;
  workspaces: ConfigWorkspace[];
  trustedProxies: Set<string>;
  allowedUsers: Set<string>;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  identityHeader: string;
  runnerLimit: number;
  eventBufferSize: number;
  rpcMaxLineBytes: number;
  rpcMaxOutputBytes: number;
  websocketMaxBufferedBytes: number;
  uploadMaxBytes: number;
  leaseTtlMs: number;
  interactionTtlMs: number;
  shutdownGraceMs: number;
  allowDefaultWorkspace: boolean;
  nodeTokens?: Map<string, string>;
  nodeAuthSecret?: string;
}

export function parseWorkspaces(env: NodeJS.ProcessEnv): ConfigWorkspace[] {
  const raw = env.PIRC_WORKSPACES;
  let inputs: z.infer<typeof workspaceInput>[];
  if (raw) inputs = z.array(workspaceInput).min(1).parse(JSON.parse(raw));
  else {
    if (!bool(env.PIRC_ALLOW_DEFAULT_WORKSPACE, false))
      throw new Error('PIRC_WORKSPACES is required unless PIRC_ALLOW_DEFAULT_WORKSPACE=true');
    inputs = [
      {
        path: env.PIRC_DEFAULT_WORKSPACE ?? process.cwd(),
        displayName: env.PIRC_DEFAULT_WORKSPACE_NAME,
      },
    ];
  }
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const nodeTokens = new Map<string, string>();
  const configuredTokens = z
    .record(z.string().min(32))
    .parse(JSON.parse(env.PIRC_NODE_TOKENS ?? '{}'));
  if (env.PIRC_NODE_ID && !/^[a-zA-Z0-9_-]{1,100}$/.test(env.PIRC_NODE_ID))
    throw new Error('Invalid PIRC_NODE_ID');
  if (env.PIRC_NODE_ID && (!env.PIRC_NODE_TOKEN || env.PIRC_NODE_TOKEN.length < 32))
    throw new Error('PIRC_NODE_TOKEN must be at least 32 characters');
  for (const [nodeId, token] of Object.entries(configuredTokens)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(nodeId)) throw new Error('Invalid node ID');
    if ([...nodeTokens.values()].includes(token)) throw new Error('Node tokens must be unique');
    nodeTokens.set(nodeId, token);
  }
  const stateDir = path.resolve(env.PIRC_STATE_DIR ?? path.join(process.cwd(), '.state'));
  const trustedProxies = new Set(csv(env.PIRC_TRUSTED_PROXIES));
  const allowedUsers = new Set(csv(env.PIRC_ALLOWED_USERS));
  const allowedOrigins = new Set(csv(env.PIRC_ALLOWED_ORIGINS));
  const allowedHosts = new Set(csv(env.PIRC_ALLOWED_HOSTS));
  if (!trustedProxies.size)
    throw new Error('PIRC_TRUSTED_PROXIES must explicitly name at least one proxy address');
  if (!allowedUsers.size)
    throw new Error('PIRC_ALLOWED_USERS must explicitly name at least one user');
  if (!allowedOrigins.size)
    throw new Error('PIRC_ALLOWED_ORIGINS must explicitly name at least one exact origin');
  if (!allowedHosts.size)
    throw new Error('PIRC_ALLOWED_HOSTS must explicitly name at least one exact Host value');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sessionsDir = path.resolve(env.PIRC_SESSIONS_DIR ?? path.join(stateDir, 'sessions'));
  const uploadsDir = path.resolve(env.PIRC_UPLOADS_DIR ?? path.join(stateDir, 'uploads'));
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  return {
    host: env.PIRC_HOST ?? '127.0.0.1',
    port: integer(env.PIRC_PORT, 8787),
    stateDir,
    databasePath: path.resolve(env.PIRC_DATABASE_PATH ?? path.join(stateDir, 'gateway.sqlite')),
    sessionsDir,
    uploadsDir,
    piCommand: env.PIRC_PI_COMMAND ?? 'pi',
    piArgs: env.PIRC_PI_ARGS ? (JSON.parse(env.PIRC_PI_ARGS) as string[]) : [],
    hostId: env.PIRC_HOST_ID ?? 'local',
    workspaces: parseWorkspaces(env),
    trustedProxies,
    allowedUsers,
    allowedOrigins,
    allowedHosts,
    identityHeader: (env.PIRC_IDENTITY_HEADER ?? 'x-pirc-user').toLowerCase(),
    runnerLimit: integer(env.PIRC_RUNNER_LIMIT, 2),
    eventBufferSize: integer(env.PIRC_EVENT_BUFFER_SIZE, 1000),
    rpcMaxLineBytes: integer(env.PIRC_RPC_MAX_LINE_BYTES, 1_048_576),
    rpcMaxOutputBytes: integer(env.PIRC_RPC_MAX_OUTPUT_BYTES, 16_777_216),
    websocketMaxBufferedBytes: integer(env.PIRC_WS_MAX_BUFFERED_BYTES, 1_048_576),
    uploadMaxBytes: integer(env.PIRC_UPLOAD_MAX_BYTES, 10_485_760),
    leaseTtlMs: integer(env.PIRC_LEASE_TTL_MS, 30_000),
    interactionTtlMs: integer(env.PIRC_INTERACTION_TTL_MS, 3_600_000),
    shutdownGraceMs: integer(env.PIRC_SHUTDOWN_GRACE_MS, 5_000),
    allowDefaultWorkspace: bool(env.PIRC_ALLOW_DEFAULT_WORKSPACE, false),
    nodeTokens,
    ...(env.PIRC_NODE_ID && env.PIRC_NODE_TOKEN ? { nodeAuthSecret: env.PIRC_NODE_TOKEN } : {}),
  };
}
