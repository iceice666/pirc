function createPircDocumentModuleCompiler(parser) {
  if (!parser || typeof parser.parse !== 'function' || typeof parser.tokenizer !== 'function') {
    throw new TypeError('createPircDocumentModuleCompiler requires the Acorn parse and tokenizer APIs');
  }

  function compile(source, url) {
    if (typeof source !== 'string') {
      throw new TypeError('Document module source must be a string');
    }

    const options = { ecmaVersion: 'latest', sourceType: 'module' };
    if (url !== undefined) options.sourceFile = String(url);
    const ast = parser.parse(source, options);
    const tokenizer = parser.tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const tokens = [];
    for (;;) {
      const token = tokenizer.getToken();
      tokens.push(token);
      if (token.type.label === 'eof') break;
    }

    const usedNames = new Set();
    collectIdentifiers(ast, usedNames);
    for (const token of tokens) {
      if (token.type.label === 'name' && typeof token.value === 'string') usedNames.add(token.value);
    }
    let freshCounter = 0;
    function fresh(base) {
      let name;
      do {
        name = `${base}${freshCounter++}`;
      } while (usedNames.has(name));
      usedNames.add(name);
      return name;
    }

    const importsParameter = fresh('__pircImports');
    const contextParameter = fresh('__pircContext');
    const registerParameter = fresh('__pircRegister');
    const definePropertyParameter = fresh('__pircDefineProperty');

    const dependencies = [];
    const dependencyBySpecifier = new Map();
    const imports = [];
    const importsByLocal = new Map();
    const exports = [];
    const reexports = [];
    const stars = [];

    function dependencyIndex(literal) {
      const specifier = literal.value;
      if (dependencyBySpecifier.has(specifier)) return dependencyBySpecifier.get(specifier);
      const index = dependencies.length;
      dependencies.push(specifier);
      dependencyBySpecifier.set(specifier, index);
      return index;
    }

    function moduleName(node) {
      if (!node) return null;
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'Literal') return String(node.value);
      return null;
    }

    for (const statement of ast.body) {
      if (statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') {
        const attributes = statement.attributes || statement.assertions;
        if (attributes && attributes.length) {
          const sourceName = statement.source && statement.source.value;
          throw new SyntaxError(`Static module attributes are not supported${sourceName ? ` for ${sourceName}` : ''}`);
        }
      }
      if (statement.type === 'ImportDeclaration') {
        const dependency = dependencyIndex(statement.source);
        for (const specifier of statement.specifiers) {
          const local = specifier.local.name;
          let imported;
          if (specifier.type === 'ImportDefaultSpecifier') imported = 'default';
          else if (specifier.type === 'ImportNamespaceSpecifier') imported = '*';
          else imported = moduleName(specifier.imported);
          const record = { dependency, name: imported, local };
          imports.push({ dependency, name: imported, local });
          importsByLocal.set(local, record);
        }
      } else if (statement.type === 'ExportNamedDeclaration' && statement.source) {
        const dependency = dependencyIndex(statement.source);
        for (const specifier of statement.specifiers) {
          reexports.push({
            name: moduleName(specifier.exported),
            dependency,
            imported: moduleName(specifier.local),
          });
        }
      } else if (statement.type === 'ExportAllDeclaration') {
        const dependency = dependencyIndex(statement.source);
        if (statement.exported) {
          reexports.push({ name: moduleName(statement.exported), dependency, imported: '*' });
        } else {
          stars.push(dependency);
        }
      }
    }

    const rootScope = createScope(null, 'module', null);
    rootScope.varScope = rootScope;
    const scopeForNode = new WeakMap();
    scopeForNode.set(ast, rootScope);
    for (const [local, record] of importsByLocal) {
      declare(rootScope, local, { kind: 'import', importRecord: record });
    }
    collectDirectDeclarations(ast.body, rootScope, true);
    for (const statement of ast.body) prepareNode(statement, rootScope);

    const edits = [];
    const limitations = [];
    let hasDirectEval = false;

    function addEdit(start, end, text) {
      edits.push({ start, end, text });
    }

    function blank(start, end) {
      return source.slice(start, end).replace(/[^\r\n]/g, ' ');
    }

    function addBlankEdit(start, end) {
      addEdit(start, end, blank(start, end));
    }

    function matchingToken(start, end, label) {
      return tokens.find(token => token.start >= start && token.end <= end && token.type.label === label);
    }

    const generatedNameFixes = [];
    for (const statement of ast.body) {
      if (statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') {
        const attributes = statement.attributes || statement.assertions;
        if (attributes && attributes.length) {
          const sourceName = statement.source && statement.source.value;
          throw new SyntaxError(`Static module attributes are not supported${sourceName ? ` for ${sourceName}` : ''}`);
        }
      }
      if (statement.type === 'ImportDeclaration') {
        addBlankEdit(statement.start, statement.end);
        continue;
      }
      if (statement.type === 'ExportNamedDeclaration') {
        if (statement.declaration) {
          addBlankEdit(statement.start, statement.declaration.start);
          appendDeclarationExports(statement.declaration, exports);
        } else {
          addBlankEdit(statement.start, statement.end);
          if (!statement.source) {
            for (const specifier of statement.specifiers) {
              const local = moduleName(specifier.local);
              exports.push({ name: moduleName(specifier.exported), local });
            }
          }
        }
        continue;
      }
      if (statement.type === 'ExportAllDeclaration') {
        addBlankEdit(statement.start, statement.end);
        continue;
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = statement.declaration;
        if (declaration.type === 'FunctionDeclaration') {
          if (declaration.id) {
            addBlankEdit(statement.start, declaration.start);
            exports.push({ name: 'default', local: declaration.id.name });
          } else {
            const local = fresh('__pircDefaultFunction');
            addBlankEdit(statement.start, declaration.start);
            const functionToken = matchingToken(declaration.start, declaration.end, 'function');
            if (!functionToken) throw new SyntaxError('Unable to locate default function declaration token');
            let insertion = functionToken.end;
            if (declaration.generator) {
              const star = tokens.find(token => token.start >= functionToken.end && token.end <= declaration.end && token.type.label === '*');
              if (!star) throw new SyntaxError('Unable to locate default generator declaration token');
              insertion = star.end;
            }
            addEdit(insertion, insertion, ` ${local}`);
            generatedNameFixes.push(`${definePropertyParameter}(${local}, 'name', { value: 'default' });`);
            exports.push({ name: 'default', local });
          }
          continue;
        }
        if (declaration.type === 'ClassDeclaration') {
          if (declaration.id) {
            addBlankEdit(statement.start, declaration.start);
            exports.push({ name: 'default', local: declaration.id.name });
          } else {
            const local = fresh('__pircDefaultClass');
            addEdit(statement.start, declaration.start, `const ${local} = ({default: `);
            addEdit(declaration.end, declaration.end, `}).default;`);
            exports.push({ name: 'default', local });
          }
          continue;
        }

        const local = fresh('__pircDefaultValue');
        addEdit(statement.start, declaration.start, `let ${local} = (`);
        addEdit(declaration.end, declaration.end, ')');
        exports.push({ name: 'default', local });
      }
    }

    function appendDeclarationExports(declaration, output) {
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
          const names = [];
          collectPatternNames(declarator.id, names);
          for (const name of names) output.push({ name, local: name });
        }
      } else if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        output.push({ name: declaration.id.name, local: declaration.id.name });
      }
    }

    walkReferences(ast, rootScope);

    if (hasDirectEval) {
      limitations.push('Direct eval can inspect the generated wrapper environment; imported-name lookup inside evaluated strings does not have native module binding semantics.');
    }

    function walkReferences(node, inheritedScope, parent, key) {
      if (!node || typeof node !== 'object') return;
      const scope = scopeForNode.get(node) || inheritedScope;
      switch (node.type) {
        case 'Program':
          for (const child of node.body) walkReferences(child, scope, node, 'body');
          return;
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
          return;
        case 'ExportNamedDeclaration':
          if (node.declaration) walkReferences(node.declaration, scope, node, 'declaration');
          return;
        case 'ExportDefaultDeclaration':
          walkReferences(node.declaration, scope, node, 'declaration');
          return;
        case 'Identifier':
          if (node.name === 'arguments' && !resolveBinding(scope, node.name)) {
            const read = `(0, ${contextParameter}.globalEval)(${JSON.stringify(node.name)})`;
            addEdit(node.start, node.end, parent && parent.type === 'Property' && parent.shorthand ? `${node.name}: ${read}` : read);
          } else {
            addImportedReference(node, scope, 'read', parent && parent.type === 'Property' && parent.shorthand ? parent : null);
          }
          return;
        case 'MetaProperty':
          if (node.meta.name === 'import' && node.property.name === 'meta') {
            addEdit(node.start, node.end, `${contextParameter}.meta`);
          }
          return;
        case 'ImportExpression': {
          const keyword = matchingToken(node.start, node.end, 'import');
          if (!keyword) throw new SyntaxError('Unable to locate dynamic import token');
          addEdit(keyword.start, keyword.end, `${contextParameter}.import`);
          walkReferences(node.source, scope, node, 'source');
          if (node.options) walkReferences(node.options, scope, node, 'options');
          return;
        }
        case 'BlockStatement':
          for (const child of node.body) walkReferences(child, scope, node, 'body');
          return;
        case 'VariableDeclaration':
          for (const declaration of node.declarations) {
            walkBindingPattern(declaration.id, scope);
            if (declaration.init) walkReferences(declaration.init, scope, declaration, 'init');
          }
          return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          for (const parameter of node.params) walkBindingPattern(parameter, scope);
          if (node.body) walkReferences(node.body, scope, node, 'body');
          return;
        }
        case 'ClassDeclaration':
        case 'ClassExpression':
          if (node.superClass) walkReferences(node.superClass, scope, node, 'superClass');
          walkReferences(node.body, scope, node, 'body');
          return;
        case 'ForStatement':
          if (node.init) {
            if (node.init.type === 'VariableDeclaration') walkReferences(node.init, scope, node, 'init');
            else walkReferences(node.init, scope, node, 'init');
          }
          if (node.test) walkReferences(node.test, scope, node, 'test');
          if (node.update) walkReferences(node.update, scope, node, 'update');
          walkReferences(node.body, scope, node, 'body');
          return;
        case 'ForInStatement':
        case 'ForOfStatement':
          if (node.left.type === 'VariableDeclaration') walkReferences(node.left, scope, node, 'left');
          else walkAssignmentTarget(node.left, scope, node, 'left');
          walkReferences(node.right, scope, node, 'right');
          walkReferences(node.body, scope, node, 'body');
          return;
        case 'SwitchStatement':
          walkReferences(node.discriminant, inheritedScope, node, 'discriminant');
          for (const switchCase of node.cases) walkReferences(switchCase, scope, node, 'cases');
          return;
        case 'SwitchCase':
          if (node.test) walkReferences(node.test, scope, node, 'test');
          for (const child of node.consequent) walkReferences(child, scope, node, 'consequent');
          return;
        case 'CatchClause':
          walkBindingPattern(node.param, scope);
          walkReferences(node.body, scope, node, 'body');
          return;
        case 'AssignmentExpression':
          walkAssignmentTarget(node.left, scope, node, 'left');
          walkReferences(node.right, scope, node, 'right');
          return;
        case 'UpdateExpression':
          walkAssignmentTarget(node.argument, scope, node, 'argument');
          return;
        case 'UnaryExpression':
          if (node.operator === 'typeof' && node.argument.type === 'Identifier' && node.argument.name === 'arguments' && !resolveBinding(scope, 'arguments')) {
            addEdit(node.start, node.end, `(0, ${contextParameter}.globalEval)('typeof arguments')`);
          } else {
            walkReferences(node.argument, scope, node, 'argument');
          }
          return;
        case 'AssignmentPattern':
          walkAssignmentTarget(node.left, scope, node, 'left');
          walkReferences(node.right, scope, node, 'right');
          return;
        case 'ObjectPattern':
          walkAssignmentPattern(node, scope);
          return;
        case 'ArrayPattern':
          walkAssignmentPattern(node, scope);
          return;
        case 'Property':
          if (node.computed) walkReferences(node.key, scope, node, 'key');
          walkReferences(node.value, scope, node, 'value');
          return;
        case 'MemberExpression':
          walkReferences(node.object, scope, node, 'object');
          if (node.computed) walkReferences(node.property, scope, node, 'property');
          return;
        case 'MethodDefinition':
        case 'PropertyDefinition':
          if (node.computed) walkReferences(node.key, scope, node, 'key');
          if (node.value) walkReferences(node.value, scope, node, 'value');
          return;
        case 'LabeledStatement':
          walkReferences(node.body, scope, node, 'body');
          return;
        case 'BreakStatement':
        case 'ContinueStatement':
        case 'PrivateIdentifier':
        case 'Literal':
        case 'Super':
          return;
        case 'ThisExpression':
          if (!scope.hasThisBinding) addEdit(node.start, node.end, '(void 0)');
          return;
        case 'CallExpression':
          if (node.callee && node.callee.type === 'Identifier' && node.callee.name === 'eval' && !node.optional) {
            hasDirectEval = true;
          }
          walkReferences(node.callee, scope, node, 'callee');
          for (const argument of node.arguments) walkReferences(argument, scope, node, 'arguments');
          return;
        default:
          forEachChild(node, (child, childKey) => walkReferences(child, scope, node, childKey));
      }
    }

    function walkBindingPattern(pattern, scope) {
      if (!pattern) return;
      switch (pattern.type) {
        case 'Identifier':
          return;
        case 'RestElement':
          walkBindingPattern(pattern.argument, scope);
          return;
        case 'AssignmentPattern':
          walkBindingPattern(pattern.left, scope);
          walkReferences(pattern.right, scope, pattern, 'right');
          return;
        case 'ArrayPattern':
          for (const element of pattern.elements) walkBindingPattern(element, scope);
          return;
        case 'ObjectPattern':
          for (const property of pattern.properties) {
            if (property.type === 'RestElement') walkBindingPattern(property.argument, scope);
            else {
              if (property.computed) walkReferences(property.key, scope, property, 'key');
              walkBindingPattern(property.value, scope);
            }
          }
          return;
        default:
          return;
      }
    }

    function walkAssignmentTarget(target, scope, parent, key) {
      if (!target) return;
      if (target.type === 'Identifier') {
        addImportedReference(target, scope, 'write', parent && parent.type === 'Property' && parent.shorthand ? parent : null);
      } else if (target.type === 'MemberExpression') {
        walkReferences(target.object, scope, target, 'object');
        if (target.computed) walkReferences(target.property, scope, target, 'property');
      } else if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
        walkAssignmentPattern(target, scope);
      } else if (target.type === 'AssignmentPattern') {
        walkAssignmentTarget(target.left, scope, parent, key);
        walkReferences(target.right, scope, target, 'right');
      } else if (target.type === 'RestElement') {
        walkAssignmentTarget(target.argument, scope, target, 'argument');
      } else {
        walkReferences(target, scope, parent, key);
      }
    }

    function walkAssignmentPattern(pattern, scope) {
      if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) if (element) walkAssignmentTarget(element, scope, pattern, 'elements');
        return;
      }
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') walkAssignmentTarget(property.argument, scope, property, 'argument');
        else {
          if (property.computed) walkReferences(property.key, scope, property, 'key');
          walkAssignmentTarget(property.value, scope, property, 'value');
        }
      }
    }

    function addImportedReference(identifier, scope, mode, shorthandProperty) {
      const binding = resolveBinding(scope, identifier.name);
      if (!binding || binding.kind !== 'import') return;
      const record = binding.importRecord;
      let target;
      if (record.name === '*') {
        target = record.name === '*' && mode === 'write'
          ? `${importsParameter}[${record.dependency}]["*"]`
          : `${importsParameter}[${record.dependency}]`;
      } else {
        target = `${importsParameter}[${record.dependency}][${JSON.stringify(record.name)}]`;
      }
      const replacement = mode === 'read' ? `(0, ${target})` : target;
      addEdit(identifier.start, identifier.end, shorthandProperty ? `${identifier.name}: ${replacement}` : replacement);
    }

    function applyEdits() {
      edits.sort((left, right) => {
        if (left.start !== right.start) return right.start - left.start;
        return right.end - left.end;
      });
      let output = source;
      for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
      return output;
    }

    const hasTopLevelAwait = detectsTopLevelAwait(ast);
    const getterEntries = exports.map(exported => {
      const imported = importsByLocal.get(exported.local);
      let getter;
      if (!imported) getter = `() => ${exported.local}`;
      else if (imported.name === '*') getter = `() => ${importsParameter}[${imported.dependency}]`;
      else getter = `() => (0, ${importsParameter}[${imported.dependency}][${JSON.stringify(imported.name)}])`;
      return `[${JSON.stringify(exported.name)}]: ${getter}`;
    });
    const body = applyEdits();
    const generatorType = hasTopLevelAwait ? 'async function*' : 'function*';
    const code = `(function (${definePropertyParameter}) { return ${generatorType} (${importsParameter}, ${contextParameter}, ${registerParameter}) {\"use strict\";\n${generatedNameFixes.join('\n')}\n${registerParameter}({${getterEntries.join(',')}});\nyield;\n${body}\n}; })(Object.defineProperty)`;

    return {
      dependencies,
      imports,
      exports,
      reexports,
      stars,
      async: hasTopLevelAwait,
      hasTopLevelAwait,
      code,
      limitations,
    };

    function createScope(parent, kind, varScope) {
      return { parent, kind, varScope, hasThisBinding: parent ? parent.hasThisBinding : false, bindings: new Map() };
    }

    function declare(scope, name, binding) {
      if (!name) return;
      if (!scope.bindings.has(name)) scope.bindings.set(name, binding || { kind: 'local' });
    }

    function resolveBinding(scope, name) {
      for (let current = scope; current; current = current.parent) {
        if (current.bindings.has(name)) return current.bindings.get(name);
      }
      return null;
    }

    function collectIdentifiers(node, output) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') output.add(node.name);
      forEachChild(node, child => collectIdentifiers(child, output));
    }

    function collectPatternNames(pattern, output) {
      if (!pattern) return;
      switch (pattern.type) {
        case 'Identifier':
          output.push(pattern.name);
          break;
        case 'RestElement':
          collectPatternNames(pattern.argument, output);
          break;
        case 'AssignmentPattern':
          collectPatternNames(pattern.left, output);
          break;
        case 'ArrayPattern':
          for (const element of pattern.elements) collectPatternNames(element, output);
          break;
        case 'ObjectPattern':
          for (const property of pattern.properties) {
            if (property.type === 'RestElement') collectPatternNames(property.argument, output);
            else collectPatternNames(property.value, output);
          }
          break;
      }
    }

    function collectDirectDeclarations(statements, scope, includeVar) {
      for (const statement of statements) {
        if (!statement) continue;
        if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
          collectOne(statement.declaration, scope, includeVar);
        } else if (statement.type === 'ExportDefaultDeclaration') {
          const declaration = statement.declaration;
          if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
            declare(scope, declaration.id.name, { kind: declaration.type === 'FunctionDeclaration' ? 'function' : 'class' });
          }
        } else {
          collectOne(statement, scope, includeVar);
        }
      }
    }

    function collectOne(statement, scope, includeVar) {
      if (!statement) return;
      if (statement.type === 'VariableDeclaration') {
        if (statement.kind === 'var' && !includeVar) return;
        for (const declaration of statement.declarations) {
          const names = [];
          collectPatternNames(declaration.id, names);
          for (const name of names) declare(scope, name, { kind: statement.kind });
        }
      } else if (statement.type === 'FunctionDeclaration' && statement.id) {
        declare(scope, statement.id.name, { kind: 'function' });
      } else if (statement.type === 'ClassDeclaration' && statement.id) {
        declare(scope, statement.id.name, { kind: 'class' });
      }
    }

    function makeChildScope(parent, kind, isVarScope) {
      const child = createScope(parent, kind, isVarScope ? null : parent.varScope);
      if (isVarScope) child.varScope = child;
      return child;
    }

    function preparePatternExpressions(pattern, scope) {
      if (!pattern) return;
      switch (pattern.type) {
        case 'AssignmentPattern':
          preparePatternExpressions(pattern.left, scope);
          prepareNode(pattern.right, scope);
          break;
        case 'RestElement':
          preparePatternExpressions(pattern.argument, scope);
          break;
        case 'ArrayPattern':
          for (const element of pattern.elements) preparePatternExpressions(element, scope);
          break;
        case 'ObjectPattern':
          for (const property of pattern.properties) {
            if (property.type === 'RestElement') preparePatternExpressions(property.argument, scope);
            else {
              if (property.computed) prepareNode(property.key, scope);
              preparePatternExpressions(property.value, scope);
            }
          }
          break;
      }
    }

    function prepareBlock(block, parentScope) {
      const blockScope = makeChildScope(parentScope, 'block', false);
      scopeForNode.set(block, blockScope);
      collectDirectDeclarations(block.body, blockScope, false);
      for (const statement of block.body) prepareNode(statement, blockScope);
    }

    function prepareNode(node, inheritedScope) {
      if (!node || typeof node !== 'object') return;
      const currentScope = scopeForNode.get(node) || inheritedScope;
      switch (node.type) {
        case 'Program':
          for (const statement of node.body) prepareNode(statement, currentScope);
          return;
        case 'BlockStatement':
          prepareBlock(node, inheritedScope);
          return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          let nameScope = inheritedScope;
          if (node.type === 'FunctionExpression' && node.id) {
            nameScope = makeChildScope(inheritedScope, 'function-name', false);
            declare(nameScope, node.id.name, { kind: 'function-name' });
          }
          const parameterScope = makeChildScope(nameScope, 'function-parameters', false);
          if (node.type !== 'ArrowFunctionExpression') {
            parameterScope.hasThisBinding = true;
            declare(parameterScope, 'arguments', { kind: 'function-arguments' });
          }
          scopeForNode.set(node, parameterScope);
          for (const parameter of node.params) {
            const names = [];
            collectPatternNames(parameter, names);
            for (const name of names) declare(parameterScope, name, { kind: 'parameter' });
          }
          for (const parameter of node.params) preparePatternExpressions(parameter, parameterScope);
          if (node.body && node.body.type === 'BlockStatement') {
            const functionScope = makeChildScope(parameterScope, 'function-var', true);
            prepareBlock(node.body, functionScope);
          } else if (node.body) {
            prepareNode(node.body, parameterScope);
          }
          return;
        }
        case 'ClassDeclaration':
        case 'ClassExpression': {
          const classScope = makeChildScope(inheritedScope, 'class', false);
          scopeForNode.set(node, classScope);
          if (node.id) declare(classScope, node.id.name, { kind: 'class-name' });
          if (node.superClass) prepareNode(node.superClass, classScope);
          prepareNode(node.body, classScope);
          return;
        }
        case 'ForStatement': {
          const loopScope = makeChildScope(inheritedScope, 'loop', false);
          scopeForNode.set(node, loopScope);
          if (node.init && node.init.type === 'VariableDeclaration' && node.init.kind !== 'var') {
            collectOne(node.init, loopScope, false);
          }
          if (node.init) prepareNode(node.init, loopScope);
          if (node.test) prepareNode(node.test, loopScope);
          if (node.update) prepareNode(node.update, loopScope);
          prepareNode(node.body, loopScope);
          return;
        }
        case 'ForInStatement':
        case 'ForOfStatement': {
          const loopScope = makeChildScope(inheritedScope, 'loop', false);
          scopeForNode.set(node, loopScope);
          if (node.left.type === 'VariableDeclaration' && node.left.kind !== 'var') collectOne(node.left, loopScope, false);
          prepareNode(node.right, loopScope);
          prepareNode(node.left, loopScope);
          prepareNode(node.body, loopScope);
          return;
        }
        case 'SwitchStatement': {
          prepareNode(node.discriminant, inheritedScope);
          const switchScope = makeChildScope(inheritedScope, 'switch', false);
          scopeForNode.set(node, switchScope);
          collectDirectDeclarations(node.cases.flatMap(switchCase => switchCase.consequent), switchScope, false);
          for (const switchCase of node.cases) prepareNode(switchCase, switchScope);
          return;
        }
        case 'CatchClause': {
          const catchScope = makeChildScope(inheritedScope, 'catch', false);
          scopeForNode.set(node, catchScope);
          if (node.param) {
            const names = [];
            collectPatternNames(node.param, names);
            for (const name of names) declare(catchScope, name, { kind: 'catch' });
            preparePatternExpressions(node.param, catchScope);
          }
          prepareNode(node.body, catchScope);
          return;
        }
        case 'StaticBlock': {
          const staticScope = makeChildScope(inheritedScope, 'static-block', true);
          staticScope.hasThisBinding = true;
          scopeForNode.set(node, staticScope);
          collectDirectDeclarations(node.body, staticScope, false);
          for (const statement of node.body) prepareNode(statement, staticScope);
          return;
        }
        case 'PropertyDefinition': {
          if (node.computed) prepareNode(node.key, currentScope);
          if (node.value) {
            const fieldScope = makeChildScope(currentScope, 'class-field', false);
            fieldScope.hasThisBinding = true;
            scopeForNode.set(node.value, fieldScope);
            prepareNode(node.value, fieldScope);
          }
          return;
        }
        case 'VariableDeclaration':
          if (node.kind === 'var') {
            const varScope = currentScope.varScope || currentScope;
            collectOne(node, varScope, true);
          } else {
            collectOne(node, currentScope, true);
          }
          for (const declaration of node.declarations) {
            preparePatternExpressions(declaration.id, currentScope);
            if (declaration.init) prepareNode(declaration.init, currentScope);
          }
          return;
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
          return;
        case 'ExportNamedDeclaration':
          if (node.declaration) prepareNode(node.declaration, currentScope);
          return;
        case 'ExportDefaultDeclaration':
          prepareNode(node.declaration, currentScope);
          return;
        default:
          forEachChild(node, child => prepareNode(child, currentScope));
      }
    }

    function detectsTopLevelAwait(node) {
      let found = false;
      function visit(current) {
        if (!current || found) return;
        if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ArrowFunctionExpression') return;
        if (current.type === 'AwaitExpression' || (current.type === 'ForOfStatement' && current.await)) {
          found = true;
          return;
        }
        forEachChild(current, child => visit(child));
      }
      visit(node);
      return found;
    }

    function forEachChild(node, callback) {
      for (const key of Object.keys(node)) {
        if (key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'comments' || key === 'tokens') continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && typeof child.type === 'string') callback(child, key);
          }
        } else if (value && typeof value === 'object' && typeof value.type === 'string') {
          callback(value, key);
        }
      }
    }
  }

  return { compile };
}
