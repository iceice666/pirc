/**
 * Stops busy ptc scripts (a loop on cancel and on timeout, and a
 * backtracking regular expression QuickJS cannot interrupt), then reports
 * whether their processes are gone and the CPU time this process used over
 * the next 500 ms. Run with BUN_JSC_useOMGJIT=0 so JavaScriptCore's one-time
 * background tier-up compile is not measured instead.
 */
import { preflight } from '../../src/agent/ptc/preflight.js';
import { execute } from '../../src/agent/ptc/runtime.js';

const broker = {
  manifest: new Set<string>(),
  isWrite: () => false,
  invoke: async () => {
    throw new Error('unused');
  },
};
const statuses: string[] = [];
const pids: number[] = [];
for (const [by, code] of [
  ['cancel', 'for (;;) {}'],
  ['timeout', 'for (;;) {}'],
  ['timeout', `return /^(a+)+$/.test('a'.repeat(60) + 'b');`],
] as const) {
  const controller = new AbortController();
  if (by === 'cancel') setTimeout(() => controller.abort(), 200);
  const report = await execute({
    code: preflight(code).js,
    broker,
    signal: controller.signal,
    timeoutMs: by === 'timeout' ? 200 : 60_000,
    turnId: 't',
    executionId: by,
    onProcess: (pid) => pids.push(pid),
  });
  statuses.push(report.status);
}
const alive = pids.filter((pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
});
await Bun.sleep(100);
const before = process.cpuUsage();
await Bun.sleep(500);
const used = process.cpuUsage(before);
console.log(
  JSON.stringify({
    statuses,
    started: pids.length,
    alive,
    cpuMs: (used.user + used.system) / 1000,
  }),
);
process.exit(0);
