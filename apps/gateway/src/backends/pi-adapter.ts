/** Gateway-only Pi transport. Never import this module into the node agent. */
import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Context,
  Message as PiMessage,
  Model,
  ProviderStreamOptions,
  Tool,
} from '@mariozechner/pi-ai';
import type { AssistantDelta, AssistantMessage, Message, Usage } from '../agent/messages.js';
import { emptyUsage } from '../agent/messages.js';
import type { StreamFn, StreamRequest } from '../agent/providers/types.js';
import { opencodeGoHeaders } from '../agent/providers/opencode-go.js';

/** Injectable so mapping tests need neither global SDK mocks nor network access. */
export type PiDispatcher = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;

const dispatchPi: PiDispatcher = async (model, context, options) => {
  switch (model.api) {
    case 'anthropic-messages': {
      const { streamAnthropic } = await import('@mariozechner/pi-ai/anthropic');
      return streamAnthropic(model as Model<'anthropic-messages'>, context, options);
    }
    case 'openai-completions': {
      const { streamOpenAICompletions } = await import('@mariozechner/pi-ai/openai-completions');
      return streamOpenAICompletions(model as Model<'openai-completions'>, context, options);
    }
    case 'openai-responses': {
      const { streamOpenAIResponses } = await import('@mariozechner/pi-ai/openai-responses');
      return streamOpenAIResponses(model as Model<'openai-responses'>, context, options);
    }
    case 'openai-codex-responses': {
      const { streamOpenAICodexResponses } = await import(
        '@mariozechner/pi-ai/openai-codex-responses'
      );
      return streamOpenAICodexResponses(model as Model<'openai-codex-responses'>, context, options);
    }
    default:
      throw new Error('Unsupported model API');
  }
};

/** Placeholder bearer for user-configured keyless endpoints (e.g. a LAN model server). */
const NO_KEY = 'pirc-no-api-key';
/** Classify without echoing upstream text, which can contain request data or secrets. */
const OVERFLOW =
  /context.?length|context.?window|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|max_tokens.*exceed|request too large/i;
const RATE_LIMIT = /rate.?limit|too many requests|usage limit|quota/i;

const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const piApi = (api: string): Api => (api === 'openai-chat' ? 'openai-completions' : api);

function modelFor(request: StreamRequest): Model<Api> {
  const { model, provider } = request;
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: piApi(model.api ?? provider.api),
    provider: model.canonicalProvider ?? provider.piProvider ?? request.providerName,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: [...model.input],
    cost: zeroCost(),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: { ...provider.headers, ...(model.headers ?? {}) },
    compat: { ...provider.compat, ...model.compat },
  };
}

function historyMessage(message: Message, request: StreamRequest, model: Model<Api>): PiMessage {
  switch (message.role) {
    case 'custom':
      return { role: 'user', content: message.content, timestamp: message.timestamp };
    case 'compactionSummary':
      return {
        role: 'user',
        content: `<summary>\nThe conversation so far was compacted into this summary:\n\n${message.summary}\n</summary>`,
        timestamp: message.timestamp,
      };
    case 'assistant':
      return {
        role: 'assistant',
        api: piApi(message.api),
        // Infer only this backend's identity for old sessions, not other aliases.
        provider:
          message.canonicalProvider ??
          (message.provider === request.providerName ? model.provider : message.provider),
        model: message.model,
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        content: message.content.map((part) =>
          part.type === 'thinking'
            ? {
                type: 'thinking',
                thinking: part.thinking,
                ...(part.signature === undefined ? {} : { thinkingSignature: part.signature }),
                ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
              }
            : structuredClone(part),
        ),
        usage: { ...message.usage, cost: zeroCost() },
        stopReason: message.stopReason,
        timestamp: message.timestamp,
      };
    default:
      return structuredClone(message);
  }
}

