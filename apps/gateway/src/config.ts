import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defaultModelsFile } from './models.js';
import { findBrowserExecutable, type BrowserSettings } from './node/browser.js';
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

/** `1280x800` style browser viewport (PIRC_BROWSER_VIEWPORT). */
const viewport = (value: string | undefined) => {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value ?? '');
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  return match
    ? { width: clamp(Number(match[1]), 320, 3840), height: clamp(Number(match[2]), 240, 2160) }
    : { width: 1280, height: 800 };
};

export const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
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
  /** A device token dies after this long without use (PIRC_DEVICE_TOKEN_IDLE_DAYS). */
  deviceTokenIdleMs: number;
  /** A device token dies this long after pairing, however often used (PIRC_DEVICE_TOKEN_MAX_DAYS). */
  deviceTokenMaxAgeMs: number;
  /** Providers and default model pushed to every node (PIRC_MODELS_FILE). */
  modelsFile: string;
  /**
   * Characters of the assistant's memory per user: USER entries
   * (PIRC_MEMORY_USER_CHARS, default 2000) and MEMORY notes
   * (PIRC_MEMORY_NOTE_CHARS, default 8000). See plans/assistant.md.
   */
  memoryBudgets: { user: number; note: number };
  /** How long a delegation waits for the user's approval (PIRC_DELEGATION_TTL_MS, default 1 h). */
  delegationTtlMs: number;
  /** Exa key for agents' web_search (EXA_API_KEY); without it web search is off. */
  exaApiKey?: string | undefined;
  /** Default IANA time zone of schedules agents create (`PIRC_TIMEZONE`, else the system's). */
  timezone: string;
  /**
   * The contact push services may use about this gateway's notifications
   * (`PIRC_VAPID_SUBJECT`, a `mailto:` or `https:` URL; default: the first
   * allowed origin). Keys: `PIRC_VAPID_PUBLIC_KEY`/`PIRC_VAPID_PRIVATE_KEY`,
   * else `<stateDir>/vapid.json` (daemon/push.ts).
   */
  vapidSubject: string;
  /** Accept plain-http push endpoints (`PIRC_PUSH_ALLOW_HTTP`, e.g. ntfy on a LAN); default off. */
  pushAllowHttp: boolean;
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
  /** Hosts the assistant's chat workspaces (PIRC_CHAT, default off; see plans/assistant.md). */
  chat: boolean;
  /**
   * Where this node's agents keep workspace memory, one ledger per repository
   * (PIRC_WORKSPACE_MEMORY_DIR, default `<stateDir>/workspace-memory`). The
   * node mirrors it to the gateway for the assistant's search.
   */
  workspaceMemoryDir: string;
  /** How often the node looks for new workspace memory to mirror (PIRC_MEMORY_MIRROR_MS, default 30 s). */
  memoryMirrorMs: number;
  eventBufferSize: number;
  rpcMaxLineBytes: number;
  uploadMaxBytes: number;
  /** Interactive shells in the web side panel (PIRC_TERMINALS, default on). */
  terminalsEnabled: boolean;
  /** Shell for side-panel terminals (PIRC_TERMINAL_SHELL, default $SHELL). */
  terminalShell?: string;
  /** Agent browser tools and the Browser panel (plans/browser.md, node/browser.ts). */
  browser: BrowserSettings;
  leaseTtlMs: number;
  interactionTtlMs: number;
  shutdownGraceMs: number;
}

