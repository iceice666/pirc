/** Same-process first-triplet checkpoint. Approval never restarts a budget or replays rows. */
import { randomBytes } from 'node:crypto';
import { constants, closeSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createArtifact, checkpoint } from './artifacts.js';
export async function waitForOpenAIStage(options: {
  prefix: string;
  signal: AbortSignal;
  evidence: unknown;
  timeoutMs?: number;
  intervalMs?: number;
  onReady?: () => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  const approvalPath = `${options.prefix}.approve.json`;
  try {
    await lstat(approvalPath);
    throw new Error('Stage approval already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const nonce = randomBytes(24).toString('hex');
  const fd = createArtifact(`${options.prefix}.pending.json`);
  try {
    checkpoint(fd, {
      kind: 'openai-first-triplet',
      status: 'waiting',
      nonce,
      evidence: options.evidence,
    });
  } finally {
    closeSync(fd);
  }
  options.onReady?.();
  const deadline = performance.now() + (options.timeoutMs ?? 24 * 60 * 60_000);
  while (true) {
    options.signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('OpenAI stage approval timeout');
    try {
      const file = await open(
        approvalPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 1024 ||
          (stat.mode & 0o077) !== 0 ||
          stat.uid !== process.getuid?.()
        )
          throw new Error('Invalid stage approval file');
        const value = JSON.parse(await file.readFile('utf8'));
        if (value.nonce !== nonce || value.action !== 'continue')
          throw new Error('Invalid stage approval');
        options.signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('OpenAI stage approval timeout');
        const accepted = createArtifact(`${options.prefix}.accepted.json`);
        try {
          checkpoint(accepted, { kind: 'openai-first-triplet', status: 'accepted', nonce });
        } finally {
          closeSync(accepted);
        }
        return;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('OpenAI stage cancelled'));
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener('abort', abort);
        resolve();
      }, options.intervalMs ?? 1000);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }
}
