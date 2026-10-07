/**
 * `pirc-node ptc-guest` / `pirc-chat ptc-guest`: one `ptc` execution in a
 * fresh QuickJS-WASM realm with no `Bun`, `process`, module loader,
 * filesystem, network or environment — only the `tools` SDK, `attachments`
 * (queue an operation's image by handle), a bounded `console` and `PtcError`.
 *
 * The realm is the boundary; the process around it exists so the agent can
 * always end a script: a busy script never stalls the agent, and SIGKILL
 * stops even what QuickJS cannot interrupt (a backtracking regular
 * expression). The agent starts it with an empty environment, inside the
 * same OS sandbox. This side keeps no authority and no records: every
 * operation is a request to the host over IPC, which validates, authorizes
 * and accounts for it (runtime.ts).
 *
 * `tools.par` scopes: a continuation runs in the scope of the operation whose
 * result resumed it, and par workers enter their scope explicitly, so an
 * operation belongs to the par that started it (for cancellation and trace)
 * without an async-context API.
 */
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import wasmPath from '@jitl/quickjs-wasmfile-release-asyncify/wasm' with { type: 'file' };
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { BUDGETS, ERROR_CODES } from './contracts.js';
import {
  GUEST_LIMITS,
  ROOT_SCOPE,
  type GuestMessage,
  type HostMessage,
  type ScriptOutcome,
} from './protocol.js';

let post: (message: GuestMessage) => void = () => undefined;
let onHostMessage: (message: HostMessage) => void = () => undefined;

