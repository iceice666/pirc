import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { startFakeLlm, type FakeLlm } from './fixtures/fake-llm.js';

export interface AgentProcess {
  llm: FakeLlm;
  workspace: string;
  configDir: string;
  sessionDir: string;
  events: Array<Record<string, any>>;
  send(command: Record<string, unknown>): Promise<Record<string, any>>;
  raw(value: unknown): void;
  waitFor(
    predicate: (event: Record<string, any>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, any>>;
  close(): Promise<void>;
  proc: Subprocess<'pipe', 'pipe', 'pipe'>;
}

const cli = path.resolve(import.meta.dir, '../src/cli.ts');

export function writeAgentConfig(
  configDir: string,
  llmUrl: string,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      providers: {
        fake: {
          api: 'openai-chat',
          baseUrl: `${llmUrl}/v1`,
          apiKey: 'test-key',
          models: [{ id: 'fake-model', reasoning: true, contextWindow: 100_000, maxTokens: 1000 }],
        },
        fakeclaude: {
          api: 'anthropic-messages',
          baseUrl: llmUrl,
          apiKey: 'claude-key',
          models: [{ id: 'claude-x', reasoning: true, contextWindow: 100_000, maxTokens: 16_000 }],
        },
      },
      defaultModel: { provider: 'fake', id: 'fake-model', thinking: 'low' },
      ...extra,
      // Titling makes a side request that would consume scripted replies; tests opt in.
      features: {
        sessionTitle: { enabled: false },
        ...(extra.features as Record<string, unknown> | undefined),
      },
    }),
  );
}

export async function startAgent(
  options: {
    config?: Record<string, unknown>;
    args?: string[];
    workspace?: string;
    sessionDir?: string;
    llm?: FakeLlm;
    env?: Record<string, string>;
  } = {},
): Promise<AgentProcess> {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-agent-'));
  const workspace = options.workspace ?? path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const configDir = path.join(root, 'config');
  const sessionDir = options.sessionDir ?? path.join(root, 'session');
  const llm = options.llm ?? startFakeLlm();
  writeAgentConfig(configDir, llm.url, options.config);
  const proc = Bun.spawn(
    [process.execPath, cli, 'agent', '--session-dir', sessionDir, ...(options.args ?? [])],
    {
      cwd: workspace,
      env: { ...process.env, PIRC_CONFIG_DIR: configDir, ...options.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const events: Array<Record<string, any>> = [];
  const waiters = new Set<{
    test: (e: Record<string, any>) => boolean;
    resolve: (e: any) => void;
  }>();
  let counter = 0;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        for (const waiter of [...waiters])
          if (waiter.test(event)) {
            waiters.delete(waiter);
            waiter.resolve(event);
          }
      }
    }
  })();
  let stderr = '';
  void (async () => {
    for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
  })();
  const raw = (value: unknown) => {
    proc.stdin.write(`${JSON.stringify(value)}\n`);
    proc.stdin.flush();
  };
  const waitFor = (test: (e: Record<string, any>) => boolean, timeoutMs = 8000) => {
    const found = events.find(test);
    if (found) return Promise.resolve(found);
    return new Promise<Record<string, any>>((resolve, reject) => {
      const waiter = { test, resolve };
      waiters.add(waiter);
      setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(
          new Error(
            `Timed out waiting for event. stderr=${stderr.slice(-2000)}\nlast events=${JSON.stringify(events.slice(-8)).slice(0, 3000)}`,
          ),
        );
      }, timeoutMs);
    });
  };
  return {
    llm,
    workspace,
    configDir,
    sessionDir,
    events,
    proc,
    raw,
    waitFor,
    async send(command) {
      const id = `c${++counter}`;
      const response = waitFor((event) => event.type === 'response' && event.id === id);
      raw({ ...command, id });
      return response;
    },
    async close() {
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
      await proc.exited;
      clearTimeout(timer);
      if (!options.llm) llm.stop();
    },
  };
}

export const settledAfter = (agent: AgentProcess, from: number) =>
  agent.waitFor((event) => event.type === 'agent_settled' && agent.events.indexOf(event) >= from);
