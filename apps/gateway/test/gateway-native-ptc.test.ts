import { expect, test } from 'bun:test';
import { execute } from '../src/agent/ptc/runtime.js';
import { preflight } from '../src/agent/ptc/preflight.js';
import { gatewayPtcGuest } from '../src/gateway-runtime/ptc-guest.js';

const executable = process.env.PIRC_TEST_NATIVE_PTC;
const nativeTest = executable ? test : test.skip;
nativeTest(
  'real isolated native PTC batches dependencies and commits proposed stores',
  async () => {
    const compiled = preflight(
      'let n=load("n");for(let i=0;i<10;i++)n=(await tools.read({n})).n;store("n",n);return n;',
    );
    const report = await execute({
      code: compiled.js,
      broker: {
        manifest: new Set(compiled.manifest),
        isWrite: () => false,
        invoke: async (call) => ({
          ok: true,
          operationId: call.operationId,
          contractVersion: 1,
          data: { n: Number(call.args.n) + 1 },
          attachments: [],
          truncated: false,
        }),
      },
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 10_000,
      turnId: 'turn',
      executionId: 'script',
      store: '{"n":2}',
      launchGuest: gatewayPtcGuest(executable!),
    });
    expect(report.status).toBe('completed');
    expect(report.value).toBe('12');
    expect(report.store).toBe('{"n":12}');
    expect(report.storeRead).toBe(true);
    expect(report.summary.completed).toBe(10);
  },
  35_000,
);
nativeTest(
  'quick broker burst drains bounded guest replies without losing operations',
  async () => {
    const compiled = preflight(
      'return await Promise.all(Array.from({length:40},()=>tools.read({})));',
    );
    const report = await execute({
      code: compiled.js,
      broker: {
        manifest: new Set(compiled.manifest),
        isWrite: () => false,
        invoke: async (call) => ({
          ok: true,
          operationId: call.operationId,
          contractVersion: 1,
          data: { value: 1 },
          attachments: [],
          truncated: false,
        }),
      },
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 10_000,
      turnId: 'turn',
      executionId: 'burst',
      launchGuest: gatewayPtcGuest(executable!),
    });
    expect(report.status).toBe('completed');
    expect(report.summary.completed).toBe(40);
    expect(report.operations.every((op) => op.delivered)).toBe(true);
  },
  35_000,
);

nativeTest(
  'realm prototype poisoning cannot forge host idle frames to suspend busy budget',
  async () => {
    let listener: ((waiting: boolean) => void) | undefined;
    const code = preflight(
      'void tools.read({}); Object.prototype.toJSON=function(){return {type:"idle",received:0};}; console.log("poison"); while(true){}',
    ).js;
    const started = performance.now();
    const report = await execute({
      code,
      broker: {
        manifest: new Set(['read']),
        isWrite: () => false,
        invoke: async (call) => {
          listener?.(true);
          await new Promise<void>((resolve) => {
            call.signal.addEventListener('abort', () => resolve(), { once: true });
            if (call.signal.aborted) resolve();
          });
          return {
            ok: false,
            contractVersion: 1,
            operationId: call.operationId,
            error: { code: 'Cancelled', message: 'cancelled', outcome: 'not_started' },
          };
        },
      },
      onHumanWait: (fn) => {
        listener = fn;
        return () => {};
      },
      signal: AbortSignal.timeout(5000),
      timeoutMs: 500,
      turnId: 'turn',
      executionId: 'poison',
      launchGuest: gatewayPtcGuest(executable!),
    });
    expect(report.status).toBe('timed_out');
    expect(performance.now() - started).toBeLessThan(4000);
  },
  10_000,
);
nativeTest(
  'real isolated native PTC cannot acquire ambient APIs and busy guest is killed',
  async () => {
    const launchGuest = gatewayPtcGuest(executable!);
    const broker = {
      manifest: new Set<string>(),
      isWrite: () => false,
      invoke: async () => {
        throw new Error('No capabilities');
      },
    };
    const report = await execute({
      code: preflight('return [typeof process,typeof Bun,typeof globalThis.require,typeof fetch];')
        .js,
      broker,
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 10_000,
      turnId: 'turn',
      executionId: 'none',
      launchGuest,
    });
    expect(report.status).toBe('completed');
    expect(JSON.parse(report.value!)).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
    const busy = await execute({
      code: preflight('while(true){}').js,
      broker,
      signal: AbortSignal.timeout(30_000),
      timeoutMs: 300,
      turnId: 'turn',
      executionId: 'busy',
      launchGuest,
    });
    expect(busy.status).toBe('timed_out');
  },
  35_000,
);
