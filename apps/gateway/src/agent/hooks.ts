import type { HookConfig, HooksConfig } from './config.js';

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

  private matching(name: HookName, subject?: string): HookConfig[] {
    return this.hooks[name].filter((hook) => {
      if (!hook.matcher || subject === undefined) return true;
      try {
        return new RegExp(`^(?:${hook.matcher})$`).test(subject);
      } catch {
        return false;
      }
    });
  }

  private async execute(hook: HookConfig, payload: unknown): Promise<HookResult> {
    const child = Bun.spawn(['/bin/sh', '-c', hook.command], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, PIRC_HOOK: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify(payload));
    await child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, hook.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return {
      exitCode,
      stdout: stdout.slice(0, 65_536),
      stderr: stderr.slice(0, 16_384),
      timedOut,
    };
  }

  /** Run every matching hook in order; failures produce a warning but never throw. */
  async run(
    name: HookName,
    data: Record<string, unknown>,
    subject?: string,
  ): Promise<Array<HookResult & { command: string }>> {
    const results: Array<HookResult & { command: string }> = [];
    for (const hook of this.matching(name, subject)) {
      try {
        const result = await this.execute(hook, { hook: name, ...this.base, ...data });
        if (result.timedOut) this.warn(`Hook ${name} timed out: ${hook.command}`);
        else if (result.exitCode !== 0 && !(name === 'beforeTool' && result.exitCode === 2))
          this.warn(
            `Hook ${name} exited ${result.exitCode}: ${hook.command}${result.stderr ? `\n${result.stderr.trim()}` : ''}`,
          );
        results.push({ ...result, command: hook.command });
      } catch (error) {
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
  ): Promise<{ blocked?: string; args: Record<string, unknown> }> {
    let current = args;
    for (const hook of this.matching('beforeTool', tool)) {
      let result: HookResult;
      try {
        result = await this.execute(hook, {
          hook: 'beforeTool',
          ...this.base,
          tool,
          args: current,
        });
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
