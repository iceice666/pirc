// Preserve classic-script global declarations and lexical callback context.
// Only AST ImportExpression keywords are replaced; source is never function-wrapped.
function createPircDocumentClassicImports(options) {
  const parser = options.parser;
  const global = options.global;
  const globalEval = options.globalEval;
  const defineProperty = Object.defineProperty;
  const nonce = String(options.nonce || '').replace(/[^a-zA-Z0-9_$]/g, '');
  let nextHook = 0;
  function rewrite(source, context, parseOptions) {
    source = String(source);
    if (!source.includes('import')) return source;
    const ast = parser.parse(source, {ecmaVersion: 'latest', sourceType: 'script',
      allowReturnOutsideFunction: !!(parseOptions && parseOptions.allowReturnOutsideFunction)});
    const imports = [];
    const identifiers = new Set();
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Identifier') identifiers.add(node.name);
      if (node.type === 'ImportExpression') imports.push(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {for (const child of value) if (child && typeof child.type === 'string') visit(child);}
        else if (value && typeof value.type === 'string') visit(value);
      }
    }
    visit(ast);
    if (!imports.length) return source;
    let name;
    for (;;) {
      if (nextHook >= 1024) throw new RangeError('Document classic import hooks exceed 1024');
      name = '__pircImport_' + nonce + '_' + nextHook++;
      if (identifiers.has(name) || Object.prototype.hasOwnProperty.call(global, name)) continue;
      // Global lexical bindings (including an undefined let) are not own properties.
      let absent = false;
      try {(0, globalEval)(name);} catch (error) {absent = error && error.name === 'ReferenceError';}
      if (absent) break;
    }
    const hook = function(specifier, attributes) {
      return options.importModule(specifier, attributes, context);
    };
    defineProperty(global, name, {value: hook, writable: false, enumerable: false, configurable: false});
    imports.sort((left, right) => right.start - left.start);
    for (const node of imports) {
      if (source.slice(node.start, node.start + 6) !== 'import') throw new SyntaxError('Invalid dynamic import AST range');
      source = source.slice(0, node.start) + name + source.slice(node.start + 6);
    }
    return source;
  }
  return {rewrite};
}
