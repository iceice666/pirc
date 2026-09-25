import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selfCommand } from '../../self.js';
import type { Agent } from '../agent.js';
import { truncateOutput } from '../sandbox.js';
import { killGroup } from '../tools/bash.js';
import { text, type Tool, type ToolResult } from '../tools/types.js';

const MAX_TOOL_CALLS = 500;

function describeTools(agent: Agent): string {
  return agent.toolList
    .filter((tool) => tool.ptc && tool.name !== 'code')
    .map((tool) => {
      const props = Object.keys(
        ((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}) as object,
      );
      return `tools.${tool.name}({${props.join(', ')}})`;
    })
    .join(', ');
}

/**
 * PTC / code mode: the model writes a TypeScript function body that runs in a
 * Bun child process (cwd = workspace, timeout, capped output). Tool calls go
 * back through the agent, so path limits and hooks still apply to them.
 */
export function codeTool(agent: Agent): Tool {
  return {
    name: 'code',
    description: `Run a TypeScript async function body in Bun to batch many tool calls, loop, filter or compute without round-trips. \`tools.<name>(args)\` returns the tool's text output (throws on tool error); \`tools.call(name, args)\` returns {content, details, isError}. Available: ${describeTools(agent)}. \`return\` a JSON-serializable value; console.log output is also captured. Runs in the workspace with a timeout (default 120s, \`timeout\` in seconds). Prefer tools over direct fs/process access so workspace limits and hooks apply.`,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Body of `async function ({ tools })`, e.g. `const files = await tools.find({pattern:"**/*.ts"}); return files.split("\\n").length;`',
        },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const timeoutMs =
        typeof args.timeout === 'number' && args.timeout > 0
          ? Math.min(args.timeout * 1000, 3_600_000)
          : ctx.config.limits.ptcTimeoutMs;
      const maxBytes = ctx.config.limits.toolOutputBytes;
      const dir = mkdtempSync(path.join(tmpdir(), 'pirc-ptc-'));
      const file = path.join(dir, 'script.ts');
      writeFileSync(
        file,
        `export default async function ({ tools }: { tools: any }) {\n${args.code}\n}\n`,
        {
          mode: 0o600,
        },
      );
      const calls: Array<{ name: string; isError: boolean }> = [];
      let output = '';
      let result: { value?: string; error?: string } | undefined;
      let timedOut = false;
      let aborted = false;
      const children = new AbortController();
      const signal = AbortSignal.any([ctx.signal, children.signal]);
      const report = () =>
        ctx.update(
          text(
            `${calls.length} tool call${calls.length === 1 ? '' : 's'}${
              calls.length
                ? `: ${calls
                    .slice(-5)
                    .map((c) => c.name)
                    .join(', ')}`
                : ''
            }\n${output.slice(-4000)}`,
          ),
        );
      try {
        const child = Bun.spawn([...selfCommand(), 'ptc-worker', file], {
          cwd: ctx.cwd,
          env: { ...process.env, ...ctx.env, PIRC_PTC: '1' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
          ipc(message: any, subprocess) {
            if (message?.type === 'result') result = { value: message.value };
            else if (message?.type === 'error') result = { error: String(message.message) };
            else if (message?.type === 'call') {
              const id = message.id;
              const name = String(message.name);
              const reply = (payload: Record<string, unknown>) => {
                try {
                  subprocess.send({ id, ...payload });
                } catch {
                  /* child exited */
                }
              };
              const tool = agent.getTool(name);
              if (!tool?.ptc || name === 'code')
                return reply({ error: `Tool ${name} is not available in code mode` });
              if (calls.length >= MAX_TOOL_CALLS)
                return reply({ error: `Too many tool calls (limit ${MAX_TOOL_CALLS})` });
              const args =
                message.args && typeof message.args === 'object' && !Array.isArray(message.args)
                  ? (message.args as Record<string, unknown>)
                  : {};
              void agent.invokeTool(name, args, signal).then(
                (toolResult) => {
                  calls.push({ name, isError: !!toolResult.isError });
                  report();
                  // Images cannot cross into the script; keep text parts.
                  reply({
                    result: {
                      content: toolResult.content.filter((part) => part.type === 'text'),
                      details: toolResult.details,
                      isError: !!toolResult.isError,
                    },
                  });
                },
                (error) => reply({ error: (error as Error).message }),
              );
            }
          },
        });
        const stop = () => {
          children.abort();
          killGroup(child.pid, 'SIGTERM');
          setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const onAbort = () => {
          aborted = true;
          stop();
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            output += decoder.decode(chunk, { stream: true });
            if (output.length > maxBytes * 4)
              output = output.slice(0, maxBytes * 2) + output.slice(-maxBytes * 2);
          }
        };
        await Promise.all([pump(child.stdout), pump(child.stderr)]);
        await child.exited;
        killGroup(child.pid, 'SIGKILL');
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      } finally {
        children.abort();
        rmSync(dir, { recursive: true, force: true });
      }
      const parts: string[] = [];
      if (output.trim()) parts.push(`[output]\n${output.trimEnd()}`);
      if (result?.value !== undefined) parts.push(`[return]\n${result.value}`);
      if (result?.error) parts.push(`[error]\n${result.error.replaceAll(file, 'script.ts')}`);
      if (timedOut) parts.push(`[timed out after ${timeoutMs / 1000}s]`);
      if (aborted) parts.push('[aborted]');
      if (!result && !timedOut && !aborted) parts.push('[error]\nScript exited without a result');
      parts.push(
        `[${calls.length} tool call${calls.length === 1 ? '' : 's'}${calls.some((c) => c.isError) ? `, ${calls.filter((c) => c.isError).length} failed` : ''}]`,
      );
      const body = truncateOutput(parts.join('\n\n'), maxBytes);
      const failed = timedOut || aborted || !!result?.error || !result;
      return text(body.text, { toolCalls: calls, truncated: body.truncated }, failed);
    },
  };
}