/** The guest SDK; `__ptc` is captured and removed before the script runs. */
const PRELUDE = `(() => {
  const host = globalThis.__ptc;
  delete globalThis.__ptc;
  const MANIFEST = JSON.parse(host.manifest);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  class PtcError extends Error {
    constructor(error) {
      super(String(error && error.message || 'Operation failed'));
      this.name = String(error && error.code || 'OperationFailed');
      this.code = this.name;
      this.outcome = error && error.outcome || 'unknown';
      if (error && error.operationId) this.operationId = error.operationId;
      if (error && error.docs) this.docs = error.docs;
      if (error && error.data !== undefined) this.data = error.data;
    }
  }
  const fail = (code, message) => new PtcError({ code, message, outcome: 'not_started' });
  const call = async (name, args) => {
    if (typeof name !== 'string') throw fail('InvalidArguments', 'The capability name must be a string literal');
    let json;
    try { json = stringify(args === undefined ? {} : args); } catch (error) {
      throw fail('InvalidArguments', 'Arguments must be JSON-serializable: ' + (error && error.message));
    }
    return parse(await host.call(name, json === undefined ? 'null' : json));
  };
  const unwrap = (result) => {
    if (result.ok) return result.data;
    throw new PtcError(Object.assign({ operationId: result.operationId }, result.error));
  };
  const tools = Object.create(null);
  tools.call = (name, args) => call(name, args);
  for (const name of MANIFEST) tools[name] = async (args) => unwrap(await call(name, args));
  tools.par = async (items, fn, options) => {
    if (!Array.isArray(items)) throw fail('InvalidArguments', 'tools.par: items must be an array');
    if (typeof fn !== 'function') throw fail('InvalidArguments', 'tools.par: fn must be a function');
    const concurrency = options && options.concurrency !== undefined ? options.concurrency : ${BUDGETS.concurrentOperations};
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > ${BUDGETS.concurrentOperations})
      throw fail('InvalidArguments', 'tools.par: concurrency must be an integer from 1 to ${BUDGETS.concurrentOperations}');
    const scope = host.scopeOpen();
    if (!scope) throw fail('QuotaExceeded', 'More than ${BUDGETS.parScopes} tools.par calls in one ptc call; split the work across calls');
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    let first;
    const worker = async () => {
      while (!failed && next < items.length) {
        const index = next++;
        let promise;
        const previous = host.enter(scope);
        try { promise = fn(items[index], index); }
        catch (error) { promise = Promise.reject(error); }
        finally { host.leave(previous); }
        try { results[index] = await promise; }
        catch (error) {
          if (!failed) { failed = true; first = error; host.scopeCancel(scope); }
        }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    host.scopeClose(scope, failed ? 'failed' : 'completed');
    if (failed) throw first;
    return results;
  };
  Object.freeze(tools);
  const attachments = Object.create(null);
  attachments.add = async (item) => {
    const handle = typeof item === 'string' ? item : item && typeof item.handle === 'string' ? item.handle : '';
    const result = parse(await host.attach(handle));
    if (result.ok) return result.data;
    throw new PtcError(result.error);
  };
  Object.freeze(attachments);
  // Small JSON state kept across ptc calls; the host persists it only when the script completes.
  // No prototype: a key such as __proto__ is an ordinary key.
  const STORE = Object.assign(Object.create(null), parse(host.store));
  let storeChanged = false;
  const storeSize = () => stringify(STORE).length;
  const storeFn = (key, value) => {
    if (typeof key !== 'string' || !key || key.length > 200)
      throw fail('InvalidArguments', 'store: key must be a non-empty string of at most 200 characters');
    if (value === undefined) {
      if (Object.prototype.hasOwnProperty.call(STORE, key)) { delete STORE[key]; storeChanged = true; }
      return;
    }
    let json;
    try { json = stringify(value); } catch (error) { json = undefined; }
    if (json === undefined) throw fail('InvalidArguments', 'store: the value must be JSON-serializable');
    if (json.length > ${BUDGETS.storeValueChars})
      throw fail('QuotaExceeded', 'store: one value may have at most ${BUDGETS.storeValueChars} characters of JSON');
    const previous = Object.prototype.hasOwnProperty.call(STORE, key) ? STORE[key] : undefined;
    STORE[key] = parse(json);
    if (storeSize() > ${BUDGETS.storeTotalChars}) {
      if (previous === undefined) delete STORE[key]; else STORE[key] = previous;
      throw fail('QuotaExceeded', 'store: all values together may have at most ${BUDGETS.storeTotalChars} characters of JSON');
    }
    storeChanged = true;
  };
  const loadFn = (key) => {
    host.loaded();
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(STORE, key)
      ? parse(stringify(STORE[key]))
      : undefined;
  };
  const show = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { const json = stringify(value); return json === undefined ? String(value) : json; }
    catch { return String(value); }
  };
  const log = (level) => (...args) => { host.log(level, args.map(show).join(' ')); };
  const console = Object.freeze({ log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') });
  for (const [name, value] of [['tools', tools], ['attachments', attachments], ['console', console], ['PtcError', PtcError], ['store', storeFn], ['load', loadFn]])
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
  globalThis.__ptc_finish = (promise) => promise.then(
    (value) => {
      const kept = storeChanged ? { store: stringify(STORE) } : {};
      if (value === undefined) return stringify(Object.assign({ ok: true }, kept));
      if (typeof value === 'string') return stringify(Object.assign({ ok: true, value, string: true }, kept));
      let json;
      try { json = stringify(value); } catch { json = undefined; }
      return stringify(Object.assign({ ok: true, value: json === undefined ? stringify(String(value)) : json }, kept));
    },
    (error) => {
      const typed = error instanceof PtcError;
      return stringify({ ok: false, error: {
        code: typed ? error.code : 'ScriptError',
        message: typed
          ? error.message
          : error instanceof Error
            ? error.name + ': ' + error.message + (error.stack ? '\\n' + String(error.stack).slice(0, 2000) : '')
            : 'Uncaught ' + show(error),
      } });
    },
  );
})();`;

const failure = (message: string): ScriptOutcome => ({
  ok: false,
  error: { code: 'ScriptError', message: `Script runtime failed: ${message}` },
});

