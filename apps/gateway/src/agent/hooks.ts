import type { HookConfig, HooksConfig } from './config.js';
import { killGroup } from './tools/bash.js';

export interface HookResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type HookName = keyof HooksConfig;

/**
 * Runs user-configured shell hooks. Each receives a JSON payload on stdin
 * (`{hook, sessionId, cwd, ...}`) and communicates through exit code/stdout.
 */
export class HookRunner {
  constructor(
    private readonly hooks: HooksConfig,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly base: Record<string, unknown>,
    private readonly warn: (message: string) => void,
  ) {}

  has(name: HookName): boolean {
    return this.hooks[name].length > 0;
  }

  private readonly warnedCode = new Set<string>();

  private matching(name: HookName, subject?: string): HookConfig[] {
    return this.hooks[name].filter((hook) => {
      if (!hook.matcher || subject === undefined) return true;
      try {
        const pattern = new RegExp(`^(?:${hook.matcher})$`);
        if (pattern.test(subject)) return true;
        // `ptc` replaced the `code` tool: a rule written for scripts keeps applying.
        if (subject === 'ptc' && pattern.test('code')) {
          if (!this.warnedCode.has(hook.matcher)) {
            this.warnedCode.add(hook.matcher);
            this.warn(
              `Hook matcher "${hook.matcher}" names the retired code tool; it now applies to ptc. Match "ptc" instead.`,
            );
          }
          return true;
        }
        return false;
      } catch {
        return false;
      }
    });
  }

  private async execute(
    hook: HookConfig,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    signal?.throwIfAborted();
    const child = Bun.spawn(['/bin/sh', '-c', hook.command], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, PIRC_HOOK: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    let timedOut = false;
    const stop = () => killGroup(child.pid, 'SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, hook.timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const bounded = async (stream: ReadableStream<Uint8Array>, limit: number) => {
      const decoder = new TextDecoder();
      let value = '';
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (value.length < limit) value += text.slice(0, limit - value.length);
      }
      return value;
    };
    try {
      // Pump output and enforce cancellation even if a hook never reads stdin.
      const input = (async () => {
        try {
          child.stdin.write(JSON.stringify(payload));
          await child.stdin.end();
        } catch (error) {
          // A hook may intentionally use only its configured command and not
          // consume stdin. Its exit status/output still determine the decision.
          if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
        }
      })();
      const [stdout, stderr, exitCode] = await Promise.all([
        bounded(child.stdout, 65_536),
        bounded(child.stderr, 16_384),
        child.exited,
        input,
      ]);
      signal?.throwIfAborted();
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      stop();
    }
  }

  /** Run every matching hook in order; failures produce a warning but never throw. */
  async run(
    name: HookName,
    data: Record<string, unknown>,
    subject?: string,
    signal?: AbortSignal,
  ): Promise<Array<HookResult & { command: string }>> {
    const results: Array<HookResult & { command: string }> = [];
    for (const hook of this.matching(name, subject)) {
      try {
        signal?.throwIfAborted();
        const result = await this.execute(hook, { hook: name, ...this.base, ...data }, signal);
        if (result.timedOut) this.warn(`Hook ${name} timed out: ${hook.command}`);
        else if (result.exitCode !== 0 && !(name === 'beforeTool' && result.exitCode === 2))
          this.warn(
            `Hook ${name} exited ${result.exitCode}: ${hook.command}${result.stderr ? `\n${result.stderr.trim()}` : ''}`,
          );
        results.push({ ...result, command: hook.command });
      } catch (error) {
        if (signal?.aborted) throw error;
        this.warn(`Hook ${name} failed to start: ${(error as Error).message}`);
        results.push({
          exitCode: null,
          stdout: '',
          stderr: (error as Error).message,
          timedOut: false,
          command: hook.command,
        });
      }
    }
    return results;
  }

  /** Concatenate stdout of successful hooks (for context injection). */
  async collect(name: HookName, data: Record<string, unknown>): Promise<string> {
    const results = await this.run(name, data);
    return results
      .filter((result) => result.exitCode === 0 && result.stdout.trim())
      .map((result) => result.stdout.trim())
      .join('\n\n');
  }

  /**
   * `beforeTool`: exit 2 or timeout blocks the call (stderr is the reason);
   * stdout `{"args": {...}}` replaces the arguments.
   */
  async beforeTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ blocked?: string; args: Record<string, unknown> }> {
    let current = args;
    for (const hook of this.matching('beforeTool', tool)) {
      let result: HookResult;
      try {
        result = await this.execute(
          hook,
          {
            hook: 'beforeTool',
            ...this.base,
            tool,
            args: current,
          },
          signal,
        );
      } catch (error) {
        return { blocked: `beforeTool hook failed: ${(error as Error).message}`, args: current };
      }
      if (result.timedOut) return { blocked: `beforeTool hook timed out: ${hook.command}`, args };
      if (result.exitCode === 2)
        return { blocked: result.stderr.trim() || `Blocked by hook: ${hook.command}`, args };
      if (result.exitCode !== 0) {
        this.warn(`Hook beforeTool exited ${result.exitCode}: ${hook.command}`);
        continue;
      }
      const out = result.stdout.trim();
      if (out.startsWith('{')) {
        try {
          const parsed = JSON.parse(out) as { args?: unknown };
          if (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
            current = parsed.args as Record<string, unknown>;
        } catch {
          this.warn(`Hook beforeTool printed invalid JSON: ${hook.command}`);
        }
      }
    }
    return { args: current };
  }
}
