import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { Agent } from '../src/agent/agent.js';
import { realResolve } from '../src/agent/sandbox.js';
import { AutoMode, visibleKeys } from '../src/agent/auto-mode/index.js';

const WORKSPACE = '/nonexistent-pirc-gate/home/repo';
const HOME_RM = 'rm -rf /nonexistent-pirc-gate/home';

/** A minimal agent for AutoMode: rules, an optional fake classifier model, UI and lease recorders. */
function stubAgent(
  options: {
    features?: Record<string, unknown>;
    hasUI?: boolean;
    confirm?: boolean;
    model?: (prompt: string) => string;
  } = {},
) {
  const prompts: string[] = [];
  const confirms: string[] = [];
  const leases: string[] = [];
  const config = {
    workspace: WORKSPACE,
    features: options.features ?? { autoMode: { useModel: false } },
    protectedPaths: [],
  };
  const agent = {
    config,
    guard: { allowedRoots: [WORKSPACE] },
    hasUI: options.hasUI ?? false,
    ui: {
      notify: () => undefined,
      confirm: async (_title: string, message: string) => {
        confirms.push(message);
        return options.confirm ?? false;
      },
    },
    acquireWrite: async (cwd: string) => {
      leases.push(cwd);
    },
    modelRef: { provider: 'p', id: 'm' },
    resolveModel: () => ({
      providerName: 'p',
      provider: { apiKey: '' },
      model: { id: 'm', reasoning: false, maxTokens: 1000 },
    }),
    streamFunction: () => async (request: { messages: Array<{ content: string }> }) => {
      const prompt = request.messages[0]!.content;
      prompts.push(prompt);
      return {
        content: [{ type: 'text', text: options.model?.(prompt) ?? '<verdict>write</verdict>' }],
        stopReason: 'stop',
      };
    },
    store: { sessionId: 's', contextEntries: () => [], branch: () => [] },
  };
  return {
    auto: new AutoMode(agent as unknown as Agent),
    config,
    prompts,
    confirms,
    leases,
  };
}

const signal = new AbortController().signal;
const write = (id: string, input: string) => ({ action: 'write', id, input });

describe('auto mode: tty input (M3)', () => {
  it('judges keystrokes together with the rest of their line', async () => {
    const { auto } = stubAgent();
    // Each fragment alone looks harmless or unclear; together they are `rm -rf ~`.
    expect(await auto.gate('background_task', write('t1', 'r'), signal)).toBeUndefined();
    const refused = await auto.gate('background_task', write('t1', 'm -rf ~\n'), signal);
    expect(refused).toContain('deletes');
    expect(refused).toContain('no UI');
    // Another task's line is separate.
    expect(await auto.gate('background_task', write('t2', 'ls\n'), signal)).toBeUndefined();
    // The refused fragment was not sent: the pending line is still `r`.
    expect(auto.actionFor('background_task', write('t1', 'x'))?.text).toBe('rx');
    // Enter submits the line; the next one starts fresh.
    expect(await auto.gate('background_task', write('t1', 'eadme\n'), signal)).toBeUndefined();
    expect(auto.actionFor('background_task', write('t1', 'ls'))?.text).toBe('ls');
    // Ctrl-C discards the line too.
    await auto.gate('background_task', write('t1', 'r'), signal);
    await auto.gate('background_task', write('t1', '\u0003'), signal);
    expect(auto.actionFor('background_task', write('t1', 'ls'))?.text).toBe('ls');
  });

  it('judges concurrent keystrokes to one task in order, not as separate pieces', async () => {
    const { auto } = stubAgent();
    const slow = auto as unknown as { agent: { acquireWrite: () => Promise<void> } };
    // A slow lease answer keeps the first write inside its gate.
    slow.agent.acquireWrite = () => Bun.sleep(30);
    const [first, second] = await Promise.all([
      auto.gate('background_task', write('t1', 'r'), signal),
      auto.gate('background_task', write('t1', 'm -rf ~\n'), signal),
    ]);
    expect(first).toBeUndefined();
    expect(second).toContain('deletes');
  });

  it('shows the model the whole line and marks control keys', async () => {
    const { auto, prompts } = stubAgent({
      features: { autoMode: { useModel: true } },
      model: () => '<verdict>write</verdict><reason>ok</reason>',
    });
    await auto.gate('background_task', write('t', 'git sta'), signal);
    await auto.gate('background_task', write('t', 'tus\t\x1b[A\n'), signal);
    expect(prompts.at(-1)).toContain('git status⟨Tab⟩⟨Esc⟩[A');
    expect(visibleKeys('a\r\x7f\x03\x15')).toBe('a\n⟨Backspace⟩⟨Ctrl-C⟩⟨Ctrl-U⟩');
    // A read-only line with control keys is not read-only any more.
    const decision = await auto.classify(
      auto.actionFor('background_task', write('u', 'ls\x1b[A\n'))!,
      signal,
    );
    expect(decision.source).toBe('model');
  });

  it('bounds the pending line', async () => {
    const { auto } = stubAgent();
    await auto.gate('background_task', write('t', 'x'.repeat(10_000)), signal);
    const text = auto.actionFor('background_task', write('t', 'y'))!.text;
    expect(text.length).toBeLessThan(4_200);
    expect(text).toStartWith('⟨earlier keystrokes truncated⟩');
    expect(
      (await auto.classify(auto.actionFor('background_task', write('t', 'y'))!, signal)).reason,
    ).toContain('model check disabled');
  });
});

