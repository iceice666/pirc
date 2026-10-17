// Private graph loader. All bytes arrive through the owning native document's resource channel.
function createPircDocumentModules(options) {
  const compiler = options.compiler;
  const globalEval = eval;
  const records = new Map();
  const ambiguous = {};
  let inlineSerial = 0;
  let sourceUnits = 0;
  function resolve(specifier, base) {
    const text = String(specifier);
    if (options.resolve) return options.resolve(text, base);
    if (!/^(?:[./]|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(text))
      throw new TypeError('Unmapped bare module specifier: ' + text);
    return new options.URL(text, base).href;
  }
  function create(key, url, fetchOptions, source) {
    if (records.size >= 128) throw new RangeError('Document module graph exceeds 128 modules');
    const record = {key, url, fetchOptions, inline: source !== undefined, namespace: Object.create(null), bindings: null,
      compiled: null, dependencies: [], iterator: null, status: 'loading', error: null,
      completion: null, resolveCompletion: null, rejectCompletion: null};
    records.set(key, record);
    function acceptSource(result) {
      if (!result || typeof result.source !== 'string') throw new TypeError('Module response has no source');
      sourceUnits += result.source.length;
      if (sourceUnits > 4 * 1024 * 1024) throw new RangeError('Document module sources exceed 8 MiB UTF-16 storage');
      record.url = String(result.url || url);
      record.fetchOptions = {...record.fetchOptions, referrerPolicy: result.referrerPolicy || record.fetchOptions.referrerPolicy};
      record.compiled = compiler.compile(result.source, record.url);
      for (const limitation of record.compiled.limitations || []) options.limitation?.(limitation, record.url);
      // Resolve every static request before initiating any child resource.
      const urls = record.compiled.dependencies.map(specifier => resolve(specifier, record.url));
      record.dependencies = urls.map(childURL => external(childURL, {...record.fetchOptions, integrity: null,
        moduleReferrerUrl: source === undefined ? record.url : options.documentUrl || record.url}));
      record.status = 'loaded';
      return record;
    }
    try {
      record.fetchOptions = {...fetchOptions, integrity: fetchOptions.integrity || options.integrityFor?.(url) || null};
      record.loaded = source === undefined
        ? Promise.resolve(options.fetch(url, record.fetchOptions)).then(acceptSource)
        : Promise.resolve(acceptSource({source, url}));
    } catch (error) {record.loaded = Promise.reject(error);}
    // Child failures can occur before a concurrent graph traversal attaches its handler.
    record.loaded.catch(() => {});
    return record;
  }
  function external(url, fetchOptions) {
    return records.get(url) || create(url, url, fetchOptions || {}, undefined);
  }
  function exportedNames(record, visited) {
    if (visited.has(record)) return new Set();
    visited.add(record);
    const names = new Set(record.compiled.exports.map(entry => entry.name));
    for (const entry of record.compiled.reexports) names.add(entry.name);
    for (const index of record.compiled.stars)
      for (const name of exportedNames(record.dependencies[index], visited)) if (name !== 'default') names.add(name);
    return names;
  }
  function binding(record, name, visited) {
    const key = record.key + '\u0000' + name;
    if (visited.has(key)) return null;
    visited.add(key);
    if (name === '*') return {record, local: '*namespace*', get: () => record.namespace};
    const direct = record.compiled.exports.find(entry => entry.name === name);
    if (direct) {
      const imported = record.compiled.imports.find(entry => entry.local === direct.local);
      if (imported) return binding(record.dependencies[imported.dependency], imported.name, visited);
      return {record, local: direct.local, get: () => record.bindings[name]()};
    }
    const indirect = record.compiled.reexports.find(entry => entry.name === name);
    if (indirect) return binding(record.dependencies[indirect.dependency], indirect.imported, visited);
    if (name === 'default') return null;
    let found = null;
    for (const index of record.compiled.stars) {
      const candidate = binding(record.dependencies[index], name, new Set(visited));
      if (candidate === ambiguous) return ambiguous;
      if (candidate && found && (candidate.record !== found.record || candidate.local !== found.local)) return ambiguous;
      if (candidate) found = candidate;
    }
    return found;
  }
  function requiredBinding(record, name) {
    const resolved = binding(record, name, new Set());
    if (!resolved || resolved === ambiguous) throw new SyntaxError('Module ' + record.url + ' has no unambiguous export named ' + name);
    return resolved;
  }
  function prepare(root) {
    if (root.preparation) return root.preparation;
    options.pending?.(1);
    root.preparation = prepareGraph(root).finally(() => options.pending?.(-1));
    return root.preparation;
  }
  async function prepareGraph(root) {
    const graph = new Set();
    async function visit(record) {
      if (graph.has(record)) return;
      graph.add(record);
      await record.loaded;
      await Promise.all(record.dependencies.map(visit));
    }
    await visit(root);
    for (const record of graph) {
      if (record.status !== 'loaded') continue;
      // Reject missing/ambiguous imports and explicit reexports before executing any body.
      for (const entry of record.compiled.imports)
        requiredBinding(record.dependencies[entry.dependency], entry.name);
      for (const entry of record.compiled.reexports)
        requiredBinding(record.dependencies[entry.dependency], entry.imported);
      for (const name of Array.from(exportedNames(record, new Set())).sort()) {
        const resolved = binding(record, name, new Set());
        if (resolved && resolved !== ambiguous) Object.defineProperty(record.namespace, name,
          {enumerable: true, configurable: false, get: resolved.get});
      }
      Object.defineProperty(record.namespace, Symbol.toStringTag, {value: 'Module'});
      Object.preventExtensions(record.namespace);
      record.status = 'linked';
    }
    const starts = [];
    for (const record of graph) {
      if (record.status === 'instantiating') {starts.push(record.instantiation);continue;}
      if (record.status !== 'linked') continue;
      record.status = 'instantiating';
      const meta = Object.create(null);
      meta.url = record.url;
      meta.resolve = specifier => resolve(specifier, record.url);
      const context = {meta, globalEval, import: (specifier, attributes) => importModule(specifier, record.url, attributes, {...record.fetchOptions, integrity: null, moduleReferrerUrl: record.inline ? options.documentUrl || record.url : record.url})};
      const factory = Function('return (' + record.compiled.code + '\n)')();
      record.iterator = factory(record.dependencies.map(dep => dep.namespace), context,
        getters => { record.bindings = getters; }, Object.defineProperty);
      record.instantiation = Promise.resolve(record.iterator.next()).then(result => {
        if (result.done || !record.bindings) throw new TypeError('Module compiler failed to instantiate bindings');
        record.status = 'instantiated';
      });
      starts.push(record.instantiation);
    }
    await Promise.all(starts);
    return root;
  }
  function evaluate(record, ancestors) {
    if (record.status === 'evaluated' || record.status === 'evaluating' || record.status === 'errored') return record;
    if (record.status !== 'instantiated') throw new TypeError('Module graph was not instantiated');
    record.status = 'evaluating';
    record.completion = new Promise((resolve, reject) => {record.resolveCompletion = resolve;record.rejectCompletion = reject;});
    record.completion.catch(() => {});
    const path = new Set(ancestors);path.add(record);
    function fail(error) {record.error = error;record.status = 'errored';record.rejectCompletion(error);options.changed?.();}
    function finish() {record.status = 'evaluated';record.resolveCompletion(record);options.changed?.();}
    function run() {
      try {
        const result = record.iterator.next();
        if (record.compiled.hasTopLevelAwait || record.compiled.async) {
          Promise.resolve(result).then(value => {
            if (!value.done) throw new TypeError('Unexpected module generator suspension');
            finish();
          }).catch(fail);
        } else {
          if (!result.done) throw new TypeError('Unexpected module generator suspension');
          finish();
        }
      } catch (error) {fail(error);}
    }
    try {
      const pending = [];
      for (const dependency of record.dependencies) {
        if (path.has(dependency)) continue;
        evaluate(dependency, path);
        if (dependency.status === 'errored') throw dependency.error;
        if (dependency.status !== 'evaluated') pending.push(dependency.completion);
      }
      if (pending.length) Promise.all(pending).then(run, fail);
      else run();
    } catch (error) {fail(error);}
    return record;
  }
  function importModule(specifier, base, attributes, fetchOptions) {
    // ToString/options access happen during the call. Conversion failures reject
    // the returned Promise, while expression errors remain at the call site.
    let url;
    try {
      if (typeof specifier === 'symbol') throw new TypeError('Cannot convert a Symbol to a module specifier');
      const text = String(specifier);
      const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
      if (attributes !== undefined) {
        if (!objectLike(attributes)) throw new TypeError('Import options must be an object');
        const withValues = attributes.with;
        if (withValues !== undefined) {
          if (!objectLike(withValues)) throw new TypeError('Import attributes must be an object');
          const keys = Object.keys(withValues);
          for (const key of keys) {
            if (typeof withValues[key] !== 'string') throw new TypeError('Import attribute values must be strings');
          }
          if (keys.length) throw new TypeError('Only JavaScript modules without import attributes are supported');
        }
      }
      url = resolve(text, base);
    } catch (error) {return Promise.reject(error);}
    let prepared;
    try {prepared = prepare(external(url, fetchOptions));} catch (error) {return Promise.reject(error);}
    return prepared
      .then(record => {evaluate(record, new Set());return record.completion;})
      .then(record => record.namespace);
  }

  return {
    external: (url, fetchOptions) => prepare(external(url, fetchOptions)),
    inline: (source, url, fetchOptions) => prepare(create('\u0000inline-' + (++inlineSerial), url, fetchOptions || {}, source)),
    execute: record => evaluate(record, new Set()).completion,
    import: importModule,
    resolve,
  };
}
