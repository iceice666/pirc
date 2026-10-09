import { expect, test } from 'bun:test';
import { GatewayWorkerProcess } from '../src/gateway-runtime/worker-process.js';
import { execute } from '../src/agent/ptc/runtime.js';
import { preflight } from '../src/agent/ptc/preflight.js';
import { gatewayPtcGuest } from '../src/gateway-runtime/ptc-guest.js';
const executable = process.env.PIRC_TEST_NATIVE_PTC;
const nativeTest = executable ? test : test.skip;
nativeTest(
  'native PTC denies a ninth worker and restores all eight slots after close',
  async () => {
    const workers: GatewayWorkerProcess[] = [];
    try {
      for (let i = 0; i < 8; i++)
        workers.push(new GatewayWorkerProcess({ executable: executable!, protocol: 'ptc' }));
      expect(() => new GatewayWorkerProcess({ executable: executable!, protocol: 'ptc' })).toThrow(
        'Global worker quota',
      );
      await Promise.all(workers.map((worker) => worker.guestChannel(AbortSignal.timeout(10000))));
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
    const replacements: GatewayWorkerProcess[] = [];
    try {
      for (let i = 0; i < 8; i++)
        replacements.push(new GatewayWorkerProcess({ executable: executable!, protocol: 'ptc' }));
      await Promise.all(
        replacements.map((worker) => worker.guestChannel(AbortSignal.timeout(10000))),
      );
    } finally {
      await Promise.all(replacements.map((worker) => worker.close()));
    }
  },
  30000,
);
nativeTest(
  'native PTC rejects an over-RSS worker at admission or during supervision',
  async () => {
    const worker = new GatewayWorkerProcess({
      executable: executable!,
      protocol: 'ptc',
      maxRssBytes: 1,
    });
    try {
      const lifetime = async () => {
        const channel = await worker.guestChannel(AbortSignal.timeout(10000));
        await channel.receive();
      };
      // Darwin checks RSS at admission; Linux also supervises the admitted PID.
      await expect(lifetime()).rejects.toThrow('quota');
    } finally {
      await worker.close();
    }
  },
  15000,
);
nativeTest(
  'native PTC allocation-loop failure or timeout releases its admitted worker slot',
  async () => {
    const held: GatewayWorkerProcess[] = [];
    try {
      for (let i = 0; i < 7; i++)
        held.push(new GatewayWorkerProcess({ executable: executable!, protocol: 'ptc' }));
      await Promise.all(held.map((worker) => worker.guestChannel(AbortSignal.timeout(15000))));
      const compiled = preflight(
        'console.log("allocation-admitted");const arrays=[];while(true)arrays.push(new Array(1000000).fill("large"));',
      );
      const report = await execute({
        code: compiled.js,
        broker: {
          manifest: new Set<string>(),
          isWrite: () => false,
          invoke: async () => {
            throw new Error('No capabilities');
          },
        },
        signal: AbortSignal.timeout(15000),
        timeoutMs: 2000,
        turnId: 'resource',
        executionId: 'resource',
        launchGuest: gatewayPtcGuest(executable!),
      });
      expect(report.console).toContain('allocation-admitted');
      expect(report.status).not.toBe('completed');
      const replacement = new GatewayWorkerProcess({ executable: executable!, protocol: 'ptc' });
      try {
        await replacement.guestChannel(AbortSignal.timeout(10000));
      } finally {
        await replacement.close();
      }
    } finally {
      await Promise.all(held.map((worker) => worker.close()));
    }
  },
  20000,
);