async function run(start: Extract<HostMessage, { type: 'start' }>): Promise<void> {
  const module = await newQuickJSAsyncWASMModuleFromVariant(
    newVariant(variant, {
      wasmBinary: () => Bun.file(wasmPath).arrayBuffer(),
      // Fixed backing memory avoids detached typed-array views during WASM growth;
      // 256 MiB holds the 128 MiB QuickJS heap plus bridge/VM overhead.
      wasmMemory: new WebAssembly.Memory({ initial: 4096, maximum: 4096 }),
    }),
  );
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(BUDGETS.quickjsHeapBytes);
  runtime.setMaxStackSize(BUDGETS.quickjsStackBytes);
  // A busy script cannot see its host vanish ('disconnect' needs the event loop): stop when
  // this process was orphaned (checked about every 100 ms; QuickJS polls this often).
  const parent = process.ppid;
  let checkedAt = 0;
  runtime.setInterruptHandler(() => {
    const now = Date.now();
    if (now - checkedAt < 100) return false;
    checkedAt = now;
    return process.ppid !== parent;
  });
  const vm = runtime.newContext();

  // Scopes: the current one, and the tree (closed scopes hand over to their parent).
  let current = ROOT_SCOPE;
  const scopes = new Map<string, { parent: string; open: boolean }>();
  /** The nearest open scope, starting from `scope` itself. */
  const effective = (scope: string): string => {
    for (let at = scope; at !== ROOT_SCOPE; ) {
      const info = scopes.get(at);
      if (!info) return ROOT_SCOPE;
      if (info.open) return at;
      at = info.parent;
    }
    return ROOT_SCOPE;
  };
  const stringArg = (handle: QuickJSHandle | undefined) =>
    handle && vm.typeof(handle) === 'string' ? vm.getString(handle) : '';

  const pending = new Map<number, { deferred: QuickJSDeferredPromise; scope: string }>();
  let nextId = 0;
  let received = 0;
  let consoleBytes = 0;
  let scopeCount = 0;

  /** The script called `load()` (set from outside the realm). */
  let loaded = false;
  const host = vm.newObject();
  const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(host, name, handle);
    handle.dispose();
  };
  const manifest = vm.newString(JSON.stringify(start.manifest));
  vm.setProp(host, 'manifest', manifest);
  manifest.dispose();
  const store = vm.newString(start.store ?? '{}');
  vm.setProp(host, 'store', store);
  store.dispose();
  define('call', (nameHandle, argsHandle) => {
    const deferred = vm.newPromise();
    const id = ++nextId;
    const scope = effective(current);
    pending.set(id, { deferred, scope });
    // Oversized input never crosses to the host; the host refuses the call.
    const argsJson = stringArg(argsHandle);
    const oversize = argsJson.length > GUEST_LIMITS.argsChars;
    post({
      type: 'call',
      id,
      name: stringArg(nameHandle).slice(0, GUEST_LIMITS.nameChars),
      argsJson: oversize ? '' : argsJson,
      scope,
      ...(oversize ? { oversize: true } : {}),
    });
    return deferred.handle.dup();
  });
  define('attach', (handleHandle) => {
    const deferred = vm.newPromise();
    const id = ++nextId;
    pending.set(id, { deferred, scope: effective(current) });
    post({ type: 'attach', id, handle: stringArg(handleHandle).slice(0, 100) });
    return deferred.handle.dup();
  });
  define('loaded', () => {
    loaded = true;
  });
  define('log', (levelHandle, textHandle) => {
    // The host bounds console output; stop sending once past that bound.
    if (consoleBytes > BUDGETS.consoleBytes) return;
    const text = stringArg(textHandle).slice(0, BUDGETS.consoleBytes + 1);
    consoleBytes += Buffer.byteLength(text) + 1;
    post({ type: 'log', level: stringArg(levelHandle).slice(0, 8) || 'log', text });
  });
  define('scopeOpen', () => {
    if (scopeCount >= BUDGETS.parScopes) return vm.newString('');
    const scope = `par${++scopeCount}`;
    const parent = effective(current);
    scopes.set(scope, { parent, open: true });
    post({ type: 'scope_open', scope, parent });
    return vm.newString(scope);
  });
  define('enter', (scopeHandle) => {
    const previous = current;
    const scope = stringArg(scopeHandle);
    if (scopes.has(scope)) current = scope;
    return vm.newString(previous);
  });
  define('leave', (scopeHandle) => {
    const scope = stringArg(scopeHandle);
    current = scope === ROOT_SCOPE || scopes.has(scope) ? scope : ROOT_SCOPE;
  });
  define('scopeCancel', (scopeHandle) => {
    const scope = stringArg(scopeHandle);
    if (scopes.has(scope)) post({ type: 'scope_cancel', scope });
  });
  define('scopeClose', (scopeHandle, statusHandle) => {
    const scope = stringArg(scopeHandle);
    const info = scopes.get(scope);
    if (!info?.open) return;
    info.open = false;
    post({
      type: 'scope_close',
      scope,
      status: stringArg(statusHandle) === 'completed' ? 'completed' : 'failed',
    });
  });
  vm.setProp(vm.global, '__ptc', host);
  host.dispose();

  let finished = false;
  const finish = (outcome: ScriptOutcome) => {
    if (finished) return;
    finished = true;
    // Tracked outside the realm, so a script cannot claim it never read the store.
    if (!loaded) outcome.loaded = false;
    else delete outcome.loaded;
    post({ type: 'done', outcome });
  };

  vm.unwrapResult(vm.evalCode(PRELUDE, 'ptc-sdk.js')).dispose();
  const evaluated = vm.evalCode(`${start.code}\n;__ptc_finish(__ptc_main());`, 'ptc.js');
  if (evaluated.error) {
    const dumped = vm.dump(evaluated.error) as { message?: unknown } | undefined;
    evaluated.error.dispose();
    return finish(failure(String(dumped?.message ?? 'evaluation failed')));
  }
  const promise = evaluated.value;

  /** Run every queued job, then report if the script settled. */
  const drain = () => {
    if (finished) return;
    const jobs = runtime.executePendingJobs(-1);
    if (jobs.error) {
      const dumped = vm.dump(jobs.error) as { message?: unknown } | undefined;
      jobs.error.dispose();
      return finish(failure(String(dumped?.message ?? 'unknown error')));
    }
    const state = vm.getPromiseState(promise);
    if (state.type === 'pending') return;
    if (state.type === 'rejected') {
      // __ptc_finish never rejects unless the realm itself broke (out of memory).
      const dumped = vm.dump(state.error) as { message?: unknown } | undefined;
      state.error.dispose();
      return finish(failure(String(dumped?.message ?? 'unknown error')));
    }
    const outcome = JSON.parse(vm.getString(state.value)) as ScriptOutcome;
    state.value.dispose();
    // The realm chose this code; keep only the documented ones.
    if (
      outcome.ok &&
      typeof outcome.value === 'string' &&
      outcome.value.length > GUEST_LIMITS.valueChars
    )
      outcome.value = outcome.value.slice(0, GUEST_LIMITS.valueChars);
    // An oversized or malformed store never crosses the process boundary.
    if (
      outcome.ok &&
      outcome.store !== undefined &&
      (typeof outcome.store !== 'string' || outcome.store.length > BUDGETS.storeTotalChars + 2)
    )
      delete outcome.store;
    if (!outcome.ok) {
      if (!(ERROR_CODES as readonly string[]).includes(outcome.error.code))
        outcome.error.code = 'ScriptError';
      outcome.error.message = String(outcome.error.message).slice(0, 8192);
    }
    finish(outcome);
  };

  /** Drain, then tell the host whether the script is waiting (only then can its budget pause). */
  const settle = () => {
    drain();
    if (!finished) post({ type: 'idle', received });
  };
  onHostMessage = (message) => {
    if (message.type !== 'result' || finished) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    received++;
    const handle = vm.newString(message.json);
    entry.deferred.resolve(handle);
    handle.dispose();
    entry.deferred.dispose();
    // Continuations resumed by this result run in its operation's scope.
    current = entry.scope;
    try {
      settle();
    } finally {
      current = ROOT_SCOPE;
    }
  };
  settle();
}

/** Entry of the internal `ptc-guest` command; only an agent starts it, with an IPC channel. */
export async function runPtcGuest(): Promise<void> {
  if (typeof process.send !== 'function') {
    process.stderr.write('ptc-guest must be started by a pirc agent\n');
    process.exit(2);
  }
  const send = process.send.bind(process);
  post = (message) => {
    send(message);
  };
  // The agent went away: nothing is left to report to.
  process.on('disconnect', () => process.exit(0));
  let started = false;
  process.on('message', (message: HostMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type !== 'start') return onHostMessage(message);
    if (started) return;
    started = true;
    run(message).catch((error) =>
      post({ type: 'done', outcome: failure((error as Error)?.message ?? String(error)) }),
    );
  });
}