describe('auto mode: write lease targets', () => {
  it('leases only the known targets of a command, else its working directory', async () => {
    for (const features of [{ autoMode: { useModel: false } }, { autoMode: { enabled: false } }]) {
      const { auto, leases } = stubAgent({ features });
      await auto.gate('bash', { command: 'cd /tmp && mkdir -p ghpirc' }, signal);
      expect(leases).toEqual([path.join(realResolve('/tmp'), 'ghpirc')]);
      leases.length = 0;
      await auto.gate('bash', { command: 'mkdir -p /tmp/a && git commit -m x' }, signal);
      expect(leases).toEqual([WORKSPACE]);
      leases.length = 0;
      await auto.gate('bash', { command: 'ls' }, signal);
      expect(leases).toEqual([]);
    }
  });

  it('leases the working directory for tty input, whose shell may have moved', async () => {
    const { auto, leases } = stubAgent();
    await auto.gate('background_task', write('t', 'mkdir /tmp/x\n'), signal);
    expect(leases).toEqual([WORKSPACE]);
  });
});

describe('auto mode: deny-list (M1)', () => {
  it('applies before the verdict cache and with auto mode off', async () => {
    const { auto, config, prompts } = stubAgent({
      features: { autoMode: { useModel: true } },
      model: () => '<verdict>write</verdict><reason>prints</reason>',
    });
    const action = auto.actionFor('bash', { command: 'sh -c "echo deploy-prod"' })!;
    expect((await auto.classify(action, signal)).verdict).toBe('write');
    expect((await auto.classify(action, signal)).source).toBe('model'); // cached
    expect(prompts).toHaveLength(1);
    config.features = { autoMode: { useModel: true, deny: ['deploy-prod'] } };
    const denied = await auto.classify(action, signal);
    expect(denied.verdict).toBe('danger');
    expect(denied.reason).toContain('deny-list');
    config.features = { autoMode: { enabled: false, deny: 'deploy-prod' } };
    expect((await auto.classify(action, signal)).verdict).toBe('danger');
    // A broken setting elsewhere does not drop the deny-list.
    config.features = { autoMode: { timeoutMs: 'soon', deny: ['deploy-prod'] } };
    expect((await auto.classify(action, signal)).verdict).toBe('danger');
  });

  it('applies to tty input and ptc scripts', async () => {
    const { auto } = stubAgent({
      features: { autoMode: { useModel: false, deny: ['just\\s+switch'] } },
    });
    await auto.gate('background_task', write('t', 'just sw'), signal);
    expect(await auto.gate('background_task', write('t', 'itch\n'), signal)).toContain('deny-list');
    const script = 'return await tools.bash({ command: "just switch" });';
    expect(await auto.gate('ptc', { code: script }, signal)).toContain('deny-list');
  });
});

describe('auto mode: ptc scripts', () => {
  it('runs scripts without a prompt, lease or classifier: their operations are gated', async () => {
    const { auto, leases, confirms, prompts } = stubAgent({
      hasUI: true,
      features: { autoMode: { useModel: true } },
      model: () => '<verdict>dangerous</verdict><reason>no</reason>',
    });
    // Text that would have alarmed the retired code classifier carries no authority here.
    for (const code of ['return await tools.ls({});', 'await Bun.$`rm -rf ~`;'])
      expect(await auto.gate('ptc', { code }, signal)).toBeUndefined();
    expect([leases, confirms, prompts]).toEqual([[], [], []]);
  });

  it('the retired code tool is no longer gated as a script', () => {
    const { auto } = stubAgent();
    expect(auto.actionFor('code', { code: 'await Bun.$`x`;' })).toBeUndefined();
  });
});
