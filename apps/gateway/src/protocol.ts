/**
 * Daemon ↔ node transport, carried as JSON text frames over the node's
 * outbound WebSocket (`/node/connect`). Both sides must speak the same
 * version: the daemon refuses a registration from any other version, so
 * upgrade the daemon and every node together.
 */
import type { ModelsConfig } from './models.js';

export const NODE_PROTOCOL_VERSION = 3;

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
}

/**
 * Messages the daemon sends to a node. `registered` and `models` carry the
 * gateway's providers with resolved keys; a node uses the latest set for
 * agents it starts afterwards (running agents keep theirs).
 */
export type DaemonToNode =
  | { type: 'registered'; nodeId: string; models: ModelsConfig }
  | { type: 'models'; models: ModelsConfig }
  | { type: 'heartbeat_ack' }
  | { type: 'request'; requestId: string; data: NodeHttpRequest }
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
  | { type: 'register'; protocol: number; workspaces: RegisteredWorkspace[] }
  | { type: 'heartbeat' }
  | { type: 'response'; requestId: string; data: NodeHttpResponse }
  | { type: 'event'; sessionId: string; event: Record<string, unknown> }
  | { type: 'terminal_frame'; streamId: string; frame: unknown }
  | { type: 'terminal_closed'; streamId: string; code: number; reason: string };
