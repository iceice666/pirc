/** M1 executable contract specification, not yet wired into Agent. */
export const CONTRACT_VERSION = 1;
export const BUDGETS = Object.freeze({
  sourceBytes: 65_536,
  internalCalls: 200,
  outputBytes: 51_200,
  activeTimeoutMs: 120_000,
  maxActiveTimeoutMs: 3_600_000,
  concurrentOperations: 8,
  concurrentWrites: 1,
  quickjsHeapBytes: 128 * 1024 * 1024,
  docsNames: 8,
  docsPageItems: 20,
  docsOutputBytes: 16_384,
  maxAttachments: 4,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxExecutionAttachmentBytes: 16 * 1024 * 1024,
  attachmentTtlMs: 15 * 60_000,
});
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ErrorCode =
  | 'ApprovalDenied'
  | 'CapabilityUnavailable'
  | 'InvalidArguments'
  | 'QuotaExceeded'
  | 'Cancelled'
  | 'Timeout'
  | 'OperationFailed'
  | 'StaleContract';
export interface OperationError {
  code: ErrorCode;
  message: string;
  operationId?: string;
  outcome: 'not_started' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  docs?: { names: string[]; registryVersion: string };
}
/** Handles are opaque to code. The host owns bytes; this object is only a descriptor. */
export interface Attachment {
  handle: string;
  kind: 'image' | 'text';
  mimeType: string;
  bytes: number;
  expiresAt: string;
}
export type Result<T extends Json = Json> =
  | {
      ok: true;
      contractVersion: number;
      operationId: string;
      data: T;
      attachments: Attachment[];
      truncated: boolean;
    }
  | { ok: false; contractVersion: number; operationId: string; error: OperationError };
export interface CapabilityContract {
  name: string;
  category: string;
  description: string;
  contractVersion: number;
  inputSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  errors: ErrorCode[];
  effects: Array<'read' | 'write' | 'external' | 'process' | 'interaction'>;
  concurrency: 'read' | 'exclusive-write';
  approval: 'none' | 'operation-policy' | 'always-confirm' | 'action-dependent';
  suspension: Array<'approval' | 'user' | 'child' | 'job'>;
  uiLabel: string;
  examples: string[];
  /** Availability and authorize are host callbacks, never serializable authority. */
  available(context: unknown): boolean;
  authorize(args: Json, context: unknown): Promise<void>;
  execute(args: Json, context: unknown): Promise<Result>;
}
export type DocsRequest = {
  names?: string[];
  category?: string;
  cursor?: string;
  registryVersion?: string;
};
export interface DocsPage {
  registryVersion: string;
  contractVersion: 1;
  items: Json[];
  truncated: boolean;
  nextCursor: string | null;
}
export interface TraceNode {
  turnId: string;
  executionId: string;
  nodeId: string;
  parentNodeId?: string;
  sequence: number;
  type: 'execution' | 'par' | 'operation';
  status: 'running' | 'suspended' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  createdAt: string;
}

export const IGNORED_ROLE_NAMES = new Set(['code', 'ptc', 'ptc_docs']);
/** Reference decision table only; M2 must replace destructive Agent.restrictTools. */
export function roleCapabilities(names: string[], available: ReadonlySet<string>) {
  const capabilities: string[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    if (IGNORED_ROLE_NAMES.has(name)) warnings.push(`Ignored wrapper name: ${name}`);
    else if (!available.has(name)) warnings.push(`Unknown or unavailable capability: ${name}`);
    else if (!capabilities.includes(name)) capabilities.push(name);
  }
  return { capabilities, warnings, modelTools: capabilities.length ? ['ptc', 'ptc_docs'] : [] };
}

export function validateDocsRequest(request: DocsRequest): void {
  if (
    request.names !== undefined &&
    (request.category !== undefined || request.cursor !== undefined)
  )
    throw new Error('InvalidArguments');
  if (request.cursor !== undefined && !request.category) throw new Error('InvalidArguments');
  if (
    request.names !== undefined &&
    (!request.names.length ||
      request.names.length > BUDGETS.docsNames ||
      request.names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)))
  )
    throw new Error('InvalidArguments');
  if (request.category !== undefined && !/^[a-z][a-z0-9_-]*$/.test(request.category))
    throw new Error('InvalidArguments');
}
