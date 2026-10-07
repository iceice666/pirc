/** Isolated Milestone 1 experiment. Never registered as an agent tool. */
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import wasmPath from '@jitl/quickjs-wasmfile-release-asyncify/wasm' with { type: 'file' };
import { newQuickJSAsyncWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSDeferredPromise } from 'quickjs-emscripten-core';

export const SPIKE_LIMITS = {
  sourceBytes: 65_536,
  calls: 200,
  concurrent: 8,
  outputBytes: 51_200,
  memoryBytes: 128 * 1024 * 1024,
} as const;

export interface SpikeOptions {
  code: string;
  /** Explicit test capabilities, NOT agent authority or the production manifest. */
  capabilities?: Record<string, (args: unknown, signal: AbortSignal) => Promise<unknown>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** JSON is the only bridge. The realm receives no environment or host references. */
export async function runSpike(options: SpikeOptions): Promise<{
  value: unknown;
  calls: number;
  elapsedMs: number;
}> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000)
    throw new Error('InvalidArguments');
  if (Buffer.byteLength(options.code) > SPIKE_LIMITS.sourceBytes) throw new Error('QuotaExceeded');
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timedOut = false;
  const expired = () => timedOut || performance.now() >= deadline;
  const check = () => {
    if (expired()) throw new Error('Timeout');
    if (signal.aborted) throw new Error('Cancelled');
  };
  check();
  // A fresh WASM instance per execution avoids Asyncify cross-execution reentrancy.
  const module = await newQuickJSAsyncWASMModuleFromVariant(
    newVariant(variant, {
      wasmBinary: () => Bun.file(wasmPath).arrayBuffer(),
      // Fixed backing memory avoids detached typed-array views during WASM growth.
      // 256 MiB backing includes the 128 MiB QuickJS heap plus bridge/VM overhead.
      wasmMemory: new WebAssembly.Memory({ initial: 4096, maximum: 4096 }),
    }),
  );
  check();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SPIKE_LIMITS.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => expired() || signal.aborted);
  const vm = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let live = true;
  let calls = 0;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
      notify();
    },
    Math.max(1, deadline - performance.now()),
  );
  signal.addEventListener('abort', notify);
  const bridge = vm.newFunction('__call', (nameHandle, argsHandle) => {
    check();
    if (vm.typeof(nameHandle) !== 'string' || vm.typeof(argsHandle) !== 'string')
      throw new Error('InvalidArguments');
    const name = vm.getString(nameHandle);
    const capabilities = options.capabilities ?? {};
    if (!Object.hasOwn(capabilities, name)) throw new Error('CapabilityUnavailable');
    if (calls >= SPIKE_LIMITS.calls || pending.size >= SPIKE_LIMITS.concurrent)
      throw new Error('QuotaExceeded');
    const args = JSON.parse(vm.getString(argsHandle)) as unknown;
    calls++; // Reserve before dispatch, including calls that never complete.
    const deferred = vm.newPromise();
    pending.add(deferred);
    void Promise.resolve()
      .then(() => {
        check();
        return capabilities[name]!(args, signal);
      })
      .then((value) => {
        if (!live || signal.aborted || expired()) return;
        // This spike bounds the host bridge as well as the outer result.
        const json = JSON.stringify(value ?? null);
        if (Buffer.byteLength(json) > SPIKE_LIMITS.memoryBytes / 4)
          throw new Error('QuotaExceeded');
        const handle = vm.newString(json);
        deferred.resolve(handle);
        handle.dispose();
      })
      .catch((error: unknown) => {
        if (!live || signal.aborted || expired()) return;
        const handle = vm.newError(error instanceof Error ? error.message : 'OperationFailed');
        deferred.reject(handle);
        handle.dispose();
      })
      .finally(() => {
        if (!live) return;
        pending.delete(deferred);
        deferred.dispose();
        notify();
      });
    return deferred.handle.dup();
  });
  vm.setProp(vm.global, '__call', bridge);
  bridge.dispose();
  try {
    // Capture the bridge in a realm-local closure; never transfer JS host objects.
    vm.unwrapResult(
      vm.evalCode(`globalThis.tools = ((call) => Object.freeze({
        call: async (name, args = {}) => JSON.parse(await call(name, JSON.stringify(args)))
      }))(__call); delete globalThis.__call;`),
    ).dispose();
    const js = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(
      `(async () => { ${options.code}\n })().then(value => JSON.stringify({ value: value ?? null }))`,
    );
    const promise = vm.unwrapResult(vm.evalCode(js, 'ptc-spike.js'));
    try {
      while (true) {
        check();
        if (runtime.hasPendingJob()) {
          const jobs = runtime.executePendingJobs(32);
          if (jobs.error) {
            jobs.error.dispose();
            check();
            throw new Error('OperationFailed');
          }
        }
        const state = vm.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          try {
            const json = vm.getString(state.value);
            if (Buffer.byteLength(json) > SPIKE_LIMITS.outputBytes)
              throw new Error('QuotaExceeded');
            return { value: JSON.parse(json).value, calls, elapsedMs: performance.now() - started };
          } finally {
            state.value.dispose();
          }
        }
        if (state.type === 'rejected') {
          const error = vm.dump(state.error) as { message?: string };
          state.error.dispose();
          check();
          throw new Error(error?.message ?? 'OperationFailed');
        }
        if (runtime.hasPendingJob()) {
          await Bun.sleep(0); // Service cancellation between bounded job batches.
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve; // Host completion, abort or deadline; no polling loop.
          });
          wake = undefined;
        }
      }
    } finally {
      promise.dispose();
    }
  } finally {
    live = false;
    controller.abort();
    clearTimeout(timer);
    signal.removeEventListener('abort', notify);
    for (const deferred of pending) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
