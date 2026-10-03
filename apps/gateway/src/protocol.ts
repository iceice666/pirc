/**
 * Daemon ↔ node transport, carried as JSON text frames over the node's
 * outbound WebSocket (`/node/connect`). Both sides must speak the same
 * version: the daemon refuses a registration from any other version, so
 * upgrade the daemon and every node together.
 */
import type { z } from 'zod';
import type { InferenceEvent } from './inference-wire.js';
import type {
  nodeHttpRequestSchema,
  nodeHttpResponseSchema,
  registeredWorkspaceSchema,
  sessionActivitySchema,
  ParsedRegistration,
  ParsedNodeMessage,
  ParsedDaemonMessage,
} from './protocol-schema.js';

/** Node and workspace IDs carried by registration and configuration. */
export const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export const NODE_PROTOCOL_VERSION = 8;

/** One WebSocket frame on the node link. Uploads (base64) must fit, see MAX_UPLOAD_BYTES. */
export const NODE_FRAME_MAX_BYTES = 16_777_216;
/** Browser recordings cross the node link in base64 chunks of this many bytes. */
export const RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;

/** Close code sent to a node that speaks another protocol version. */
export const PROTOCOL_MISMATCH_CLOSE = 4426;

/** The identity header the node's internal router reads; set only by the node runtime. */
export const NODE_USER_HEADER = 'x-pirc-user';

/** An HTTP request the daemon replays on a node's local router. */
export type NodeHttpRequest = z.infer<typeof nodeHttpRequestSchema>;
export type NodeHttpResponse = z.infer<typeof nodeHttpResponseSchema>;
export type RegisteredWorkspace = z.infer<typeof registeredWorkspaceSchema>;

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
 * Messages the daemon sends to a node. Models are the secret-free catalog.
 * Reuse envelope shapes, retaining semantic inference payloads and required
 * opaque fields: Zod's unknown() accepts missing fields on incoming frames.
 */
export type DaemonToNode =
  | Exclude<ParsedDaemonMessage, { type: InferenceEvent['type'] | 'terminal_input' }>
  | (InferenceEvent & { requestId: string })
  | (Extract<ParsedDaemonMessage, { type: 'terminal_input' }> & { message: unknown });

/** A node session's open run and write lease, by the node's session id. */
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

/**
 * Outgoing messages are stricter than parsed envelopes: nodes always advertise
 * a protocol and send typed ledger lines. Incoming mirror lines and agent ops
 * deliberately stay opaque/permissive until their handlers validate them.
 */
export type NodeToDaemon =
  | Exclude<ParsedNodeMessage, { type: 'memory_mirror' | 'terminal_frame' }>
  | (ParsedRegistration & { protocol: number })
  | (Omit<Extract<ParsedNodeMessage, { type: 'memory_mirror' }>, 'lines'> & {
      lines: MirroredLine[];
    })
  | (Extract<ParsedNodeMessage, { type: 'terminal_frame' }> & { frame: unknown });