/** Local id of the top-level chat workspace a chat node creates for uncategorized chats. */
export const CHAT_WORKSPACE_ID = 'chats';

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
  const deviceTokenIdleMs = integer(env.PIRC_DEVICE_TOKEN_IDLE_DAYS, 7) * DAY_MS;
  const deviceTokenMaxAgeMs = integer(env.PIRC_DEVICE_TOKEN_MAX_DAYS, 30) * DAY_MS;
  if (deviceTokenIdleMs > deviceTokenMaxAgeMs)
    throw new Error('PIRC_DEVICE_TOKEN_IDLE_DAYS cannot exceed PIRC_DEVICE_TOKEN_MAX_DAYS');
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
    deviceTokenIdleMs,
    deviceTokenMaxAgeMs,
    modelsFile: path.resolve(defaultModelsFile(env)),
    memoryBudgets: {
      user: integer(env.PIRC_MEMORY_USER_CHARS, 2000),
      note: integer(env.PIRC_MEMORY_NOTE_CHARS, 8000),
    },
    delegationTtlMs: integer(env.PIRC_DELEGATION_TTL_MS, 3_600_000),
    ...(env.EXA_API_KEY?.trim() ? { exaApiKey: env.EXA_API_KEY.trim() } : {}),
    timezone: timezone(env.PIRC_TIMEZONE),
    vapidSubject: vapidSubject(env.PIRC_VAPID_SUBJECT, [...allowedOrigins][0]!),
    pushAllowHttp: bool(env.PIRC_PUSH_ALLOW_HTTP, false),
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
  const chat = bool(env.PIRC_CHAT, false);
  const workspaces = parseWorkspaces(env);
  if (chat && workspaces.length)
    throw new Error(
      'PIRC_WORKSPACES must be empty on the chat node (PIRC_CHAT): it hosts chat workspaces only',
    );
  return {
    nodeId,
    nodeToken,
    daemonUrl,
    allowedUsers: allowedUsers(env),
    ...dirs,
    sessionsDir,
    ...defaultAgentCommand(env),
    workspaces,
    chat,
    workspaceMemoryDir: path.resolve(
      env.PIRC_WORKSPACE_MEMORY_DIR ?? path.join(dirs.stateDir, 'workspace-memory'),
    ),
    memoryMirrorMs: integer(env.PIRC_MEMORY_MIRROR_MS, 30_000),
    eventBufferSize: integer(env.PIRC_EVENT_BUFFER_SIZE, 1000),
    rpcMaxLineBytes: integer(env.PIRC_RPC_MAX_LINE_BYTES, 1_048_576),
    uploadMaxBytes: uploadLimit(env),
    terminalsEnabled: bool(env.PIRC_TERMINALS, true),
    ...(env.PIRC_TERMINAL_SHELL ? { terminalShell: env.PIRC_TERMINAL_SHELL } : {}),
    browser: {
      enabled: bool(env.PIRC_BROWSER, true),
      executable: findBrowserExecutable(env.PIRC_BROWSER_EXECUTABLE),
      ffmpeg: env.PIRC_FFMPEG || 'ffmpeg',
      ...(env.PIRC_PLAYWRIGHT_CORE
        ? { playwrightCore: path.resolve(env.PIRC_PLAYWRIGHT_CORE) }
        : {}),
      profilesDir: path.resolve(
        env.PIRC_BROWSER_PROFILES_DIR ?? path.join(dirs.stateDir, 'browser'),
      ),
      idleMs: integer(env.PIRC_BROWSER_IDLE_MS, 30 * 60_000),
      viewport: viewport(env.PIRC_BROWSER_VIEWPORT),
    },
    leaseTtlMs: integer(env.PIRC_LEASE_TTL_MS, 30_000),
    interactionTtlMs: integer(env.PIRC_INTERACTION_TTL_MS, 3_600_000),
    shutdownGraceMs: integer(env.PIRC_SHUTDOWN_GRACE_MS, 5_000),
  };
}

/** An IANA time zone (`PIRC_TIMEZONE`), else the system's. */
function timezone(value: string | undefined): string {
  const zone = value?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw new Error(`PIRC_TIMEZONE: unknown time zone ${zone}`);
  }
  return zone;
}

/** Push services want a way to reach the sender: a `mailto:` or `https:` URL. */
function vapidSubject(value: string | undefined, origin: string): string {
  const subject = value?.trim() || origin;
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject))
    throw new Error(
      `PIRC_VAPID_SUBJECT must be a mailto: or https: URL (the default is the first allowed origin, ${origin})`,
    );
  return subject;
}
