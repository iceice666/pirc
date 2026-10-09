import { createHash } from 'node:crypto';
import { BUDGETS, CONTRACT_VERSION, PtcError, type Result } from '../agent/ptc/contracts.js';
import type { Attachments } from '../agent/ptc/attachments.js';
import type { OperationOutcome } from './local.js';
import { resultSchemaOf } from '../agent/ptc/registry.js';
import { validateSchema } from '../agent/ptc/schema.js';
import type { Tool } from '../agent/tools/types.js';
import { intentDigest, type ExecutionIntent } from './protocol.js';

/** Stable UUID namespace for a persisted outer operation and host-assigned trace index. */
export function innerIntent(
  parent: ExecutionIntent,
  operationId: string,
  capability: string,
  args: Record<string, unknown>,
): ExecutionIntent {
  if (!new RegExp(`^${parent.executionId}:op[1-9][0-9]{0,3}$`).test(operationId))
    throw new Error('Invalid PTC trace identity');
  const index = Number(operationId.slice(operationId.lastIndexOf('op') + 2));
  if (index > BUDGETS.internalCalls) throw new Error('PTC inner quota exceeded');
  const uuid = (kind: string) => {
    const bytes = createHash('sha256')
      .update(`${parent.executionId}:${operationId}:${kind}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 0x50;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const { ptc: _snapshot, ...base } = parent;
  const intent = {
    ...base,
    executionId: uuid('execution'),
    parentExecutionId: parent.executionId,
    innerOperationId: uuid('inner'),
    capability,
    arguments: args as ExecutionIntent['arguments'],
  };
  return { ...intent, argumentDigest: intentDigest(intent) };
}

/** Shared typed operation projection. Refusal latch remains supervisor-owned, never script text. */
export function ptcOperationResult(options: {
  operationId: string;
  tool: Tool;
  outcome: OperationOutcome;
  attachments: Attachments;
  signal: AbortSignal;
  declined(message: string): void;
}): Result {
  const { operationId, tool, outcome, attachments, signal } = options;
  const fail = (error: PtcError): Result => ({
    ok: false,
    contractVersion: CONTRACT_VERSION,
    operationId,
    error: error.toJSON(operationId),
  });
  const message = outcome.result.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
  if (outcome.stage === 'denied') options.declined(tool.name);
  if (outcome.stage === 'denied' || outcome.stage === 'withheld')
    return fail(new PtcError('ApprovalDenied', message));
  if (outcome.stage === 'invalid') return fail(new PtcError('InvalidArguments', message));
  if (outcome.stage === 'unavailable') return fail(new PtcError('CapabilityUnavailable', message));
  if (outcome.stage === 'cancelled') return fail(new PtcError('Cancelled', message));
  if (outcome.stage === 'refused') return fail(new PtcError('OperationFailed', message));
  if (outcome.stage === 'threw')
    return fail(new PtcError(signal.aborted ? 'Cancelled' : 'OperationFailed', message, 'unknown'));
  const data = outcome.result.data;
  if (
    outcome.result.isError &&
    ((tool.name === 'unsandboxed_bash' &&
      (outcome.result.details as { denied?: unknown } | undefined)?.denied === true) ||
      (tool.name === 'sandbox_allow_domains' &&
        Array.isArray(data?.granted) &&
        data.granted.length === 0 &&
        data.unrestricted !== true))
  ) {
    options.declined(tool.name);
    return fail(new PtcError('ApprovalDenied', message));
  }
  const ranToExit =
    tool.name === 'bash' &&
    typeof data?.exitCode === 'number' &&
    data.timedOut !== true &&
    data.aborted !== true;
  if (outcome.result.isError && !ranToExit)
    return fail(
      new PtcError(
        signal.aborted ? 'Cancelled' : 'OperationFailed',
        message,
        signal.aborted ? 'unknown' : 'failed',
      ),
    );
  const images = outcome.result.content
    .filter((part) => part.type === 'image')
    .map((part) => attachments.register(part));
  const typed = { text: message, ...(images.length ? { images } : {}), ...data };
  const violations = validateSchema(typed, resultSchemaOf(tool));
  if (violations.length)
    return fail(
      new PtcError(
        'OperationFailed',
        `Result contract mismatch: ${violations.slice(0, 3).join('; ')}`,
        'completed',
      ),
    );
  return {
    ok: true,
    contractVersion: CONTRACT_VERSION,
    operationId,
    data: typed,
    attachments: images,
    truncated: false,
  };
}
