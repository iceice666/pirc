/**
 * Tools for an agent inside its node's OS sandbox (plans/sandbox.md):
 * `sandbox_allow_domains` asks for more network access, `unsandboxed_bash`
 * runs one command outside the sandbox. The node asks the human for both;
 * nothing here can grant anything by itself. Teammates and subagents have
 * them too: their requests go through their parent (see sandbox-channel.ts).
 */
import type { Agent } from '../agent.js';
import type { Feature } from '../feature.js';
import { processSandboxChannel, SandboxRequestError } from '../sandbox-channel.js';
import { truncateOutput } from '../sandbox.js';
import { text, typed, type Tool } from '../tools/types.js';
import { SHELL_RESULT } from '../tools/bash.js';
import { arr, bool, fields, str } from '../tools/result-schema.js';
import { toolPrompt } from '../prompts/tools.js';

/** The tools that run shell commands, as far as this agent has them (chats leave some out). */
const SHELL_TOOLS = ['bash', 'background_task'];

const sandboxPrompt = (shells: string[]) => `## Sandbox

Your shell commands${shells.length ? ` (${shells.join(', ')})` : ''} run in an OS sandbox on this node:
- Reads work anywhere except credential stores (~/.ssh, cloud and git credentials, keychains, browser profiles) and pirc's own state.
- Writes work only in the workspace, temporary directories and build caches. Git hooks and .git/config are read-only.
- Network reaches only allowlisted hosts (common code hosts and package registries). A blocked host fails with "CONNECT tunnel failed, response 403" or a proxy error.

When the sandbox blocks something the task needs:
- A host: call \`sandbox_allow_domains\` with the host and why. The user approves it for this session.
- Anything else (a nix build, git over SSH, changing the system): call \`unsandboxed_bash\`, which runs one command outside the sandbox after the user approves it. Use it only for what the sandbox blocks, never to get around a refusal.`;

const unavailable = () =>
  new SandboxRequestError('unavailable', 'This agent is not running inside a node sandbox');

function tools(): Tool[] {
  return [
    {
      name: 'sandbox_allow_domains',
      description: toolPrompt('sandbox_allow_domains'),
      parameters: {
        type: 'object',
        properties: {
          domains: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Hosts, e.g. ["api.example.com", "*.example.org"]; add ":port" to limit a port',
          },
          reason: { type: 'string', description: 'Why the task needs them, shown to the user' },
        },
        required: ['domains', 'reason'],
        additionalProperties: false,
      },
      // Nothing allowed fails the operation; a ptc script gets ApprovalDenied (ptc/index.ts),
      // carrying these fields as `data`.
      resultSchema: fields({
        granted: arr(str(), 'Hosts this session may now reach'),
        denied: arr(str()),
        unrestricted: bool('This agent is not sandboxed at all'),
      }),
      async execute(args, ctx) {
        const channel = processSandboxChannel();
        if (!channel) throw unavailable();
        // The node asks the human; a ptc script's budget pauses meanwhile.
        const result = await ctx.humanWait(
          channel.request(
            'network',
            { domains: args.domains, reason: args.reason },
            ctx.signal,
            ctx.toolCallId,
          ),
        );
        if (result.unrestricted)
          return typed('This agent is not sandboxed; its network is not restricted.', {
            granted: [],
            denied: [],
            unrestricted: true,
          });
        const granted: string[] = result.granted ?? [];
        const denied: string[] = result.denied ?? (granted.length ? [] : args.domains);
        const data = { granted, denied, unrestricted: false };
        if (!granted.length)
          return typed(
            `The user did not allow ${denied.join(', ')}. Do not try to reach them another way.`,
            data,
            { details: result, isError: true },
          );
        return typed(`Allowed for this session: ${granted.join(', ')}.`, data, { details: result });
      },
    },
    {
      name: 'unsandboxed_bash',
      description: toolPrompt('unsandboxed_bash'),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          reason: {
            type: 'string',
            description: 'What the sandbox blocks and why the task needs it, shown to the user',
          },
          cwd: {
            type: 'string',
            description: 'Directory inside the workspace (default: its root)',
          },
          timeout: { type: 'number', description: 'Timeout in seconds (default 120)' },
        },
        required: ['command', 'reason'],
        additionalProperties: false,
      },
      resultSchema: SHELL_RESULT,
      async execute(args, ctx) {
        const channel = processSandboxChannel();
        if (!channel) throw unavailable();
        // It may write anywhere; hold the workspace's write lease like bash does.
        await ctx.acquireWrite(ctx.cwd);
        let result: Record<string, any>;
        try {
          // The whole request counts as waiting for the human: the node asks
          // first, and the command it then runs is bounded by its own timeout.
          result = await ctx.humanWait(
            channel.request(
              'exec',
              {
                command: args.command,
                reason: args.reason,
                ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
                ...(typeof args.timeout === 'number' ? { timeoutMs: args.timeout * 1000 } : {}),
              },
              ctx.signal,
              ctx.toolCallId,
            ),
          );
        } catch (error) {
          if (error instanceof SandboxRequestError && error.code === 'denied')
            return text(
              'The user did not approve running this outside the sandbox. Do not try to get around it; ask them how to proceed.',
              { denied: true },
              true,
            );
          throw error;
        }
        const output = truncateOutput(
          String(result.output ?? ''),
          ctx.config.limits.toolOutputBytes,
        );
        const status = result.timedOut
          ? '[timed out]'
          : result.aborted
            ? '[aborted]'
            : `[exit ${result.exitCode}]`;
        const body = `${output.text}${output.text.endsWith('\n') || !output.text ? '' : '\n'}${status} (outside the sandbox)`;
        const truncated = output.truncated || result.truncated === true;
        return typed(
          body,
          {
            output: output.text,
            exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
            timedOut: result.timedOut === true,
            aborted: result.aborted === true,
            truncated,
          },
          { details: { exitCode: result.exitCode, truncated }, isError: result.exitCode !== 0 },
        );
      },
    },
  ];
}

export function sandboxFeature(): Feature {
  const list = tools();
  const active = (agent: Agent) => agent.config.sandboxed && Boolean(processSandboxChannel());
  return {
    name: 'sandbox',
    tools: (agent) => (active(agent) ? list : []),
    async beforeAgentStart(agent) {
      if (!active(agent)) return undefined;
      const names = new Set(agent.toolList.map((tool) => tool.name));
      return { systemPrompt: sandboxPrompt(SHELL_TOOLS.filter((name) => names.has(name))) };
    },
  };
}
