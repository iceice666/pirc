import { describe, expect, test } from 'bun:test';
import { runSpike, SPIKE_LIMITS } from './ptc-m1/spike.js';

describe('PTC M1 isolation experiment (not production runtime)', () => {
  test('async JSON bridge, TypeScript stripping and large-file reduction', async () => {
    const result = await runSpike({
      code: 'const file: string = await tools.call("read", {}); return file.length;',
      capabilities: { read: async () => 'x'.repeat(4 * 1024 * 1024) },
    });
    expect(result.value).toBe(4 * 1024 * 1024);
    expect(result.calls).toBe(1);
  });

  test('ambient authority and constructor chains stay in the realm', async () => {
    const result = await runSpike({
      code: `return [typeof Bun, typeof process, typeof globalThis.require, typeof fetch,
        typeof WebAssembly, typeof __call,
        (() => {}).constructor('return typeof process')(),
        await tools.call.constructor('return typeof Bun')(),
        Object.constructor('return typeof process')(),
        await tools.call('echo', {x: 1})];`,
      capabilities: { echo: async (args) => args },
    });
    expect(result.value).toEqual([...Array(9).fill('undefined'), { x: 1 }]);
  });

  test('dynamic imports cannot load host modules', async () => {
    expect(
      (
        await runSpike({
          code: 'try { await import("node:fs"); return false; } catch { return true; }',
        })
      ).value,
    ).toBe(true);
  });

  test('host prototype names never become capabilities', async () => {
    await expect(runSpike({ code: 'return await tools.call("constructor");' })).rejects.toThrow(
      'CapabilityUnavailable',
    );
  });

  test('pending calls reserve concurrency quota before completion', async () => {
    let dispatched = 0;
    await expect(
      runSpike({
        code: 'return await Promise.all(Array.from({length: 9}, () => tools.call("wait")));',
        capabilities: {
          wait: async () => {
            dispatched++;
            return new Promise(() => {});
          },
        },
      }),
    ).rejects.toThrow('QuotaExceeded');
    expect(dispatched).toBeLessThanOrEqual(8);
  });

  test('cancel suspended call and ignore its late result', async () => {
    const controller = new AbortController();
    let complete!: (value: unknown) => void;
    let childSignal!: AbortSignal;
    const result = runSpike({
      code: 'return await tools.call("wait");',
      signal: controller.signal,
      capabilities: {
        wait: async (_args, signal) => {
          childSignal = signal;
          queueMicrotask(() => controller.abort());
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
      },
    });
    await expect(result).rejects.toThrow('Cancelled');
    expect(childSignal.aborted).toBe(true);
    complete('late');
    await Bun.sleep(1);
  });

  test('deadline stops suspended calls and CPU loops', async () => {
    await expect(
      runSpike({
        code: 'await tools.call("wait");',
        timeoutMs: 100,
        capabilities: { wait: async () => new Promise(() => {}) },
      }),
    ).rejects.toThrow('Timeout');
    await expect(runSpike({ code: 'while (true) {}', timeoutMs: 100 })).rejects.toThrow();
  });

  test('cleanup never invokes guest-controlled global setters', async () => {
    const result = await runSpike({
      code: `Object.defineProperty(globalThis, 'tools', { set() { throw new Error('cleanup executed guest code'); } }); return 42;`,
    });
    expect(result.value).toBe(42);
  });

  test('pre-aborted scripts never dispatch', async () => {
    let dispatched = false;
    await expect(
      runSpike({
        code: 'await tools.call("write");',
        signal: AbortSignal.abort(),
        capabilities: {
          write: async () => {
            dispatched = true;
          },
        },
      }),
    ).rejects.toThrow('Cancelled');
    expect(dispatched).toBe(false);
  });

  test('total calls, source, output and realm memory are bounded', async () => {
    await expect(
      runSpike({
        code: 'for (let i = 0; i < 201; i++) await tools.call("noop");',
        capabilities: { noop: async () => null },
      }),
    ).rejects.toThrow('QuotaExceeded');
    await expect(runSpike({ code: ' '.repeat(SPIKE_LIMITS.sourceBytes + 1) })).rejects.toThrow(
      'QuotaExceeded',
    );
    await expect(runSpike({ code: 'return "x".repeat(51201);' })).rejects.toThrow('QuotaExceeded');
    await expect(
      runSpike({ code: 'return new ArrayBuffer(256 * 1024 * 1024);' }),
    ).rejects.toThrow();
  });

  test('independent WASM instances support overlapping asynchronous executions', async () => {
    const results = await Promise.all(
      [1, 2].map((value) =>
        runSpike({
          code: 'return await tools.call("value");',
          capabilities: {
            value: async () => {
              await Bun.sleep(5);
              return value;
            },
          },
        }),
      ),
    );
    expect(results.map((result) => result.value)).toEqual([1, 2]);
  });
});
