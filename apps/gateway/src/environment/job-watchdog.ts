import { spawn } from 'node:child_process';
import { killGroup } from '../agent/tools/bash.js';
import { createReadStream } from 'node:fs';

/** Detached job-group leader. Only executor owns the fd3 writer; shells never inherit it. */
export async function runJobWatchdog(): Promise<void> {
  const command = process.argv[2],
    cwd = process.argv[3];
  if (!cwd || !command || process.env.PIRC_SANDBOX !== 'srt')
    throw new Error('Invalid background watchdog');
  const child = spawn('/bin/bash', ['-c', command], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.on('SIGTERM', () => {
    killGroup(child.pid, 'SIGKILL');
    process.exit(143);
  });
  // FD3 is a read-only pipe from the executor; it is not among the shell's inherited FDs.
  const stream = createReadStream('', { fd: 3, autoClose: true });
  void (async () => {
    try {
      for await (const _ of stream) {
        /* no data expected */
      }
    } finally {
      killGroup(child.pid, 'SIGKILL');
      process.exit(1);
    }
  })();
  const code = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  // The watchdog owns this separate shell group and fences leftovers itself.
  killGroup(child.pid, 'SIGKILL');
  process.exit(code);
}
