import { scheduleTool } from '../agent/features/schedules.js';
import type { ExecutionIntent } from '../environment/protocol.js';
import type { ToolContext } from '../agent/tools/types.js';

/** Preserve the existing schedule schema/result/approval wording without recreating a
 * NodeGateway transport or reading node files in the gateway. Dispatch remains owner scoped.
 * Side effects must be invoked from the central operation's original-ID transaction/service.
 */
export function gatewayScheduleTool(
  request: (
    op: string,
    args: Record<string, unknown>,
    intent: ExecutionIntent,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const metadata = scheduleTool({
    request: async () => {
      throw new Error('Unbound schedule service');
    },
  });
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: metadata.parameters,
    resultSchema: metadata.resultSchema,
    async execute(args: Record<string, unknown>, intent: ExecutionIntent, signal: AbortSignal) {
      const tool = scheduleTool({
        request: (op, value = {}, callSignal) => request(op, value, intent, callSignal ?? signal),
      });
      // Schedule implementation consumes only signal; fail closed if future changes
      // accidentally introduce node configuration/filesystem dependencies.
      const context = new Proxy(
        { signal },
        {
          get(target, key) {
            if (key === 'signal') return target.signal;
            throw new Error(`Schedule attempted environment context access: ${String(key)}`);
          },
        },
      ) as ToolContext;
      return tool.execute(args, context);
    },
  };
}
