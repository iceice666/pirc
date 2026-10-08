import { describe, expect, test } from 'bun:test';
import { executeLocalOperation, type LocalOperationHost } from '../src/environment/local.js';
import { text, type Tool, type ToolContext } from '../src/agent/tools/types.js';

function fixture() {
  const calls: string[] = [];
  const controller = new AbortController();
  const tool: Tool = {
    name: 'write',
    description: 'test',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args) {
      calls.push(`execute:${args.path}`);
      return text('done');
    },
  };
  const host: LocalOperationHost = {
    hooks: {
      async beforeTool(_name, args) {
        calls.push('before');
        return { args: { ...args, path: 'rewritten' } };
      },
      async run() {
        calls.push('after');
        return [{ command: 'audit', stdout: 'audit', stderr: '', exitCode: 0, timedOut: false }];
      },
    },
    hasAfterHooks: () => true,
    async gate(_name, args) {
      calls.push(`gate:${args.path}`);
      return undefined;
    },
    context: () => ({}) as ToolContext,
    log: (message) => {
      calls.push(`log:${message}`);
    },
  };
  return { calls, controller, host, tool };
}

describe('shared local operation boundary', () => {
  test('preserves validation, hooks, policy and final-argument slot ordering', async () => {
    const f = fixture();
    const result = await executeLocalOperation(
      f.host,
      f.tool,
      { path: 'original' },
      f.controller.signal,
      'id',
      undefined,
      {
        beforeExecute: async (_name, args) => {
          f.calls.push(`slot:${args.path}`);
        },
      },
    );
    expect(f.calls).toEqual([
      'before',
      'gate:rewritten',
      'slot:rewritten',
      'execute:rewritten',
      'after',
    ]);
    expect(result).toMatchObject({ stage: 'executed', hookOutput: 'audit' });
    expect(result.result.content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'text', text: '\n[hook]\naudit' },
    ]);
  });
  test('invalid input and invalid hook rewrites never reach the gate', async () => {
    const f = fixture();
    expect(
      (await executeLocalOperation(f.host, f.tool, { path: 1 }, f.controller.signal, 'id')).stage,
    ).toBe('invalid');
    expect(f.calls).toEqual([]);
    f.host.hooks.beforeTool = async () => ({ args: { path: 1 } });
    expect(
      (await executeLocalOperation(f.host, f.tool, { path: 'a' }, f.controller.signal, 'id')).stage,
    ).toBe('invalid');
    expect(f.calls).toEqual([]);
  });
  test('cancellation during the gate is never approval', async () => {
    const f = fixture();
    f.host.gate = async () => {
      f.controller.abort();
      return undefined;
    };
    expect(
      (await executeLocalOperation(f.host, f.tool, { path: 'a' }, f.controller.signal, 'id')).stage,
    ).toBe('cancelled');
    expect(f.calls).toEqual(['before']);
  });
  test('refusal latch is checked again after slot wait', async () => {
    const f = fixture();
    let withheld = false;
    const result = await executeLocalOperation(
      f.host,
      f.tool,
      { path: 'a' },
      f.controller.signal,
      'id',
      undefined,
      {
        withheld: () => (withheld ? 'earlier call refused' : undefined),
        beforeExecute: async () => {
          withheld = true;
        },
      },
    );
    expect(result.stage).toBe('withheld');
    expect(f.calls).toEqual(['before', 'gate:rewritten']);
  });
  test('thrown tool still runs post-hook and reports threw, not not_started', async () => {
    const f = fixture();
    f.tool.execute = async () => {
      throw new Error('partial effect');
    };
    const result = await executeLocalOperation(
      f.host,
      f.tool,
      { path: 'a' },
      f.controller.signal,
      'id',
    );
    expect(result.stage).toBe('threw');
    expect(result.result.isError).toBe(true);
    expect(f.calls.at(-1)).toBe('after');
  });
});
