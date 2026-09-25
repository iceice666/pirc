import type { AssistantMessage, Message, ToolCall } from '../messages.js';
import { emptyUsage, textOf } from '../messages.js';
import { httpError, parseToolArguments, sse, type StreamFn, type StreamRequest } from './types.js';

type Json = Record<string, any>;

function compat(request: StreamRequest): Json {
  return { ...request.provider.compat, ...request.model.compat };
}

function userContent(content: Message & { role: 'user' }): unknown {
  if (typeof content.content === 'string') return content.content;
  return content.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}

export function toOpenAIMessages(request: StreamRequest): Json[] {
  const out: Json[] = [];
  const flags = compat(request);
  if (request.systemPrompt)
    out.push({
      role: flags.supportsDeveloperRole ? 'developer' : 'system',
      content: request.systemPrompt,
    });
  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: userContent(message) });
        break;
      case 'custom':
        out.push({ role: 'user', content: message.content });
        break;
      case 'compactionSummary':
        out.push({
          role: 'user',
          content: `<summary>\nThe conversation so far was compacted into this summary:\n\n${message.summary}\n</summary>`,
        });
        break;
      case 'assistant': {
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          // Keep only completed text so the model sees what was shown to the user.
          const text = message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
          if (text) out.push({ role: 'assistant', content: text });
          break;
        }
        const text = message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        });
        break;
      }
      case 'toolResult': {
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: textOf(message.content) || '(no output)',
        });
        const images = message.content.filter((part) => part.type === 'image');
        if (images.length)
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: `Images returned by tool ${message.toolName}:` },
              ...images.map((part) => ({
                type: 'image_url',
                image_url: { url: `data:${part.mimeType};base64,${part.data}` },
              })),
            ],
          });
        break;
      }
    }
  }
  return out;
}

const effort: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export function openAIBody(request: StreamRequest): Json {
  const flags = compat(request);
  const body: Json = {
    model: request.model.id,
    messages: toOpenAIMessages(request),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.maxTokens ?? request.model.maxTokens,
  };
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (request.toolChoice) body.tool_choice = request.toolChoice;
  }
  if (request.model.reasoning && flags.supportsReasoningEffort !== false)
    body.reasoning_effort = request.thinking === 'off' ? 'none' : effort[request.thinking];
  if (flags.sendSessionAffinityHeaders) body.prompt_cache_key = request.sessionId;
  if (flags.supportsLongCacheRetention) body.prompt_cache_retention = '24h';
  return body;
}

export const streamOpenAIChat: StreamFn = async (request, onDelta) => {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-chat',
    provider: request.providerName,
    model: request.model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  const flags = compat(request);
  /** Maps provider tool-call index → our content index + raw argument buffer. */
  const calls = new Map<number, { contentIndex: number; raw: string }>();
  let textIndex = -1;
  let thinkingIndex = -1;
  const closeText = () => {
    if (textIndex === -1) return;
    const part = message.content[textIndex] as { text: string };
    onDelta({ type: 'text_end', contentIndex: textIndex, content: part.text }, message);
    textIndex = -1;
  };
  const closeThinking = () => {
    if (thinkingIndex === -1) return;
    const part = message.content[thinkingIndex] as { thinking: string };
    onDelta({ type: 'thinking_end', contentIndex: thinkingIndex, content: part.thinking }, message);
    thinkingIndex = -1;
  };
  try {
    const url = `${request.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...request.provider.headers,
    };
    if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
    if (flags.sendSessionAffinityHeaders) headers.session_id = request.sessionId;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAIBody(request)),
      signal: request.signal,
    });
    if (!response.ok || !response.body) throw new Error(await httpError(response));
    let finish: string | null = null;
    for await (const { data } of sse(response.body, request.signal)) {
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data) as Json;
      if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        message.usage = {
          input: (chunk.usage.prompt_tokens ?? 0) - cached,
          output: chunk.usage.completion_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        closeText();
        if (thinkingIndex === -1) {
          thinkingIndex = message.content.push({ type: 'thinking', thinking: '' }) - 1;
          onDelta({ type: 'thinking_start', contentIndex: thinkingIndex }, message);
        }
        (message.content[thinkingIndex] as { thinking: string }).thinking += reasoning;
        onDelta({ type: 'thinking_delta', contentIndex: thinkingIndex, delta: reasoning }, message);
      }
      if (typeof delta.content === 'string' && delta.content) {
        closeThinking();
        if (textIndex === -1) {
          textIndex = message.content.push({ type: 'text', text: '' }) - 1;
          onDelta({ type: 'text_start', contentIndex: textIndex }, message);
        }
        (message.content[textIndex] as { text: string }).text += delta.content;
        onDelta({ type: 'text_delta', contentIndex: textIndex, delta: delta.content }, message);
      }
      for (const call of delta.tool_calls ?? []) {
        closeText();
        closeThinking();
        const index = typeof call.index === 'number' ? call.index : 0;
        let state = calls.get(index);
        if (!state) {
          const contentIndex =
            message.content.push({
              type: 'toolCall',
              id: call.id ?? `call_${index}_${Date.now()}`,
              name: call.function?.name ?? '',
              arguments: {},
            }) - 1;
          state = { contentIndex, raw: '' };
          calls.set(index, state);
          const part = message.content[contentIndex] as ToolCall;
          onDelta(
            { type: 'toolcall_start', contentIndex, id: part.id, toolName: part.name },
            message,
          );
        }
        const part = message.content[state.contentIndex] as ToolCall;
        if (call.function?.name && !part.name) part.name = call.function.name;
        const args = call.function?.arguments;
        if (typeof args === 'string' && args) {
          state.raw += args;
          onDelta(
            { type: 'toolcall_delta', contentIndex: state.contentIndex, delta: args },
            message,
          );
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    closeText();
    closeThinking();
    for (const state of calls.values()) {
      const part = message.content[state.contentIndex] as ToolCall;
      part.arguments = parseToolArguments(state.raw);
      onDelta({ type: 'toolcall_end', contentIndex: state.contentIndex, toolCall: part }, message);
    }
    message.stopReason = calls.size > 0 ? 'toolUse' : finish === 'length' ? 'length' : 'stop';
  } catch (error) {
    closeText();
    closeThinking();
    // Drop half-streamed tool calls: they cannot be executed or replayed.
    message.content = message.content.filter((part) => part.type !== 'toolCall');
    if (request.signal.aborted) message.stopReason = 'aborted';
    else {
      message.stopReason = 'error';
      message.errorMessage = (error as Error).message;
    }
  }
  if (!message.usage.totalTokens)
    message.usage.totalTokens =
      message.usage.input + message.usage.output + message.usage.cacheRead;
  return message;
};