/** Pi already reports non-overlapping buckets; cached tokens are not input again. */
function usageOf(usage: PiAssistantMessage['usage']): Usage {
  const { input, output, cacheRead, cacheWrite } = usage;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

function fromPi(
  message: PiAssistantMessage,
  request: StreamRequest,
  timestamp: number,
): AssistantMessage {
  return {
    role: 'assistant',
    api: message.api,
    provider: request.providerName,
    canonicalProvider: message.provider,
    model: message.model,
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    content: message.content.map((part) => {
      switch (part.type) {
        case 'thinking':
          return {
            type: 'thinking',
            thinking: part.thinking,
            ...(part.thinkingSignature === undefined ? {} : { signature: part.thinkingSignature }),
            ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
          };
        case 'toolCall':
          return {
            type: 'toolCall',
            id: part.id,
            name: part.name,
            arguments: structuredClone(part.arguments),
            ...(part.thoughtSignature === undefined
              ? {}
              : { thoughtSignature: part.thoughtSignature }),
          };
        case 'text':
          return {
            type: 'text',
            text: part.text,
            ...(part.textSignature === undefined ? {} : { textSignature: part.textSignature }),
          };
      }
    }),
    usage: usageOf(message.usage),
    stopReason: message.stopReason,
    timestamp,
  };
}

function streamOptions(
  request: StreamRequest,
  model: Model<Api>,
  onStatus: (status: number) => void,
): ProviderStreamOptions {
  const enabled = model.reasoning && request.thinking !== 'off';
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
  const available = levels.filter(
    (level) =>
      model.thinkingLevelMap?.[level] !== null &&
      (level !== 'xhigh' || model.thinkingLevelMap?.xhigh !== undefined),
  );
  const requestedIndex = levels.indexOf(request.thinking as (typeof levels)[number]);
  const level = enabled
    ? (available.find((value) => levels.indexOf(value) >= requestedIndex) ?? available.at(-1))
    : undefined;
  const maxTokens = request.maxTokens ?? model.maxTokens;
  const options: ProviderStreamOptions = {
    // Always explicit, so Pi never falls back to gateway environment credentials.
    apiKey: request.apiKey?.trim() || NO_KEY,
    signal: request.signal,
    sessionId: request.sessionId,
    // Apply at the shared transport boundary for all APIs, not just Chat Completions.
    headers: opencodeGoHeaders(request),
    transport: 'sse',
    maxTokens,
    maxRetries: 0,
    onResponse: ({ status }) => onStatus(status),
    onPayload: (payload) => {
      const body = payload as Record<string, unknown>;
      // Responses APIs lack a toolChoice option. Retain tool definitions for replay.
      if (request.toolChoice)
        body.tool_choice =
          model.api === 'anthropic-messages' ? { type: request.toolChoice } : request.toolChoice;
      // Pi 0.73.1 intentionally omits an output cap for the Codex subscription backend,
      // which is not the public Responses API; do not invent unsupported parameters.
      return body;
    },
  };
  if (model.api === 'anthropic-messages') {
    options.thinkingEnabled = !!level;
    options.toolChoice = request.toolChoice;
    if (level) {
      options.effort =
        model.thinkingLevelMap?.[level] ??
        (level === 'minimal' ? 'low' : level === 'xhigh' ? 'high' : level);
      const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 };
      // maxTokens is a hard cap, not an output budget for streamSimple to inflate.
      options.thinkingBudgetTokens = Math.min(budgets[level], Math.max(0, maxTokens - 1));
      if (maxTokens <= 1024) options.thinkingEnabled = false;
    }
  } else {
    options.reasoningEffort =
      level ??
      (model.api === 'openai-codex-responses' &&
      model.reasoning &&
      model.thinkingLevelMap?.off !== null
        ? 'none'
        : undefined);
    if (model.api === 'openai-completions') options.toolChoice = request.toolChoice;
  }
  return options;
}

/** Stream failures are deliberately generic: upstream bodies can contain secrets. */
export function createPiStream(dispatch: PiDispatcher = dispatchPi): StreamFn {
  return async (request, onDelta) => {
    const timestamp = Date.now(); // Agent replaces this with its lifecycle timestamp.
    let result: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: piApi(request.model.api ?? request.provider.api),
      provider: request.providerName,
      model: request.model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp,
    };
    let status: number | undefined;
    const fail = (aborted: boolean, upstream?: string): AssistantMessage => {
      if (aborted) return { ...result, stopReason: 'aborted' };
      const codex = result.api === 'openai-codex-responses';
      let errorMessage: string;
      if (status === 413 || (upstream && OVERFLOW.test(upstream) && !RATE_LIMIT.test(upstream)))
        errorMessage = 'Model context window exceeded.';
      else if (status && status >= 400)
        // Codex already retries internally (hard-coded in Pi 0.73.1); "status" keeps
        // the agent's HTTP retry matcher from multiplying those attempts.
        errorMessage = `Model provider request failed (${codex ? 'status' : 'HTTP'} ${status}).`;
      else if (upstream && RATE_LIMIT.test(upstream))
        errorMessage = codex ? 'Model usage limit reached.' : 'Model provider rate limit reached.';
      else errorMessage = 'Model provider request failed.';
      return { ...result, stopReason: 'error', errorMessage };
    };
    try {
      if (request.signal.aborted) return fail(true);
      // A managed subscription account must never fall back to another credential.
      if (request.provider.piProvider && !request.apiKey?.trim())
        return {
          ...result,
          stopReason: 'error',
          errorMessage: 'Model credentials are unavailable.',
        };
      const model = modelFor(request);
      const context: Context = {
        systemPrompt: request.systemPrompt,
        messages: request.messages.map((message) => historyMessage(message, request, model)),
        tools: request.tools.map((tool) => ({
          ...tool,
          parameters: structuredClone(tool.parameters) as Tool['parameters'],
        })),
      };
      const stream = await dispatch(
        model,
        context,
        streamOptions(request, model, (value) => {
          if (Number.isInteger(value) && value >= 100 && value <= 599) status = value;
        }),
      );
      for await (const event of stream) {
        if (request.signal.aborted) return fail(true);
        if (event.type === 'done') return fromPi(event.message, request, timestamp);
        if (event.type === 'error') {
          result = fromPi(event.error, request, timestamp);
          return fail(event.reason === 'aborted', event.error.errorMessage);
        }
        result = fromPi(event.partial, request, timestamp);
        if (event.type === 'start') continue; // Agent owns message_start/end.
        let delta: AssistantDelta;
        if (event.type === 'toolcall_start') {
          const call = result.content[event.contentIndex];
          if (call?.type !== 'toolCall') throw new Error('Invalid tool call event');
          delta = {
            type: 'toolcall_start',
            contentIndex: event.contentIndex,
            id: call.id,
            toolName: call.name,
          };
        } else if (event.type === 'toolcall_end') {
          delta = {
            type: event.type,
            contentIndex: event.contentIndex,
            toolCall: structuredClone(event.toolCall),
          };
        } else {
          const { partial: _partial, ...update } = event;
          delta = update;
        }
        onDelta(delta, result);
      }
      // A truncated SSE stream is not a successful assistant turn.
      return fail(request.signal.aborted);
    } catch {
      return fail(request.signal.aborted);
    }
  };
}

export const streamPi: StreamFn = createPiStream();
