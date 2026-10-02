/**
 * The srt (Anthropic's sandbox-runtime) built into pirc-node and pirc-chat,
 * run as `pirc-node srt …` (plans/sandbox.md). A node uses it unless
 * PIRC_SANDBOX_SRT names an external srt, as the Nix package does.
 *
 * srt's CLI is imported as is (patches/ only makes its manifest bundleable).
 * On Linux it also needs its static `apply-seccomp` helper, which it looks up
 * next to its own files; inside a compiled binary there are none, so the
 * node writes the embedded copy to its state and names it in the settings.
 * bubblewrap, socat and ripgrep still come from the host.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import seccompArm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp' with { type: 'file' };
import seccompX64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp' with { type: 'file' };

/** `pirc-node srt …`: srt's own CLI, with the arguments after `srt`. */
export async function runSrt(): Promise<void> {
  await import('@anthropic-ai/sandbox-runtime/dist/cli.js');
}

/**
 * Linux: write the embedded `apply-seccomp` for this CPU into `dir` (once per
 * content) and return its path. Elsewhere, or on a CPU srt has no helper
 * for, undefined.
 */
export function embeddedSeccomp(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== 'linux') return undefined;
  const source = arch === 'x64' ? seccompX64 : arch === 'arm64' ? seccompArm64 : undefined;
  if (!source) return undefined;
  const data = readFileSync(source);
  const digest = createHash('sha256').update(data).digest('hex');
  const target = path.join(dir, `apply-seccomp-${arch}-${digest.slice(0, 16)}`);
  const current = existsSync(target)
    ? createHash('sha256').update(readFileSync(target)).digest('hex')
    : undefined;
  if (current !== digest) {
    mkdirSync(dir, { recursive: true, mode: 0o711 });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, data, { mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  }
  return target;
}
