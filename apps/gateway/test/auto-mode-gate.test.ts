import { describe, expect, it } from 'bun:test';
import type { Agent } from '../src/agent/agent.js';
import { AutoMode, visibleKeys } from '../src/agent/auto-mode/index.js';
import { classifyScript } from '../src/agent/auto-mode/script.js';

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

  it('applies to tty input and code scripts', async () => {
    const { auto } = stubAgent({
      features: { autoMode: { useModel: false, deny: ['just\\s+switch'] } },
    });
    await auto.gate('background_task', write('t', 'just sw'), signal);
    expect(await auto.gate('background_task', write('t', 'itch\n'), signal)).toContain('deny-list');
    const script = 'return await tools.bash({ command: "just switch" });';
    expect(await auto.gate('code', { code: script }, signal)).toContain('deny-list');
  });
});

describe('auto mode: code scripts (H2)', () => {
  it('classifies scripts statically', () => {
    const verdict = (code: string) => classifyScript(code).verdict;
    for (const code of [
      'await Bun.$`just switch`;',
      'const { $ } = Bun; await $`rm -rf ~`;',
      'const cp = require("node:child_process"); cp.execSync("x");',
      'const { spawn } = await import("child_process"); spawn("x");',
      'import("node:fs").then((fs) => fs.writeFileSync("/tmp/x", "y"));',
      'await Bun.write(`${process.env.HOME}/.zshrc`, "x");',
      'Bun.spawn(["sh", "-c", "x"]);',
      'fs.rmSync("/", { recursive: true });',
    ])
      expect({ code, verdict: verdict(code) }).toEqual({ code, verdict: 'danger' });
    for (const code of [
      'return process.env.HOME;',
      'return await fetch("https://example.com").then((r) => r.text());',
      'return globalThis["Bu" + "n"].version;',
      'return (() => 0).constructor("return 1")();',
      'return eval("1 + 1");',
      'const x = \\u0042un;',
      'const m = await import("./x.ts");',
    ])
      expect({ code, verdict: verdict(code) }).toEqual({ code, verdict: 'unknown' });
    for (const code of [
      'const files = (await tools.find({ pattern: "*.ts" })).split("\\n"); return files.length;',
      'const m = /a(b)/.exec("ab"); return m?.[1];',
      'for (const f of ["a", "b"]) await tools.read({ path: f }); return 1;',
      // Text cannot see this one; the worker removes the Function constructors (agent-ptc test).
      'return tools.call["constr" + "uctor"];',
    ])
      expect({ code, verdict: verdict(code) }).toEqual({ code, verdict: 'read' });
  });

  it('asks before scripts that bypass the tools, refuses them headless', async () => {
    const headless = stubAgent();
    const code = 'await Bun.$`just switch`;';
    const refused = await headless.auto.gate('code', { code }, signal);
    expect(refused).toContain('no UI');
    expect(headless.leases).toEqual([]);

    const ui = stubAgent({ hasUI: true, confirm: true });
    expect(await ui.auto.gate('code', { code }, signal)).toBeUndefined();
    expect(ui.confirms[0]).toContain('Script (code');
    expect(ui.confirms[0]).toContain('Bun.$');
    expect(ui.leases).toEqual([WORKSPACE]);
  });

  it('runs tools-only scripts without a prompt or lease, others through the model', async () => {
    const { auto, leases, confirms, prompts } = stubAgent({
      hasUI: true,
      features: { autoMode: { useModel: true } },
      model: (prompt) =>
        prompt.includes(HOME_RM)
          ? '<verdict>dangerous</verdict><reason>deletes home</reason>'
          : '<verdict>write</verdict><reason>ok</reason>',
    });
    expect(await auto.gate('code', { code: 'return await tools.ls({});' }, signal)).toBeUndefined();
    expect(leases).toEqual([]);
    expect(prompts).toEqual([]);
    expect(await auto.gate('code', { code: 'return process.cwd();' }, signal)).toBeUndefined();
    expect(leases).toEqual([WORKSPACE]);
    expect(prompts[0]).toContain('TypeScript script');
    expect(prompts[0]).toContain('return process.cwd();');
    const sneaky = `const B = globalThis["Bu" + "n"]; await B.$\`${HOME_RM}\`;`;
    expect(await auto.gate('code', { code: sneaky }, signal)).toContain('declined');
    expect(confirms).toHaveLength(1);
  });
});
