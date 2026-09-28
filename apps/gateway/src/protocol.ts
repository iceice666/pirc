/**
 * Daemon ↔ node transport, carried as JSON text frames over the node's
 * outbound WebSocket (`/node/connect`). Both sides must speak the same
 * version: the daemon refuses a registration from any other version, so
 * upgrade the daemon and every node together.
 */
import type { ModelsConfig } from './models.js';
import type { InferenceEvent, InferenceRequest } from './inference-wire.js';
import type { WorkspaceKind } from './types.js';

export const NODE_PROTOCOL_VERSION = 5;

/** One WebSocket frame on the node link. Uploads (base64) must fit, see MAX_UPLOAD_BYTES. */
export const NODE_FRAME_MAX_BYTES = 16_777_216;

/** Close code sent to a node that speaks another protocol version. */
export const PROTOCOL_MISMATCH_CLOSE = 4426;

/** The identity header the node's internal router reads; set only by the node runtime. */
export const NODE_USER_HEADER = 'x-pirc-user';

/** An HTTP request the daemon replays on a node's local router. */
export interface NodeHttpRequest {
  method: 'GET' | 'POST' | 'PATCH';
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

export interface AgentAnswer {
  status: number;
  body: unknown;
}
export const agentError = (status: number, code: string, message: string): AgentAnswer => ({
  status,
  body: { error: { code, message } },
});

/**
 * Messages the daemon sends to a node. `registered` and `models` carry the
 * gateway's secret-free model catalog. Inference credentials stay on the gateway.
 */
export type DaemonToNode =
  | (InferenceEvent & { requestId: string })
  | { type: 'registered'; nodeId: string; models: ModelsConfig }
  | { type: 'models'; models: ModelsConfig }
  | { type: 'heartbeat_ack' }
  | { type: 'request'; requestId: string; data: NodeHttpRequest }
  | { type: 'agent_response'; requestId: string; status: number; body?: unknown }
  | {
      type: 'terminal_open';
      streamId: string;
      user: string;
      sessionId: string;
      terminalId: string;
    }
  | { type: 'terminal_input'; streamId: string; message: unknown }
  | { type: 'terminal_close'; streamId: string };

/** Messages a node sends to the daemon. */
export type NodeToDaemon =
  | { type: 'model_start'; requestId: string; request: InferenceRequest }
  | { type: 'model_cancel'; requestId: string }
  | { type: 'register'; protocol: number; workspaces: RegisteredWorkspace[] }
  | { type: 'heartbeat' }
  | { type: 'response'; requestId: string; data: NodeHttpResponse }
  | { type: 'event'; sessionId: string; event: Record<string, unknown> }
  | { type: 'agent_request'; requestId: string; sessionId: string; op: string; args?: unknown }
  | { type: 'terminal_frame'; streamId: string; frame: unknown }
  | { type: 'terminal_closed'; streamId: string; code: number; reason: string };
