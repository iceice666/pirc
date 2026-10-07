/** Synthetic runtime microbenchmark. Not model performance or production PTC. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPtcWorker } from '../apps/gateway/src/agent/ptc/worker.js';
import { runSpike } from '../apps/gateway/test/ptc-m1/spike.js';

if (process.argv[2] === 'legacy-worker') {
  await runPtcWorker(process.argv.slice(3));
} else {
  const dir = mkdtempSync(path.join(tmpdir(), 'pirc-ptc-spike-'));
  const file = path.join(dir, 'script.ts');
  const code = 'return await tools.call("echo", { value: 42 });';
  writeFileSync(file, `export default async function ({ tools }) { ${code} }`, { mode: 0o600 });
  const compiled = !/\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? '');
  const command = compiled ? [process.execPath] : [process.execPath, import.meta.path];
  const legacy = async () => {
    const started = performance.now();
    let value: unknown;
    const child = Bun.spawn([...command, 'legacy-worker', file], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir },
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
      ipc(message, child) {
        if (message.type === 'call') child.send({ id: message.id, result: { value: 42 } });
        if (message.type === 'result') value = JSON.parse(message.value);
      },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      if ((await child.exited) !== 0 || JSON.stringify(value) !== '{"value":42}')
        throw new Error('Legacy synthetic worker failed');
      return performance.now() - started;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const timings: Record<string, number[]> = { quickjs: [], legacy: [] };
    for (let i = 0; i < 20; i++) {
      const quickjs = await runSpike({ code, capabilities: { echo: async () => ({ value: 42 }) } });
      if (JSON.stringify(quickjs.value) !== '{"value":42}')
        throw new Error('QuickJS result mismatch');
      timings.quickjs!.push(quickjs.elapsedMs);
      timings.legacy!.push(await legacy());
    }
    const large = await runSpike({
      code: 'return (await tools.call("read")).length;',
      capabilities: { read: async () => 'x'.repeat(8 * 1024 * 1024) },
    });
    if (large.value !== 8 * 1024 * 1024) throw new Error('Large result mismatch');
    console.log(
      JSON.stringify(
        {
          kind: 'synthetic-runtime-only',
          trials: 20,
          compiled,
          bun: Bun.version,
          platform: process.platform,
          arch: process.arch,
          quickjsHeapMiB: 128,
          wasmBackingMiB: 256,
          largeFileBytes: large.value,
          timings: Object.fromEntries(
            Object.entries(timings).map(([name, values]) => {
              values.sort((a, b) => a - b);
              return [name, { p50Ms: values[9], p90Ms: values[17], maxMs: values[19] }];
            }),
          ),
          processMaxRss: process.resourceUsage().maxRSS,
          baselineModelMeasurements: null,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
