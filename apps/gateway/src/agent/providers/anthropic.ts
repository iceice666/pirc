import type { AssistantMessage, ToolCall } from '../messages.js';
import { emptyUsage } from '../messages.js';
import { httpError, parseToolArguments, sse, type StreamFn, type StreamRequest } from './types.js';

type Json = Record<string, any>;

const budgets: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10_000,
  high: 24_000,
  xhigh: 48_000,
};
const efforts: Record<string, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
};

function image(part: { data: string; mimeType: string }): Json {
  return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
}

/** Anthropic requires alternating roles; consecutive same-role messages are merged. */
export function toAnthropicMessages(request: StreamRequest): Json[] {
  const out: Json[] = [];
  const push = (role: 'user' | 'assistant', blocks: Json[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        push(
          'user',
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content.map((part) =>
                part.type === 'text' ? { type: 'text', text: part.text } : image(part),
              ),
        );
        break;
      case 'custom':
        push('user', [{ type: 'text', text: message.content }]);
        break;
      case 'compactionSummary':
        push('user', [
          {
            type: 'text',
            text: `<summary>\nThe conversation so far was compacted into this summary:\n\n${message.summary}\n</summary>`,
          },
        ]);
        break;
      case 'assistant': {
        const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
        const blocks: Json[] = [];
        for (const part of message.content) {
          if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
          else if (part.type === 'thinking' && !failed && part.signature)
            blocks.push(
              part.redacted
                ? { type: 'redacted_thinking', data: part.signature }
                : { type: 'thinking', thinking: part.thinking, signature: part.signature },
            );
          else if (part.type === 'toolCall' && !failed)
            blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments });
        }
        push('assistant', blocks);
        break;
      }
      case 'toolResult':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            is_error: message.isError,
            content: message.content.length
              ? message.content.map((part) =>
                  part.type === 'text' ? { type: 'text', text: part.text } : image(part),
                )
              : [{ type: 'text', text: '(no output)' }],
          },
        ]);
        break;
    }
  }
  // Cache breakpoint on the last user turn so the growing prefix is reused.
  const lastUser = [...out].reverse().find((message) => message.role === 'user');
  const lastBlock = lastUser?.content[lastUser.content.length - 1];
  if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
  return out;
}

export function anthropicBody(request: StreamRequest): Json {
  const flags = { ...request.provider.compat, ...request.model.compat } as Json;
  const maxTokens = request.maxTokens ?? request.model.maxTokens;
  const body: Json = {
    model: request.model.id,
    max_tokens: maxTokens,
    stream: true,
    messages: toAnthropicMessages(request),
  };
  if (request.systemPrompt)
    body.system = [
      { type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' };
  }
  if (request.model.reasoning && request.thinking !== 'off') {
    if (flags.forceAdaptiveThinking) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: efforts[request.thinking] };
    } else {
      const budget = Math.min(budgets[request.thinking] ?? 10_000, Math.max(1024, maxTokens - 1));
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  return body;
}

export const streamAnthropic: StreamFn = async (request, onDelta) => {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: request.providerName,
    model: request.model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  /** Anthropic block index → our content index + raw tool JSON. */
  const blocks = new Map<number, { contentIndex: number; raw: string; kind: string }>();
  try {
    const url = `${request.provider.baseUrl.replace(/\/$/, '')}/v1/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      ...request.provider.headers,
    };
    if (request.apiKey) headers['x-api-key'] = request.apiKey;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(anthropicBody(request)),
      signal: request.signal,
    });
    if (!response.ok || !response.body) throw new Error(await httpError(response));
    let stop: string | null = null;
    for await (const { data } of sse(response.body, request.signal)) {
      const event = JSON.parse(data) as Json;
      switch (event.type) {
        case 'message_start': {
          const usage = event.message?.usage ?? {};
          message.usage.input = usage.input_tokens ?? 0;
          message.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
          message.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
          message.usage.output = usage.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const block = event.content_block ?? {};
          if (block.type === 'text') {
            const contentIndex = message.content.push({ type: 'text', text: '' }) - 1;
            blocks.set(event.index, { contentIndex, raw: '', kind: 'text' });
            onDelta({ type: 'text_start', contentIndex }, message);
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            const redacted = block.type === 'redacted_thinking';
            const contentIndex =
              message.content.push({
                type: 'thinking',
                thinking: '',
                ...(redacted ? { redacted: true, signature: block.data } : {}),
              }) - 1;
            blocks.set(event.index, { contentIndex, raw: '', kind: 'thinking' });
            onDelta({ type: 'thinking_start', contentIndex }, message);
          } else if (block.type === 'tool_use') {
            const contentIndex =
              message.content.push({
                type: 'toolCall',
                id: block.id,
                name: block.name,
                arguments: {},
              }) - 1;
            blocks.set(event.index, { contentIndex, raw: '', kind: 'tool' });
            onDelta(
              { type: 'toolcall_start', contentIndex, id: block.id, toolName: block.name },
              message,
            );
          }
          break;
        }
        case 'content_block_delta': {
          const state = blocks.get(event.index);
          if (!state) break;
          const delta = event.delta ?? {};
          const part = message.content[state.contentIndex] as Json;
          if (delta.type === 'text_delta') {
            part.text += delta.text;
            onDelta(
              { type: 'text_delta', contentIndex: state.contentIndex, delta: delta.text },
              message,
            );
          } else if (delta.type === 'thinking_delta') {
            part.thinking += delta.thinking;
            onDelta(
              { type: 'thinking_delta', contentIndex: state.contentIndex, delta: delta.thinking },
              message,
            );
          } else if (delta.type === 'signature_delta') {
            part.signature = (part.signature ?? '') + delta.signature;
          } else if (delta.type === 'input_json_delta') {
            state.raw += delta.partial_json;
            onDelta(
              {
                type: 'toolcall_delta',
                contentIndex: state.contentIndex,
                delta: delta.partial_json,
              },
              message,
            );
          }
          break;
        }
        case 'content_block_stop': {
          const state = blocks.get(event.index);
          if (!state) break;
          const part = message.content[state.contentIndex] as Json;
          if (state.kind === 'text')
            onDelta(
              { type: 'text_end', contentIndex: state.contentIndex, content: part.text },
              message,
            );
          else if (state.kind === 'thinking')
            onDelta(
              { type: 'thinking_end', contentIndex: state.contentIndex, content: part.thinking },
              message,
            );
          else {
            part.arguments = parseToolArguments(state.raw);
            state.kind = 'tool_done';
            onDelta(
              {
                type: 'toolcall_end',
                contentIndex: state.contentIndex,
                toolCall: part as ToolCall,
              },
              message,
            );
          }
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stop = event.delta.stop_reason;
          if (event.usage?.output_tokens) message.usage.output = event.usage.output_tokens;
          break;
        case 'error':
          throw new Error(event.error?.message ?? JSON.stringify(event.error));
      }
    }
    message.stopReason =
      stop === 'tool_use' ? 'toolUse' : stop === 'max_tokens' ? 'length' : 'stop';
  } catch (error) {
    const unfinished = new Set(
      [...blocks.values()].filter((b) => b.kind === 'tool').map((b) => b.contentIndex),
    );
    message.content = message.content.filter(
      (part, index) => part.type !== 'toolCall' || !unfinished.has(index),
    );
    if (request.signal.aborted) message.stopReason = 'aborted';
    else {
      message.stopReason = 'error';
      message.errorMessage = (error as Error).message;
    }
  }
  message.usage.totalTokens =
    message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
  return message;
};
