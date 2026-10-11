(() => {
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
            ? error.name + ': ' + error.message + (error.stack ? '\n' + String(error.stack).slice(0, 2000) : '')
            : 'Uncaught ' + show(error),
      } });
    },
  );
})();
