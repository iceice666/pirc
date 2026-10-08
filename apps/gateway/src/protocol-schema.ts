/**
 * Runtime envelopes for the daemon ↔ node link. Registration is parsed
 * separately so a missing/old protocol can receive the protocol-mismatch close.
 * Opaque payloads remain the receiving handler's responsibility, not the link's.
 */
import { z } from 'zod';
import { NODE_ID_PATTERN } from './protocol.js';
import { inferenceEventFrames, inferenceRequestSchema } from './inference-wire.js';
import { modelsSchema } from './models.js';

export const nodeHttpRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  /** Path and query, already rewritten to node-local IDs. */
  url: z.string().startsWith('/api/').max(8192),
  /** Authenticated browser user the daemon acts for. */
  user: z.string().min(1),
  payload: z.unknown().optional(),
  /** Raw upload body, base64-encoded, sent with contentType. */
  bodyBase64: z.string().optional(),
  contentType: z.string().max(200).optional(),
});

export const nodeHttpResponseSchema = z.object({
  status: z.number().int(),
  /** Absent for an empty (204) response; z.unknown() also accepts absence. */
  body: z.unknown(),
});

export const registeredWorkspaceSchema = z.object({
  id: z.string().regex(NODE_ID_PATTERN),
  displayName: z.string().min(1).max(200),
  /** Absent from older nodes: directory. */
  kind: z.enum(['directory', 'chat']).optional(),
  /** The roles its agents can start in; absent when unknown. */
  roles: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        description: z.string().max(500).optional(),
        models: z.array(z.string().max(200)).max(20).optional(),
        thinking: z.string().max(20).optional(),
        tools: z.array(z.string().max(64)).max(64).optional(),
        /** From the workspace's .pirc/roles, possibly replacing a node or built-in role. */
        source: z.enum(['workspace']).optional(),
        overrides: z.enum(['node', 'builtin']).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export const registrationSchema = z.object({
  type: z.literal('register'),
  role: z.enum(['chat', 'node']),
  protocol: z.number().int().optional(),
  workspaces: z.array(registeredWorkspaceSchema).max(100),
});

/** A node session's open run and write lease, sent whole after registration/on change. */
export const sessionActivitySchema = z.object({
  id: z.string().max(200),
  run: z.enum(['queued', 'running', 'waiting_input', 'stopping']).optional(),
  writeLease: z.boolean().optional(),
});

/** Post-registration node messages only: a second register remains invalid. */
export const nodeMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('model_start'),
    requestId: z.string().min(1).max(100),
    request: inferenceRequestSchema,
  }),
  z.object({ type: z.literal('model_cancel'), requestId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('response'),
    requestId: z.string(),
    data: nodeHttpResponseSchema,
  }),
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    event: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('activity'),
    sessions: z.array(sessionActivitySchema).max(10_000),
  }),
  z.object({
    type: z.literal('memory_mirror'),
    ledgerKey: z.string().regex(/^[0-9a-f]{16}$/),
    offset: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    reset: z.boolean().optional(),
    // Bad ledger lines are skipped when stored, never fatal to the link.
    lines: z.array(z.unknown()).max(10_000),
  }),
  z.object({
    type: z.literal('agent_request'),
    requestId: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(200),
    // Handler checks the operation: bad agent input gets an answer, not a closed link.
    op: z.string().max(1000),
    args: z.unknown().optional(),
  }),
  z.object({ type: z.literal('terminal_frame'), streamId: z.string(), frame: z.unknown() }),
  z.object({
    type: z.literal('terminal_closed'),
    streamId: z.string(),
    code: z.number().int(),
    reason: z.string(),
  }),
]);

export const daemonMessageSchema = z.discriminatedUnion('type', [
  ...inferenceEventFrames,
  z.object({
    type: z.literal('registration_error'),
    status: z.number(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('registered'),
    protocol: z.number().int(),
    nodeId: z.string(),
    models: modelsSchema,
    /** Acknowledged workspace-memory ledger offsets, by ledger key. */
    mirrors: z.record(z.number().int().nonnegative()).optional(),
  }),
  z.object({
    type: z.literal('memory_mirror_ack'),
    ledgerKey: z.string().regex(/^[0-9a-f]{16}$/),
    watermark: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('models'), models: modelsSchema }),
  z.object({ type: z.literal('heartbeat_ack') }),
  z.object({
    type: z.literal('request'),
    requestId: z.string().min(1).max(100),
    data: nodeHttpRequestSchema,
  }),
  z.object({
    type: z.literal('terminal_open'),
    streamId: z.string().min(1).max(100),
    user: z.string().min(1),
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    /** Browser live view or terminal (the handler's default when absent). */
    kind: z.enum(['terminal', 'browser']).optional(),
  }),
  z.object({ type: z.literal('terminal_input'), streamId: z.string(), message: z.unknown() }),
  z.object({ type: z.literal('terminal_close'), streamId: z.string() }),
  z.object({
    type: z.literal('agent_response'),
    requestId: z.string().min(1).max(100),
    status: z.number().int(),
    body: z.unknown().optional(),
  }),
]);

export type ParsedRegistration = z.infer<typeof registrationSchema>;
export type ParsedNodeMessage = z.infer<typeof nodeMessageSchema>;
export type ParsedDaemonMessage = z.infer<typeof daemonMessageSchema>;
