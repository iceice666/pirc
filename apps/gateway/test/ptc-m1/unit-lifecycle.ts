/** Bounded systemd control for test-only measurement units; no shell interpolation. */
import { spawn } from 'node:child_process';
const unitPattern = /^ptc-m1-[a-f0-9-]+\.service$/;
export async function unitCommand(args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
      reject(new Error('Evaluation unit control timeout'));
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      output += data.toString();
      if (output.length > 4096) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Evaluation unit control unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('Evaluation unit control failed'));
      else resolve(output.trim());
    });
  });
}
export async function stopUnit(unit: string): Promise<void> {
  if (!unitPattern.test(unit)) throw new Error('Invalid evaluation unit');
  try {
    await unitCommand(['stop', unit]);
  } catch {
    await unitCommand(['kill', '--signal=SIGKILL', '--kill-whom=all', unit]).catch(() => undefined);
  }
  // Unit disappearance is legitimate with --collect, but an active unit is never success.
  const state = await unitCommand(['show', unit, '--property=ActiveState', '--value']);
  if (!['inactive', 'failed'].includes(state)) throw new Error('Evaluation unit still active');
}
