import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { waitForOpenAIStage } from './ptc-m1/openai-stage.js';
for (const mode of ['approve', 'wrong', 'symlink', 'fifo', 'cancel', 'timeout'] as const)
  test(`first triplet stage ${mode} fails closed except bound approval`, async () => {
    const root = await mkdtemp('/tmp/ptc-stage-'),
      prefix = `${root}/stage`;
    const signal = new AbortController();
    let ready!: () => void;
    const pending = new Promise<void>((r) => (ready = r));
    const wait = waitForOpenAIStage({
      prefix,
      signal: signal.signal,
      evidence: { trials: 3 },
      onReady: ready,
      timeoutMs: mode === 'timeout' ? 30 : 1000,
      intervalMs: 5,
    });
    // Observe rejection immediately, but assert its outcome below.
    const settled = wait.then(
      () => ({ ok: true, error: '' }),
      (error) => ({ ok: false, error: String(error) }),
    );
    try {
      await pending;
      const stage = JSON.parse(await readFile(`${prefix}.pending.json`, 'utf8'));
      if (mode === 'cancel') signal.abort();
      else if (mode === 'symlink') {
        await writeFile(
          `${root}/target`,
          JSON.stringify({ nonce: stage.nonce, action: 'continue' }),
          { mode: 0o600 },
        );
        await symlink(`${root}/target`, `${prefix}.approve.json`);
      } else if (mode === 'fifo') {
        const made = Bun.spawnSync(['mkfifo', `${prefix}.approve.json`]);
        expect(made.exitCode).toBe(0);
      } else if (mode !== 'timeout')
        await writeFile(
          `${prefix}.approve.json`,
          JSON.stringify({ nonce: mode === 'wrong' ? 'wrong' : stage.nonce, action: 'continue' }),
          { mode: 0o600, flag: 'wx' },
        );
      const result = await settled;
      expect(result.ok).toBe(mode === 'approve');
      if (mode === 'approve')
        expect(JSON.parse(await readFile(`${prefix}.accepted.json`, 'utf8')).status).toBe(
          'accepted',
        );
    } finally {
      signal.abort();
      await settled;
      await rm(root, { recursive: true, force: true });
    }
  });
