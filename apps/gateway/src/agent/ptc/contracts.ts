/**
 * PTC v1 contracts (plans/ptc-m1-contracts.md): budgets, the structured
 * result envelope the script sees and the typed error codes. Metadata here
 * describes capabilities; it never grants anything.
 */
export const CONTRACT_VERSION = 1;

export const BUDGETS = Object.freeze({
  /** `store(key, value)`: one value's JSON, and all values together (characters). */
  storeValueChars: 262_144,
  storeTotalChars: 1_048_576,
  sourceBytes: 65_536,
  internalCalls: 200,
  concurrentOperations: 8,
  concurrentWrites: 1,
  quickjsHeapBytes: 128 * 1024 * 1024,
  quickjsStackBytes: 512 * 1024,
  maxActiveTimeoutMs: 3_600_000,
  /** Bytes of one operation result handed to the script (JSON). */
  resultBytes: 16 * 1024 * 1024,
  /** Bytes of arguments the script may pass to one operation (JSON). */
  argsBytes: 1024 * 1024,
  consoleBytes: 51_200,
  /** `tools.par` calls per execution. */
  parScopes: 200,
  docsNames: 8,
  docsPageItems: 20,
  docsOutputBytes: 16_384,
  /** In-flight operations still settling after cancellation get this long before `unknown`. */
  settleGraceMs: 5_000,
});

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const ERROR_CODES = [
  'ApprovalDenied',
  'CapabilityUnavailable',
  'InvalidArguments',
  'QuotaExceeded',
  'Cancelled',
  'Timeout',
  'OperationFailed',
  'StaleContract',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Outcome = 'not_started' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface OperationError {
  code: ErrorCode;
  message: string;
  operationId?: string;
  outcome: Outcome;
  docs?: { names: string[]; registryVersion: string };
  /** Typed fields of a failed operation's result, when it has any (e.g. a command's exit code). */
  data?: Json;
}

/** An image an operation returned, kept by the host (ptc/attachments.ts). */
export type AttachmentRef = {
  handle: string;
  mimeType: string;
  bytes: number;
};

export type Result<T extends Json = Json> =
  | {
      ok: true;
      contractVersion: number;
      operationId: string;
      data: T;
      /** Images the operation returned, as host-owned descriptors (also `data.images`). */
      attachments: AttachmentRef[];
      truncated: boolean;
    }
  | { ok: false; contractVersion: number; operationId: string; error: OperationError };

/** A failure the host reports as a typed error, before or instead of running an operation. */
export class PtcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly outcome: Outcome = 'not_started',
    readonly docs?: { names: string[]; registryVersion: string },
    readonly data?: Json,
  ) {
    super(message);
    this.name = code;
  }

  toJSON(operationId?: string): OperationError {
    return {
      code: this.code,
      message: this.message,
      outcome: this.outcome,
      ...(operationId ? { operationId } : {}),
      ...(this.docs ? { docs: this.docs } : {}),
      ...(this.data === undefined ? {} : { data: this.data }),
    };
  }
}

export type Effect = 'read' | 'write' | 'external' | 'process' | 'interaction';
export type Approval = 'none' | 'operation-policy' | 'always-confirm' | 'action-dependent';
export type Suspension = 'approval' | 'user' | 'child' | 'job';

export interface TraceNode {
  turnId: string;
  executionId: string;
  nodeId: string;
  parentNodeId?: string;
  sequence: number;
  type: 'execution' | 'par' | 'operation';
  status: 'running' | 'suspended' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  createdAt: string;
  capability?: string;
  durationMs?: number;
  outcome?: Outcome;
  errorCode?: ErrorCode;
}

/**
 * Capabilities a recorded `ptc` result actually started (from the host-written
 * details), for features that judge a result by the tool that produced it.
 * Undefined for any other message.
 */
export function startedCapabilities(message: {
  role: string;
  toolName?: string;
  details?: unknown;
}): string[] | undefined {
  if (message.role !== 'toolResult' || message.toolName !== 'ptc') return undefined;
  const operations = (message.details as { operations?: unknown } | undefined)?.operations;
  if (!Array.isArray(operations)) return [];
  const names = new Set<string>();
  for (const operation of operations) {
    const { capability, outcome } = (operation ?? {}) as {
      capability?: unknown;
      outcome?: unknown;
    };
    if (typeof capability === 'string' && outcome !== 'not_started') names.add(capability);
  }
  // What the script may have loaded from a store written after reading web content.
  const storeTaint = (message.details as { storeTaint?: unknown } | undefined)?.storeTaint;
  if (Array.isArray(storeTaint))
    for (const name of storeTaint) if (typeof name === 'string') names.add(name);
  return [...names];
}

/** Names that are never capabilities: the model-facing wrappers and the retired `code`. */
export const WRAPPER_NAMES: ReadonlySet<string> = new Set(['code', 'ptc', 'ptc_docs']);
export const CAPABILITY_NAME = /^[a-z][a-z0-9_]*$/;
