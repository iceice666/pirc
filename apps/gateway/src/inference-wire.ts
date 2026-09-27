/** Secret-free inference protocol shared by gateway, node and agent. */
import { z } from 'zod';
import type { AssistantDelta, AssistantMessage, Message } from './agent/messages.js';
import type { StreamRequest, ToolSpec } from './agent/providers/types.js';
import { thinkingLevels } from './models.js';

export const INFERENCE_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
export const INFERENCE_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
export const INFERENCE_STREAM_MAX_BYTES = 256 * 1024 * 1024;
export const INFERENCE_MAX_REQUESTS = 32;
export const INFERENCE_TIMEOUT_MS = 10 * 60_000;
export interface InferenceConfig {
  socketPath: string;
  token: string;
}

const text = z.object({
  type: z.literal('text'),
  text: z.string(),
  textSignature: z.string().optional(),
});
const image = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() });
const thinking = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const toolCall = z.object({
  type: z.literal('toolCall'),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
  thoughtSignature: z.string().optional(),
});
const usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
});
const assistant = z.object({
  role: z.literal('assistant'),
  content: z.array(z.union([text, thinking, toolCall])),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  usage,
  stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']),
  errorMessage: z.string().optional(),
  timestamp: z.number(),
  completedAt: z.number().optional(),
  canonicalProvider: z.string().optional(),
  responseId: z.string().optional(),
  responseModel: z.string().optional(),
});
const message = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.union([text, image]))]),
    timestamp: z.number(),
  }),
  assistant,
  z.object({
    role: z.literal('toolResult'),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([text, image])),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal('custom'),
    customType: z.string(),
    content: z.string(),
    display: z.boolean(),
    details: z.unknown().optional(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal('compactionSummary'),
    summary: z.string(),
    tokensBefore: z.number(),
    timestamp: z.number(),
  }),
]);
export interface InferenceRequest {
  providerName: string;
  modelId: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolSpec[];
  thinking: StreamRequest['thinking'];
  sessionId: string;
  maxTokens?: number;
  toolChoice?: 'auto' | 'none';
}
export const inferenceRequestSchema = z
  .object({
    providerName: z.string().min(1).max(200),
    modelId: z.string().min(1).max(500),
    systemPrompt: z.string(),
    messages: z.array(message).max(20_000),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            description: z.string(),
            parameters: z.record(z.unknown()),
          })
          .strict(),
      )
      .max(1000),
    thinking: z.enum(thinkingLevels),
    sessionId: z.string().min(1).max(500),
    maxTokens: z.number().int().positive().max(1_000_000).optional(),
    toolChoice: z.enum(['auto', 'none']).optional(),
  })
  .strict() as z.ZodType<InferenceRequest>;
export const inferenceErrorSchema = z.enum([
  'unavailable',
  'invalid_request',
  'limit_exceeded',
  'timeout',
  'cancelled',
  'inference_failed',
]);
export type InferenceErrorCode = z.infer<typeof inferenceErrorSchema>;
export type InferenceEvent =
  | { type: 'model_delta'; delta: AssistantDelta }
  | { type: 'model_end'; message: AssistantMessage }
  | { type: 'model_error'; code: InferenceErrorCode };
const contentIndex = z.number().int().nonnegative();
const delta = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_start'), contentIndex }),
  z.object({ type: z.literal('text_delta'), contentIndex, delta: z.string() }),
  z.object({ type: z.literal('text_end'), contentIndex, content: z.string() }),
  z.object({ type: z.literal('thinking_start'), contentIndex }),
  z.object({ type: z.literal('thinking_delta'), contentIndex, delta: z.string() }),
  z.object({ type: z.literal('thinking_end'), contentIndex, content: z.string() }),
  z.object({
    type: z.literal('toolcall_start'),
    contentIndex,
    id: z.string(),
    toolName: z.string(),
  }),
  z.object({ type: z.literal('toolcall_delta'), contentIndex, delta: z.string() }),
  z.object({ type: z.literal('toolcall_end'), contentIndex, toolCall }),
]);
export const inferenceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('model_delta'), delta }),
  z.object({ type: z.literal('model_end'), message: assistant }),
  z.object({ type: z.literal('model_error'), code: inferenceErrorSchema }),
]) as z.ZodType<InferenceEvent>;
export const inferenceEventFrames = [
  z.object({ type: z.literal('model_delta'), requestId: z.string().min(1).max(100), delta }),
  z.object({
    type: z.literal('model_end'),
    requestId: z.string().min(1).max(100),
    message: assistant,
  }),
  z.object({
    type: z.literal('model_error'),
    requestId: z.string().min(1).max(100),
    code: inferenceErrorSchema,
  }),
] as const;
/** Explicit projection: never serialize provider options, endpoints or credentials. */
export function inferenceRequest(request: StreamRequest): InferenceRequest {
  return {
    providerName: request.providerName,
    modelId: request.model.id,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools,
    thinking: request.thinking,
    sessionId: request.sessionId,
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
  };
}
export function inferenceErrorMessage(code: InferenceErrorCode): string {
  return {
    unavailable: 'Gateway inference is unavailable',
    invalid_request: 'Invalid inference request',
    limit_exceeded: 'Inference transport limit exceeded',
    timeout: 'Inference request timed out',
    cancelled: 'Inference request cancelled',
    inference_failed: 'Model inference failed',
  }[code];
}
