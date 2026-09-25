import { truncateOutput } from '../sandbox.js';
import { optionalNumber, requireString, text, type Tool } from './types.js';

/** Kill a detached child's whole process group, then the child itself. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export interface ShellResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

/** Run a shell command in its own process group with timeout, abort and output cap. */
export async function runShell(
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
    onOutput?: (text: string) => void;
  },
): Promise<ShellResult> {
  const child = Bun.spawn(['/bin/bash', '-c', command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let output = '';
  let captured = 0;
  const cap = options.maxBytes * 4;
  let timedOut = false;
  let aborted = false;
  const stop = () => {
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const piece = decoder.decode(chunk, { stream: true });
      // Keep a bounded head+tail window; the final truncation trims to maxBytes.
      output += piece;
      captured += chunk.byteLength;
      if (output.length > cap) output = output.slice(0, cap / 2) + output.slice(-cap / 2);
      options.onOutput?.(output);
    }
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  const exitCode = await child.exited;
  // Shell exited; make sure orphaned descendants cannot linger.
  killGroup(child.pid, 'SIGKILL');
  clearTimeout(timer);
  options.signal.removeEventListener('abort', onAbort);
  const cut = truncateOutput(output, options.maxBytes);
  return {
    output: cut.text,
    exitCode: timedOut || aborted ? null : exitCode,
    timedOut,
    aborted,
    truncated: cut.truncated || captured > Buffer.byteLength(output),
  };
}

export const bashTool: Tool = {
  name: 'bash',
  ptc: true,
  description:
    'Run a bash command in the workspace. stdout and stderr are combined. Default timeout 120s (`timeout` in seconds). Use background_task for long-running processes.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number', description: 'Timeout in seconds' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const command = requireString(args, 'command');
    const seconds = optionalNumber(args, 'timeout');
    const result = await runShell(command, {
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: seconds ? Math.min(seconds * 1000, 3_600_000) : ctx.config.limits.bashTimeoutMs,
      maxBytes: ctx.config.limits.toolOutputBytes,
      signal: ctx.signal,
      onOutput: (output) => ctx.update(text(output)),
    });
    const status = result.timedOut
      ? '[timed out]'
      : result.aborted
        ? '[aborted]'
        : `[exit ${result.exitCode}]`;
    const body = `${result.output}${result.output.endsWith('\n') || !result.output ? '' : '\n'}${status}`;
    return text(
      body,
      { exitCode: result.exitCode, truncated: result.truncated },
      result.exitCode !== 0,
    );
  },
};
