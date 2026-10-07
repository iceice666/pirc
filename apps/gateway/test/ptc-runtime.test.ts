/**
 * The PTC execution engine (src/agent/ptc): preflight, the QuickJS realm, the
 * SDK, quotas, cancellation and the completion summary, against a fake
 * broker. Agent integration is covered by agent-ptc.test.ts.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BUDGETS, CONTRACT_VERSION, PtcError, type Result } from '../src/agent/ptc/contracts.js';
import { preflight } from '../src/agent/ptc/preflight.js';
import { CapabilityRegistry, isWriteCall } from '../src/agent/ptc/registry.js';
import { execute, type Broker, type BrokerCall } from '../src/agent/ptc/runtime.js';
import { validateSchema } from '../src/agent/ptc/schema.js';
import { ATTACHMENT_LIMITS, Attachments } from '../src/agent/ptc/attachments.js';
import type { Tool } from '../src/agent/tools/types.js';

const ok = (call: BrokerCall, text: string): Result => ({
  ok: true,
  contractVersion: CONTRACT_VERSION,
  operationId: call.operationId,
  data: { text },
  attachments: [],
  truncated: false,
});

type Handler = (call: BrokerCall) => Promise<Result> | Result;

async function run(
  code: string,
  handlers: Record<string, Handler> = {},
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    writes?: string[];
    onHumanWait?: (listener: (waiting: boolean) => void) => () => void;
    onProgress?: () => void;
  } = {},
) {
  const compiled = preflight(code);
  const calls: BrokerCall[] = [];
  const broker: Broker = {
    manifest: new Set(compiled.manifest),
    isWrite: (name) => (options.writes ?? []).includes(name),
    invoke: async (call) => {
      calls.push(call);
      const handler = handlers[call.name];
      if (!handler) throw new Error(`no handler for ${call.name}`);
      await call.claimSlot(call.name, call.args);
      return handler(call);
    },
  };
  const report = await execute({
    code: compiled.js,
    broker,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 10_000,
    turnId: 'turn',
    executionId: 'exec',
    ...(options.onHumanWait ? { onHumanWait: options.onHumanWait } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return { report, calls, manifest: compiled.manifest };
}

const value = (report: { value?: string; valueIsString?: boolean }) =>
  report.valueIsString ? report.value : JSON.parse(report.value ?? 'null');
const echo: Handler = (call) => ok(call, JSON.stringify(call.args));

describe('preflight: literal capability names', () => {
  test('derives the manifest from member calls and tools.call literals', () => {
    const { manifest } = preflight(
      'const a: string = (await tools.read({ path: "x" })).text;\n' +
        'await tools.call("grep", { pattern: `a` });\n' +
        'await tools.par([1], async () => tools.ls({}));\n' +
        'return `${(await tools.bash({ command: "x" })).text}`;',
    );
    expect(manifest).toEqual(['read', 'grep', 'ls', 'bash']);
  });

  const rejected: Array<[string, string]> = [
    ['return await tools[name]({});', 'computed'],
    ['return await tools["read"]({});', 'write tools.read'],
    ['const n = "read"; return await tools.call(n, {});', 'string literal'],
    ['return await tools.call("re" + "ad", {});', 'string literal'],
    ['const t = tools; return t.read({});', 'used directly'],
    ['const { read } = tools; return read({});', 'used directly'],
    ['const call = tools.call; return call("read");', 'called directly'],
    ['const tools = { read() {} }; return tools.read();', 'used directly'],
    ['return [tools].length;', 'used directly'],
    ['return ((tools) => tools.read({}))({});', 'used directly'],
    ['return { tools };', 'used directly'],
  ];
  for (const [code, why] of rejected)
    test(`rejects ${code}`, () => {
      expect(() => preflight(code)).toThrow(why);
      try {
        preflight(code);
      } catch (error) {
        expect((error as PtcError).code).toBe('InvalidArguments');
      }
    });

  test('allows property names and object keys that merely spell "tools"', () => {
    expect(
      preflight('const x = { tools: 1 }; return x.tools + ({ tools: 2 }).tools;').manifest,
    ).toEqual([]);
  });

  test('rejects empty, oversized and syntactically broken scripts, and wrapper escapes', () => {
    for (const code of [
      '',
      '   ',
      'return (;',
      '}); globalThis.x = 1; (async () => {',
      '} function x() {',
    ])
      expect(() => preflight(code)).toThrow(PtcError);
    expect(() => preflight('x'.repeat(BUDGETS.sourceBytes + 1))).toThrow('exceeds');
  });
});

describe('the QuickJS realm', () => {
  test('runs TypeScript, returns values and captures bounded console output', async () => {
    const { report } = await run(
      'const xs: number[] = [1, 2, 3]; console.log("sum", xs.reduce((a, b) => a + b)); console.warn({ ok: true }); return { n: xs.length };',
    );
    expect(report.status).toBe('completed');
    expect(value(report)).toEqual({ n: 3 });
    expect(report.console).toBe('sum 6\n[warn] {"ok":true}\n');
    const flood = await run(
      'for (let i = 0; i < 100000; i++) console.log("x".repeat(100)); return 1;',
    );
    expect(flood.report.consoleTruncated).toBe(true);
    expect(Buffer.byteLength(flood.report.console)).toBeLessThanOrEqual(BUDGETS.consoleBytes);
  });

  test('strings are returned as is; undefined returns nothing', async () => {
    const text = await run('return "a\\nb";');
    expect(text.report.valueIsString).toBe(true);
    expect(text.report.value).toBe('a\nb');
    expect((await run('let x = 1;')).report.value).toBeUndefined();
  });

  test('has no ambient authority: no Bun, process, require, fetch, imports or timers', async () => {
    // `typeof require` itself would be folded by the TypeScript stripper; ask the realm.
    const { report } =
      await run(`return [typeof Bun, typeof process, typeof globalThis.require, typeof fetch,
      typeof setTimeout, typeof WebAssembly, typeof __ptc, typeof __call, typeof Deno,
      typeof globalThis.__ptc, (() => {}).constructor('return typeof process')(),
      Object.constructor('return typeof Bun')(),
      Function('return typeof globalThis.__ptc')()];`);
    expect(value(report)).toEqual(Array(13).fill('undefined'));
    const imported = await run(
      'try { await import("node:fs"); return "loaded"; } catch (e) { return "refused"; }',
    );
    expect(value(imported.report)).toBe('refused');
  });

  test('the SDK object cannot be replaced or extended', async () => {
    // The literal check forbids touching `tools` like this; reflection still cannot change it.
    const { report } = await run(
      `
      const sdk = () => (globalThis as any)["to" + "ols"];
      const before = Object.keys(sdk()).sort();
      try { sdk().read = () => 'forged'; } catch {}
      try { sdk().evil = 1; } catch {}
      try { (globalThis as any)["to" + "ols"] = {}; } catch {}
      try { Object.defineProperty(globalThis, "to" + "ols", { value: {} }); } catch {}
      try { (Object.prototype as any).call = () => 'polluted'; } catch {}
      return { frozen: Object.isFrozen(sdk()), before, after: Object.keys(sdk()).sort(),
        proto: Object.getPrototypeOf(sdk()), text: (await tools.read({})).text };`,
      { read: (call) => ok(call, 'real') },
    );
    expect(value(report)).toEqual({
      frozen: true,
      before: ['call', 'par', 'read'],
      after: ['call', 'par', 'read'],
      proto: null,
      text: 'real',
    });
  });

  test('dispatch outside the manifest is refused at run time', async () => {
    // Reflective access reaches the SDK object, but only manifest names dispatch.
    const { report, calls } = await run(
      `const t = (globalThis as any)["to" + "ols"];
       const results = [];
       for (const name of ['bash', 'constructor', '__proto__', 'toString', 'ptc', 'ptc_docs', 'code'])
         results.push((await t.call(name, {})).error.code);
       try { await t.call(42, {}); } catch (e) { results.push(e.code); }
       return results;`,
    );
    expect(value(report)).toEqual([...Array(7).fill('CapabilityUnavailable'), 'InvalidArguments']);
    expect(calls).toHaveLength(0);
  });

  test('malformed bridge input becomes typed errors, never host exceptions', async () => {
    const { report, calls } = await run(
      `const out = [];
       out.push((await tools.call("echo", [1, 2])).error.code);
       out.push((await tools.call("echo", "text")).error.code);
       out.push((await tools.call("echo", null)).error.code);
       try { await tools.call("echo", { big: 1n }); } catch (e) { out.push(e.code); }
       const cyclic: any = {}; cyclic.self = cyclic;
       try { await tools.echo(cyclic); } catch (e) { out.push(e.code); }
       out.push((await tools.call("echo", { s: "x".repeat(${BUDGETS.argsBytes}) })).error.code);
       out.push((await tools.call("echo", { fn: () => 1, u: undefined })).data.text);
       return out;`,
      { echo },
    );
    expect(value(report)).toEqual([
      'InvalidArguments',
      'InvalidArguments',
      'InvalidArguments',
      'InvalidArguments',
      'InvalidArguments',
      'QuotaExceeded',
      '{}',
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe('SDK semantics', () => {
  test('convenience calls throw PtcError with code, outcome and operation id; call returns envelopes', async () => {
    const { report } = await run(
      `const raw = await tools.call("fail", {});
       try { await tools.fail({}); return "no throw"; }
       catch (e) { return { raw: raw.ok, code: e.code, name: e.name, outcome: e.outcome,
         op: typeof e.operationId, isPtc: e instanceof PtcError, message: e.message }; }`,
      {
        fail: (call) => ({
          ok: false,
          contractVersion: 1,
          operationId: call.operationId,
          error: { code: 'ApprovalDenied', message: 'no', outcome: 'not_started' },
        }),
      },
    );
    expect(value(report)).toEqual({
      raw: false,
      code: 'ApprovalDenied',
      name: 'ApprovalDenied',
      outcome: 'not_started',
      op: 'string',
      isPtc: true,
      message: 'no',
    });
  });

  test('an uncaught PtcError fails the execution with its code; other errors are ScriptError', async () => {
    const denied = await run('await tools.fail({});', {
      fail: (call) => ({
        ok: false,
        contractVersion: 1,
        operationId: call.operationId,
        error: { code: 'ApprovalDenied', message: 'declined', outcome: 'not_started' },
      }),
    });
    expect(denied.report.status).toBe('failed');
    expect(denied.report.error).toEqual({ code: 'ApprovalDenied', message: 'declined' });
    const thrown = await run('throw new TypeError("boom");');
    expect(thrown.report.error?.code).toBe('ScriptError');
    expect(thrown.report.error?.message).toContain('TypeError: boom');
    const forged = await run('throw new PtcError({ code: "Root", message: "x" });');
    expect(forged.report.error?.code).toBe('ScriptError');
    const value = await run('throw 42;');
    expect(value.report.error).toEqual({ code: 'ScriptError', message: 'Uncaught 42' });
  });

  test('tools.par keeps order, bounds concurrency and validates its options', async () => {
    let inFlight = 0;
    let peak = 0;
    const { report } = await run(
      'return await tools.par([1, 2, 3, 4, 5, 6], async (n) => Number((await tools.slow({ n })).text), { concurrency: 2 });',
      {
        slow: async (call) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(5 * (7 - Number(call.args.n)));
          inFlight--;
          return ok(call, String(Number(call.args.n) * 10));
        },
      },
    );
    expect(value(report)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
    for (const bad of ['0', '9', '1.5', '"2"']) {
      const result = await run(
        `try { await tools.par([1], async () => 1, { concurrency: ${bad} }); } catch (e) { return e.code; }`,
      );
      expect(value(result.report)).toBe('InvalidArguments');
    }
    const notArray = await run(
      'try { await tools.par("ab", async () => 1); } catch (e) { return e.code; }',
    );
    expect(value(notArray.report)).toBe('InvalidArguments');
  });

  test('a failing par item stops dequeuing, cancels in-flight siblings and joins them before throwing', async () => {
    const signals: AbortSignal[] = [];
    const started: number[] = [];
    let joined = 0;
    const { report } = await run(
      `try {
         await tools.par([1, 2, 3, 4, 5], async (n) => (await tools.step({ n })).text, { concurrency: 2 });
       } catch (e) { return { code: e.code, message: e.message }; }`,
      {
        step: async (call) => {
          const n = Number(call.args.n);
          started.push(n);
          if (n === 1) {
            await Bun.sleep(10);
            return {
              ok: false,
              contractVersion: 1,
              operationId: call.operationId,
              error: { code: 'OperationFailed', message: 'step 1 failed', outcome: 'failed' },
            };
          }
          signals.push(call.signal);
          await new Promise((resolve) => call.signal.addEventListener('abort', resolve));
          joined++;
          return {
            ok: false,
            contractVersion: 1,
            operationId: call.operationId,
            error: { code: 'Cancelled', message: 'cancelled', outcome: 'cancelled' },
          };
        },
      },
    );
    expect(value(report)).toEqual({ code: 'OperationFailed', message: 'step 1 failed' });
    expect(started.sort()).toEqual([1, 2]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(joined).toBe(1);
    expect(report.summary).toMatchObject({ total: 2, failed: 1, cancelled: 1, unknown: 0 });
    const par = report.trace.filter((node) => node.type === 'par');
    expect(par.map((node) => node.status)).toEqual(['running', 'failed']);
  });

  test('a failing par cancels only its own operations, not work started beside it', async () => {
    const aborted: string[] = [];
    const slow: Handler = (call) =>
      new Promise<Result>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          done = true;
          resolve(ok(call, `${call.args.tag} done`));
        }, 60);
        call.signal.addEventListener('abort', () => {
          if (done) return;
          clearTimeout(timer);
          aborted.push(String(call.args.tag));
          resolve({
            ok: false,
            contractVersion: 1,
            operationId: call.operationId,
            error: { code: 'Cancelled', message: 'cancelled', outcome: 'cancelled' },
          });
        });
      });
    const bad: Handler = async (call) => {
      await Bun.sleep(10);
      return {
        ok: false,
        contractVersion: 1,
        operationId: call.operationId,
        error: { code: 'OperationFailed', message: 'bad', outcome: 'failed' },
      };
    };
    const { report } = await run(
      `const outside = tools.slow({ tag: 'outside' });
       const sibling = tools.par([1], async () => (await tools.slow({ tag: 'sibling-par' })).text);
       const failing = tools.par([1, 2], async (n) => n === 1 ? tools.bad({}) : tools.slow({ tag: 'inside' }));
       let code;
       try { await failing; } catch (e) { code = e.code; }
       return [code, (await outside).text, (await sibling)[0]];`,
      { slow, bad },
    );
    expect(value(report)).toEqual(['OperationFailed', 'outside done', 'sibling-par done']);
    expect(aborted).toEqual(['inside']);
    // The trace parents follow ownership.
    const parents = Object.fromEntries(
      report.trace
        .filter((item) => item.type === 'par' && item.status === 'running')
        .map((item) => [item.nodeId, item.parentNodeId]),
    );
    expect(Object.values(parents)).toEqual(['exec:root', 'exec:root']);
  });

  test('after a par fails, its siblings cannot start new operations', async () => {
    const started: string[] = [];
    const { report } = await run(
      `try {
         await tools.par([1, 2], async (n) => {
           if (n === 1) { await tools.fail({}); return; }
           await tools.step({ tag: 'first' });
           await tools.step({ tag: 'second' });
         });
       } catch (e) { return e.code; }`,
      {
        fail: async (call) => {
          await Bun.sleep(5);
          return {
            ok: false,
            contractVersion: 1,
            operationId: call.operationId,
            error: { code: 'OperationFailed', message: 'x', outcome: 'failed' },
          };
        },
        step: (call) =>
          new Promise<Result>((resolve) => {
            started.push(String(call.args.tag));
            // Ignores cancellation: finishes anyway, like a tool past the point of no return.
            setTimeout(() => resolve(ok(call, 'ok')), 30);
          }),
      },
    );
    expect(value(report)).toBe('OperationFailed');
    expect(started).toEqual(['first']);
    const refused = report.operations.find((operation) => operation.errorCode === 'Cancelled');
    expect(refused).toMatchObject({ capability: 'step', outcome: 'not_started' });
  });

  test('writes take one slot at a time, also outside par', async () => {
    let writing = 0;
    let overlap = false;
    const { report } = await run(
      'await Promise.all([tools.write({ n: 1 }), tools.write({ n: 2 }), tools.write({ n: 3 }), tools.read({})]); return "done";',
      {
        write: async (call) => {
          if (writing) overlap = true;
          writing++;
          await Bun.sleep(5);
          writing--;
          return ok(call, 'w');
        },
        read: (call) => ok(call, 'r'),
      },
      { writes: ['write'] },
    );
    expect(report.status).toBe('completed');
    expect(overlap).toBe(false);
  });
});

describe('quotas', () => {
  test('calls past the in-flight limit wait their turn instead of failing', async () => {
    let running = 0;
    let peak = 0;
    const { report } = await run(
      `const results = await Promise.allSettled(Array.from({ length: 10 }, () => tools.wait({})));
       // A nested par next to running calls works too.
       const nested = await tools.par([1, 2], async () => tools.par([1, 2, 3], () => tools.wait({})));
       return [results.map((r) => r.status), nested.flat().length];`,
      {
        wait: async (call) => {
          peak = Math.max(peak, ++running);
          await Bun.sleep(20);
          running--;
          return ok(call, 'done');
        },
      },
    );
    expect(value(report)).toEqual([Array(10).fill('fulfilled'), 6]);
    expect(peak).toBe(BUDGETS.concurrentOperations);
    expect(report.summary).toMatchObject({ total: 16, completed: 16, notStarted: 0 });
  });

  test('the call quota counts every reservation, including denied ones', async () => {
    const { report, calls } = await run(
      `const codes = [];
       for (let i = 0; i < ${BUDGETS.internalCalls + 5}; i++) {
         const r = await tools.call("echo", { i });
         if (!r.ok) codes.push(r.error.code);
       }
       return codes;`,
      { echo },
    );
    expect(value(report)).toEqual(Array(5).fill('QuotaExceeded'));
    expect(calls).toHaveLength(BUDGETS.internalCalls);
    expect(report.summary.total).toBe(BUDGETS.internalCalls + 5);
  });

  test('a script that keeps calling past the quota is stopped, with bounded records', async () => {
    const { report, calls } = await run('for (;;) await tools.call("echo", {});', { echo });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('QuotaExceeded');
    expect(calls).toHaveLength(BUDGETS.internalCalls);
    expect(report.operations.length).toBeLessThanOrEqual(BUDGETS.internalCalls + 20);
    expect(report.summary.total).toBeGreaterThan(BUDGETS.internalCalls + 20);
    expect(report.summary.notStarted).toBe(report.summary.total - BUDGETS.internalCalls);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(512 * 1024);
  });

  test('tools.par calls are bounded too, with an error the script can catch', async () => {
    const { report } = await run(`let n = 0;
      try { for (;;) { await tools.par([], async () => 1); n++; } }
      catch (e) { return [n, e.code]; }`);
    expect(value(report)).toEqual([BUDGETS.parScopes, 'QuotaExceeded']);
  });

  test('a par left running after its parent par closed keeps its own scope', async () => {
    const started: string[] = [];
    const { report } = await run(
      `let inner;
       await tools.par([1], async () => {
         inner = tools.par([1, 2], async (n) => {
           if (n === 1) { await tools.fail({}); return; }
           await tools.step({ tag: 'first' });
           await tools.step({ tag: 'after' });
         });
       });
       try { await inner; } catch (e) { return e.code; }`,
      {
        fail: async (call) => {
          await Bun.sleep(5);
          return {
            ok: false,
            contractVersion: 1,
            operationId: call.operationId,
            error: { code: 'OperationFailed', message: 'x', outcome: 'failed' },
          };
        },
        step: (call) =>
          new Promise<Result>((resolve) => {
            started.push(String(call.args.tag));
            setTimeout(() => resolve(ok(call, 'ok')), 30);
          }),
      },
    );
    expect(value(report)).toBe('OperationFailed');
    expect(started).toEqual(['first']);
    const operations = report.trace.filter((item) => item.type === 'operation');
    expect(operations.every((item) => item.parentNodeId === 'exec:par2')).toBe(true);
  });

  test('oversized results are refused to the script but the operation still counts as completed', async () => {
    const { report } = await run(
      'const r = await tools.call("big", {}); return [r.ok, r.error.code, r.error.outcome];',
      {
        big: (call) => ok(call, 'x'.repeat(BUDGETS.resultBytes + 10)),
      },
    );
    expect(value(report)).toEqual([false, 'QuotaExceeded', 'completed']);
    expect(report.summary.completed).toBe(1);
  });
});

describe('crashes, timeouts and cancellation', () => {
  test('a runaway loop is interrupted by the active-time budget, even inside try/catch', async () => {
    const started = performance.now();
    const { report } = await run(
      'for (;;) { try { for (;;) {} } catch {} }',
      {},
      { timeoutMs: 300 },
    );
    expect(report.status).toBe('timed_out');
    expect(report.error?.code).toBe('Timeout');
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('memory exhaustion and stack overflow end the script, not the host', async () => {
    const memory = await run('const a = []; for (;;) a.push("x".repeat(1 << 20) + a.length);');
    expect(memory.report.status).toBe('failed');
    expect(memory.report.error?.message).toMatch(/memory|RangeError|InternalError/i);
    const stack = await run('const f = (n: number): number => f(n + 1) + 1; return f(0);');
    expect(stack.report.status).toBe('failed');
    // The host still runs the next execution normally.
    expect(value((await run('return 2 + 2;')).report)).toBe(4);
  });

  test('a crash after side effects still reports them', async () => {
    const { report } = await run('await tools.write({}); await tools.write({}); null.boom;', {
      write: (call) => ok(call, 'written'),
    });
    expect(report.status).toBe('failed');
    expect(report.summary).toMatchObject({ total: 2, completed: 2 });
    expect(report.operations.every((operation) => operation.delivered)).toBe(true);
  });

  test('cancellation aborts in-flight operations, ignores late results and keeps the summary', async () => {
    const controller = new AbortController();
    let late!: (value: Result) => void;
    let opSignal!: AbortSignal;
    const { report } = await run(
      'await tools.read({}); await tools.slow({}); return "unreachable";',
      {
        read: (call) => ok(call, 'r'),
        slow: (call) => {
          opSignal = call.signal;
          queueMicrotask(() => controller.abort());
          return new Promise<Result>((resolve) => {
            late = resolve;
            call.signal.addEventListener('abort', () =>
              setTimeout(() => resolve(ok(call, 'finished after cancel')), 20),
            );
          });
        },
      },
      { signal: controller.signal },
    );
    expect(report.status).toBe('cancelled');
    expect(report.error?.code).toBe('Cancelled');
    expect(opSignal.aborted).toBe(true);
    expect(report.value).toBeUndefined();
    // The slow operation finished anyway: an effect the script never saw.
    const slow = report.operations.find((operation) => operation.capability === 'slow')!;
    expect(slow).toMatchObject({ outcome: 'completed', delivered: false });
    late(ok({ operationId: 'x' } as BrokerCall, 'ignored'));
  });

  test('operations that never settle are reported with unknown outcome', async () => {
    const { report } = await run(
      'await tools.hang({});',
      { hang: () => new Promise<Result>(() => {}) },
      { timeoutMs: 200 },
    );
    expect(report.status).toBe('timed_out');
    expect(report.summary).toMatchObject({ total: 1, unknown: 1, running: 0 });
  }, 15_000);

  test('an operation the script never awaited is cancelled at the end and reported', async () => {
    const { report } = await run('tools.write({}); return "returned early";', {
      write: (call) =>
        new Promise<Result>((resolve) =>
          call.signal.addEventListener('abort', () =>
            resolve({
              ok: false,
              contractVersion: 1,
              operationId: call.operationId,
              error: { code: 'Cancelled', message: 'cancelled', outcome: 'unknown' },
            }),
          ),
        ),
    });
    expect(report.status).toBe('completed');
    expect(report.operations).toEqual([
      expect.objectContaining({ capability: 'write', outcome: 'unknown', delivered: false }),
    ]);
  });

  test('cancellation stops a busy script at once, even while a human is being asked', async () => {
    for (const humanWaiting of [false, true]) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const started = performance.now();
      const { report } = await run(
        'for (;;) {}',
        {},
        {
          signal: controller.signal,
          timeoutMs: 60_000,
          onHumanWait: (listener) => {
            if (humanWaiting) listener(true);
            return () => undefined;
          },
        },
      );
      expect(report.status).toBe('cancelled');
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  test('a stopped script process is gone, even mid-regex, and never sees the workspace config', async () => {
    // Run from a workspace whose bunfig.toml preloads code and whose .env sets
    // a variable: the script processes must not pick up either.
    const workspace = mkdtempSync(path.join(tmpdir(), 'pirc-ptc-ws-'));
    const marker = path.join(workspace, 'preloaded-in-guest');
    writeFileSync(path.join(workspace, '.env'), 'PTC_SECRET=leak\n');
    writeFileSync(path.join(workspace, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(
      path.join(workspace, 'pre.ts'),
      `if (process.argv.includes('ptc-guest')) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`,
    );
    // SIGKILL ends a script process whatever QuickJS is doing (it cannot interrupt a regex).
    const child = Bun.spawn([process.execPath, path.resolve('test/fixtures/ptc-busy-stop.ts')], {
      cwd: workspace,
      env: { ...process.env, BUN_JSC_useOMGJIT: '0' },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const { statuses, started, alive, cpuMs } = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(statuses).toEqual(['cancelled', 'timed_out', 'timed_out']);
    // Each script ran in its own process, and every one of them is gone.
    expect(started).toBe(3);
    expect(alive).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
    // A script still spinning would add about 500 ms each.
    expect(cpuMs).toBeLessThan(200);
  }, 30_000);

  test('a stale idle report cannot pause the budget of a script that is busy again', async () => {
    const started = performance.now();
    const { report } = await run(
      'await tools.fast({}); await tools.fast({}); await tools.par([1, 2, 3], async () => tools.fast({})); for (;;) {}',
      { fast: (call) => ok(call, 'x') },
      {
        timeoutMs: 300,
        onHumanWait: (fn) => {
          fn(true);
          return () => undefined;
        },
      },
    );
    expect(report.status).toBe('timed_out');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test('a script computing while a human is asked still spends its budget', async () => {
    // Only a script that waits (for operations) pauses its budget during a dialog.
    const started = performance.now();
    const { report } = await run(
      'for (;;) {}',
      {},
      {
        timeoutMs: 200,
        onHumanWait: (fn) => {
          fn(true);
          return () => undefined;
        },
      },
    );
    expect(report.status).toBe('timed_out');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('a wait still open at the end is counted, and no progress follows the end', async () => {
    const controller = new AbortController();
    let progressAfterEnd = false;
    let ended = false;
    const { report } = await run(
      'await tools.ask({});',
      {
        ask: (call) =>
          new Promise<Result>((resolve) =>
            call.signal.addEventListener('abort', () =>
              setTimeout(() => resolve(ok(call, 'late')), 20),
            ),
          ),
      },
      {
        signal: controller.signal,
        onHumanWait: (listener) => {
          listener(true);
          setTimeout(() => {
            controller.abort();
            ended = true;
          }, 300);
          return () => undefined;
        },
        onProgress: () => {
          if (ended) progressAfterEnd = true;
        },
      },
    );
    await Bun.sleep(50);
    expect(report.status).toBe('cancelled');
    expect(report.waitedMs).toBeGreaterThanOrEqual(250);
    expect(progressAfterEnd).toBe(false);
  });

  test('time spent waiting for a human does not count against the budget', async () => {
    let listener!: (waiting: boolean) => void;
    const { report } = await run(
      'return (await tools.ask({})).text;',
      {
        ask: async (call) => {
          listener(true);
          await Bun.sleep(400);
          listener(false);
          return ok(call, 'answered');
        },
      },
      {
        timeoutMs: 250,
        onHumanWait: (fn) => {
          listener = fn;
          return () => undefined;
        },
      },
    );
    expect(report.status).toBe('completed');
    expect(report.value).toBe('answered');
    expect(report.waitedMs).toBeGreaterThanOrEqual(350);
  });
});

describe('registry and ptc_docs', () => {
  const tool = (name: string, description = `${name} does things. More text.`): Tool => ({
    name,
    description,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async () => ({ content: [] }),
  });

  test('lists only available capabilities, never the wrappers, with categories', () => {
    const registry = new CapabilityRegistry(
      () => [tool('read'), tool('bash'), tool('code'), tool('ptc'), tool('custom_thing')],
      's1',
    );
    const index = registry.docs({});
    expect(index.categories).toEqual([
      { category: 'files', count: 1, names: ['read'] },
      { category: 'other', count: 1, names: ['custom_thing'] },
      { category: 'shell', count: 1, names: ['bash'] },
    ]);
    expect(index).toMatchObject({ truncated: false, nextCursor: null, contractVersion: 1 });
  });

  test('exact names give full contracts; unavailable names fail without revealing anything', () => {
    const registry = new CapabilityRegistry(() => [tool('read'), tool('write')], 's1');
    const page = registry.docs({ names: ['write'] });
    const [contract] = page.items as Array<Record<string, any>>;
    expect(contract).toMatchObject({
      name: 'write',
      category: 'files',
      concurrency: 'exclusive-write',
      inputSchema: { required: ['path'] },
      resultSchema: { required: ['text'] },
    });
    expect(contract!.errors).toContain('ApprovalDenied');
    expect(() => registry.docs({ names: ['bash'] })).toThrow('Not available in this session: bash');
    for (const bad of [
      { names: [] },
      { names: Array(BUDGETS.docsNames + 1).fill('read') },
      { names: ['Read!'] },
      { names: ['read'], category: 'files' },
      { cursor: 'x' },
      { category: 'Files' },
      { other: 1 },
    ])
      expect(() => registry.docs(bad as never)).toThrow(PtcError);
  });

  test('category pages are bounded and continue with authenticated cursors', () => {
    const tools = Array.from({ length: 45 }, (_, i) => tool(`thing_${String(i).padStart(2, '0')}`));
    const registry = new CapabilityRegistry(() => tools, 's1');
    const first = registry.docs({ category: 'other' });
    expect((first.items as unknown[]).length).toBe(BUDGETS.docsPageItems);
    expect(first.truncated).toBe(true);
    const second = registry.docs({ category: 'other', cursor: first.nextCursor as string });
    expect((second.items as Array<{ name: string }>)[0]!.name).toBe('thing_20');
    const third = registry.docs({ category: 'other', cursor: second.nextCursor as string });
    expect(third).toMatchObject({ truncated: false, nextCursor: null });
    expect((third.items as unknown[]).length).toBe(5);
    for (const page of [first, second, third])
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(BUDGETS.docsOutputBytes);
    // Forged, foreign and cross-query cursors are refused.
    const [payload] = (first.nextCursor as string).split('.');
    expect(() => registry.docs({ category: 'other', cursor: `${payload}.forged` })).toThrow(
      'Invalid cursor',
    );
    const other = new CapabilityRegistry(() => tools, 's2');
    expect(() => other.docs({ category: 'other', cursor: first.nextCursor as string })).toThrow();
  });

  test('stale cursors and registry versions fail with StaleContract and point at current docs', () => {
    let list = [
      tool('read'),
      tool('write'),
      ...Array.from({ length: 25 }, (_, i) => tool(`x_${i}`)),
    ];
    const registry = new CapabilityRegistry(() => list, 's1');
    const page = registry.docs({ category: 'other' });
    const version = page.registryVersion as string;
    list = list.filter((item) => item.name !== 'write');
    try {
      registry.docs({ category: 'other', cursor: page.nextCursor as string });
      throw new Error('not stale');
    } catch (error) {
      expect((error as PtcError).code).toBe('StaleContract');
      expect((error as PtcError).docs?.registryVersion).not.toBe(version);
    }
    try {
      registry.docs({ names: ['read'], registryVersion: version });
      throw new Error('not stale');
    } catch (error) {
      expect((error as PtcError).code).toBe('StaleContract');
      expect((error as PtcError).docs).toEqual({
        names: ['read'],
        registryVersion: registry.version(),
      });
    }
    expect(
      registry.docs({ names: ['read'], registryVersion: registry.version() }).items,
    ).toHaveLength(1);
  });

  test('the index stays within the docs bound, falling back to counts', () => {
    const many = Array.from({ length: 900 }, (_, i) => tool(`capability_number_${i}`));
    const index = new CapabilityRegistry(() => many, 's1').docs({});
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThanOrEqual(BUDGETS.docsOutputBytes);
    expect(index).toMatchObject({
      truncated: true,
      categories: [{ category: 'other', count: 900 }],
    });
  });

  test('an oversized contract is an explicit error, never a silently cut schema', () => {
    const huge = tool('huge', 'x'.repeat(BUDGETS.docsOutputBytes));
    const registry = new CapabilityRegistry(() => [huge, tool('read')], 's1');
    expect(() => registry.docs({ names: ['huge'] })).toThrow('larger than');
    const page = registry.docs({ names: ['read', 'huge'] });
    expect(page).toMatchObject({ truncated: true, remaining: ['huge'] });
  });

  test('write classification is conservative for action-dependent capabilities', () => {
    expect(isWriteCall('read', {})).toBe(false);
    expect(isWriteCall('bash', { command: 'ls' })).toBe(true);
    expect(isWriteCall('todo', { action: 'list' })).toBe(false);
    expect(isWriteCall('todo', { action: 'add' })).toBe(true);
    expect(isWriteCall('background_task', {})).toBe(true);
    expect(isWriteCall('unknown_capability', {})).toBe(true);
  });
});

describe('argument validation', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      offset: { type: 'number', minimum: 1 },
      mode: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'integer' }, maxItems: 2 },
    },
    required: ['path'],
    additionalProperties: false,
  };
  test('accepts valid arguments and reports every kind of violation', () => {
    expect(validateSchema({ path: 'x', offset: 2, mode: 'a', list: [1, 2] }, schema)).toEqual([]);
    expect(validateSchema({}, schema)).toEqual(['path is required']);
    expect(validateSchema({ path: '' }, schema)[0]).toContain('at least 1');
    expect(validateSchema({ path: 'x', offset: 0 }, schema)[0]).toContain('>= 1');
    expect(validateSchema({ path: 'x', offset: '2' }, schema)[0]).toContain('must be number');
    expect(validateSchema({ path: 'x', mode: 'c' }, schema)[0]).toContain('one of');
    expect(validateSchema({ path: 'x', list: [1.5] }, schema)[0]).toContain('list[0]');
    expect(validateSchema({ path: 'x', list: [1, 2, 3] }, schema)[0]).toContain('at most 2');
    expect(validateSchema({ path: 'x', extra: 1 }, schema)).toEqual(['extra is not allowed']);
    expect(validateSchema([], schema)[0]).toContain('must be object');
  });
});

describe('result contracts', () => {
  test('oneOf needs exactly one matching alternative, anyOf at least one', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { action: { const: 'a' } }, required: ['action'] },
        { type: 'object', properties: { action: { const: 'b' } }, required: ['action'] },
      ],
    };
    expect(validateSchema({ action: 'a' }, schema)).toEqual([]);
    expect(validateSchema({ action: 'c' }, schema)).toEqual([
      'value matches 0 of the oneOf alternatives',
    ]);
    expect(validateSchema({ action: 'a' }, { oneOf: [{}, {}] })).toEqual([
      'value matches 2 of the oneOf alternatives',
    ]);
    expect(validateSchema(1, { anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual([]);
  });
});

describe('attachments', () => {
  const image = (bytes: number) => ({
    type: 'image' as const,
    mimeType: 'image/png',
    data: Buffer.alloc(bytes).toString('base64'),
  });

  test('handles are unguessable, scoped to the instance and carry no bytes', () => {
    const one = new Attachments(() => true);
    const other = new Attachments(() => true);
    const descriptor = one.register(image(10));
    expect(descriptor).toEqual({
      handle: expect.stringMatching(/^att_[0-9a-f]{64}$/),
      mimeType: 'image/png',
      bytes: 10,
    });
    expect(() => other.add(descriptor.handle)).toThrow('Unknown attachment handle');
    expect(() => one.add('att_' + '0'.repeat(64))).toThrow('Unknown attachment handle');
    expect(() => one.add('../etc/passwd')).toThrow(PtcError);
    expect(one.add(descriptor.handle)).toEqual({ queued: 1 });
    // Queuing twice is one attachment.
    expect(one.add(descriptor.handle)).toEqual({ queued: 1 });
    expect(one.close(true)).toEqual([image(10)]);
    // Closed: nothing is left.
    expect(() => one.add(descriptor.handle)).toThrow('Unknown attachment handle');
  });

  test('enforce count, size, expiry and the model, and deliver nothing when cancelled', () => {
    let now = 0;
    const takes = { images: true };
    const set = new Attachments(
      () => takes.images,
      () => now,
    );
    const handles = Array.from({ length: 5 }, () => set.register(image(1)).handle);
    for (const handle of handles.slice(0, 4)) set.add(handle);
    expect(() => set.add(handles[4]!)).toThrow(`At most ${ATTACHMENT_LIMITS.count} attachments`);
    const big = new Attachments(() => true);
    expect(() => big.add(big.register(image(ATTACHMENT_LIMITS.bytesEach + 1)).handle)).toThrow(
      'larger than',
    );
    // Queued images together stay well below one node RPC line (1 MiB by default, base64).
    expect(Math.ceil((ATTACHMENT_LIMITS.bytesTotal * 4) / 3)).toBeLessThan(1024 * 1024);
    const pair = new Attachments(() => true);
    pair.add(pair.register(image(300 * 1024)).handle);
    expect(() => pair.add(pair.register(image(300 * 1024)).handle)).toThrow('in total');
    const late = set.register(image(1)).handle;
    takes.images = false;
    expect(() => set.add(late)).toThrow('does not accept images');
    takes.images = true;
    now = ATTACHMENT_LIMITS.ttlMs;
    expect(() => set.add(late)).toThrow('expired');
    // Queued handles that expired before delivery are dropped too.
    expect(set.close(true)).toEqual([]);
    const cancelled = new Attachments(() => true);
    cancelled.add(cancelled.register(image(1)).handle);
    expect(cancelled.close(false)).toEqual([]);
  });

  test('keeps a bounded number of unqueued images', () => {
    const set = new Attachments(() => true);
    const first = set.register(image(1)).handle;
    set.add(first);
    const dropped = set.register(image(1)).handle;
    for (let index = 0; index < ATTACHMENT_LIMITS.retained; index++) set.register(image(1));
    // The oldest unqueued image went; the queued one stays.
    expect(() => set.add(dropped)).toThrow('Unknown attachment handle');
    expect(set.close(true)).toHaveLength(1);
  });
});
