/**
 * Daemon ↔ node transport, carried as JSON text frames over the node's
 * outbound WebSocket (`/node/connect`). Both sides must speak the same
 * version: the daemon refuses a registration from any other version, so
 * upgrade the daemon and every node together.
 */
import type { ModelsConfig } from './models.js';
import type { InferenceEvent, InferenceRequest } from './inference-wire.js';
import type { WorkspaceKind } from './types.js';
import type { RoleBrief } from './agent/roles.js';

export const NODE_PROTOCOL_VERSION = 9;

/** One WebSocket frame on the node link. Uploads (base64) must fit, see MAX_UPLOAD_BYTES. */
export const NODE_FRAME_MAX_BYTES = 16_777_216;
/** Browser recordings cross the node link in base64 chunks of this many bytes. */
export const RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;

/** Close code sent to a node that speaks another protocol version. */
export const PROTOCOL_MISMATCH_CLOSE = 4426;

/** The identity header the node's internal router reads; set only by the node runtime. */
export const NODE_USER_HEADER = 'x-pirc-user';

/** An HTTP request the daemon replays on a node's local router. */
export interface NodeHttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path and query on the node, already rewritten to node-local IDs. */
  url: string;
  /** Authenticated browser user the daemon acts for. */
  user: string;
  /** JSON body. */
  payload?: unknown;
  /** Raw body (uploads), base64-encoded, sent with `contentType`. */
  bodyBase64?: string;
  contentType?: string;
}

export interface NodeHttpResponse {
  status: number;
  /** Parsed JSON body; absent for an empty (204) response. */
  body?: unknown;
}

export interface RegisteredWorkspace {
  id: string;
  displayName: string;
  /** Absent from older nodes: `directory`. */
  kind?: WorkspaceKind | undefined;
  /** The roles its agents can start in (agent/roles.ts); absent when unknown. */
  roles?: RoleBrief[] | undefined;
}

/**
 * Agent → gateway channel. An agent asks for an allowlisted operation
 * (`area.action`); its node forwards it as `agent_request`, naming the
 * session itself, and the daemon answers with `agent_response`: `{result}`
 * on 2xx, otherwise `{error: {code, message}}`.
 */
export const AGENT_OP_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
export const AGENT_OP_MAX_LENGTH = 64;
/** Serialized `args` of one agent request. */
export const AGENT_REQUEST_MAX_BYTES = 65_536;
/** How long a node waits for the daemon's answer before answering `gateway_timeout` itself. */
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Workspace memory mirrored to the gateway for the assistant's search
 * (`memory_mirror`). The node sends each ledger's complete lines from the
 * byte offset the gateway acknowledged; no filesystem path leaves the node.
 */
export interface MirroredItem {
  id: string;
  content: string;
  relevance: string;
  /** Local time the item was recorded ("YYYY-MM-DD HH:MM"). */
  timestamp: string;
  /** The node session that recorded it. */
  sessionId?: string;
  git?: { head: string; branch?: string; dirty: boolean };
  sourceMemoryIds: string[];
  origins?: string[];
}
export type MirroredLine =
  | { type: 'recorded'; items: MirroredItem[] }
  | { type: 'retired'; ids: string[]; reason: 'superseded' | 'forgotten' }
  | { type: 'cleared' };
/** Raw ledger bytes per `memory_mirror` frame. */
export const MIRROR_CHUNK_BYTES = 262_144;

export interface AgentAnswer {
  status: number;
  body: unknown;
}
export const agentError = (
  status: number,
  code: string,
  message: string,
  /** Structured data the agent can act on (for example the current version after a conflict). */
  details?: unknown,
): AgentAnswer => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

/**
 * Messages the daemon sends to a node. `registered` and `models` carry the
 * gateway's secret-free model catalog. Inference credentials stay on the gateway.
 */
export type DaemonToNode =
  | (InferenceEvent & { requestId: string })
  | {
      type: 'registered';
      nodeId: string;
      models: ModelsConfig;
      /** Byte offset of each workspace-memory ledger the gateway already holds, by ledger key. */
      mirrors?: Record<string, number>;
    }
  | { type: 'memory_mirror_ack'; ledgerKey: string; watermark: number }
  | { type: 'models'; models: ModelsConfig }
  | { type: 'registration_error'; status: number; code: string; message: string }
  | { type: 'heartbeat_ack' }
  | { type: 'request'; requestId: string; data: NodeHttpRequest }
  | { type: 'agent_response'; requestId: string; status: number; body?: unknown }
  | {
      type: 'terminal_open';
      streamId: string;
      user: string;
      sessionId: string;
      terminalId: string;
      /** `browser`: the session's browser live view (terminalId unused). Default `terminal`. */
      kind?: 'terminal' | 'browser';
    }
  | { type: 'terminal_input'; streamId: string; message: unknown }
  | { type: 'terminal_close'; streamId: string };

/** A node session's open run and write lease, by the node's session id. */
export interface SessionActivity {
  id: string;
  run?: 'queued' | 'running' | 'waiting_input' | 'stopping' | undefined;
  writeLease?: boolean | undefined;
}

/** Messages a node sends to the daemon. */
export type NodeToDaemon =
  | { type: 'model_start'; requestId: string; request: InferenceRequest }
  | { type: 'model_cancel'; requestId: string }
  | { type: 'register'; protocol: number; role: 'chat' | 'node'; workspaces: RegisteredWorkspace[] }
  | { type: 'heartbeat' }
  | { type: 'response'; requestId: string; data: NodeHttpResponse }
  | { type: 'event'; sessionId: string; event: Record<string, unknown> }
  /**
   * Every session of this node with an open run or a write lease, sent whole
   * after registering and on each change (the gateway's session list shows it).
   */
  | { type: 'activity'; sessions: SessionActivity[] }
  | { type: 'agent_request'; requestId: string; sessionId: string; op: string; args?: unknown }
  | {
      type: 'memory_mirror';
      ledgerKey: string;
      /** Where `lines` start and end in the ledger file. */
      offset: number;
      end: number;
      /** The file shrank (replaced or truncated): start over from `offset` 0. */
      reset?: boolean;
      lines: MirroredLine[];
    }
  | { type: 'terminal_frame'; streamId: string; frame: unknown }
  | { type: 'terminal_closed'; streamId: string; code: number; reason: string };
