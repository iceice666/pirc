/** Responses-shaped synthetic model output for offline adapter/runner tests. */
import { OPENAI_PROTOCOL } from './openai-contract.js';
export function fakeResponses(
  reply: { text?: string; tool?: { name: string; args: unknown; id: string } },
  usage = {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 120,
  },
): Response {
  const response = {
    id: 'resp_synthetic',
    model: OPENAI_PROTOCOL.model,
    status: 'in_progress',
    service_tier: 'default',
  };
  const tool = reply.tool;
  const item = tool
    ? {
        type: 'function_call',
        id: `fc_${tool.id}`,
        call_id: tool.id,
        name: tool.name,
        arguments: '',
      }
    : { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [] };
  const done = tool
    ? { ...item, arguments: JSON.stringify(tool.args), status: 'completed' }
    : {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text: reply.text ?? 'synthetic', annotations: [] }],
      };
  const events: unknown[] = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
  ];
  if (tool)
    events.push({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: JSON.stringify(tool.args),
    });
  else
    events.push(
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: reply.text ?? 'synthetic',
      },
    );
  events.push(
    { type: 'response.output_item.done', output_index: 0, item: done },
    {
      type: 'response.completed',
      response: { ...response, status: 'completed', output: [done], usage },
    },
  );
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
