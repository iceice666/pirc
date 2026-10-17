import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const helperSource = await readFile(new URL('./document_modules_compiler_source.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const acorn = require('./vendor/acorn-8.18.0/acorn.js');
const createCompiler = vm.runInNewContext(`${helperSource}\ncreatePircDocumentModuleCompiler`);
const compiler = createCompiler(acorn);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function factoryFor(compilation) {
  return Function(`return ${compilation.code}`)();
}

function invokeFactory(compilation, dependencies = [], context = { meta: {}, import: (...args) => Promise.resolve(args) }) {
  let getters;
  if (!context.globalEval) context.globalEval = source => (0, eval)(source);
  const generator = factoryFor(compilation)(dependencies, context, registered => { getters = registered; });
  const initial = generator.next();
  if (compilation.async) {
    return Promise.resolve(initial).then(result => {
      assert.equal(result.done, false);
      return { generator, getters, context };
    });
  }
  assert.deepEqual(initial, { value: undefined, done: false });
  return { generator, getters, context };
}

function immutableNamespace(values) {
  const namespace = Object.create(null);
  for (const [name, getter] of Object.entries(values)) {
    Object.defineProperty(namespace, name, {
      enumerable: true,
      configurable: false,
      get: typeof getter === 'function' ? getter : () => getter,
    });
  }
  return Object.preventExtensions(namespace);
}

test('registers hoisted functions and live lexical getters before executing declarations', async () => {
  const compilation = compiler.compile(`
    export let later = 1;
    export function read() { return later; }
  `, 'https://example.test/entry.js');
  assert.equal(compilation.async, false);
  const { generator, getters } = invokeFactory(compilation);

  assert.equal(typeof getters.read(), 'function');
  assert.throws(() => getters.later(), ReferenceError);
  assert.throws(() => getters.read()(), ReferenceError);

  assert.deepEqual(generator.next(), { value: undefined, done: true });
  assert.equal(getters.later(), 1);
  assert.equal(getters.read()(), 1);
});

test('rewrites imported reads by binding scope and uses read-only namespace writes', async () => {
  const compilation = compiler.compile(`
    import { value } from './dep.js';
    export function sample() {
      const object = { value };
      const mapped = { [value]: value };
      const { [value]: fromKey } = { [value]: 11 };
      function shadow(value) { return { value }; }
      function defaultParam(arg = value) { var value = 3; return arg; }
      function varShadow() { return value; var value = 12; }
      { let value = 4; if (value !== 4) throw new Error('block shadow'); }
      for (let value of [5]) { if (value !== 5) throw new Error('loop shadow'); }
      try { throw 7; } catch (value) { if (value !== 7) throw new Error('catch shadow'); }
      return [object.value, mapped[value], fromKey, shadow(8).value, defaultParam(), varShadow()];
    }
    export function write() { value = 2; }
    export function destructureWrite() { ({ value } = { value: 2 }); }
    export function defaultWrite() { ({ value = 2 } = {}); }
  `);
  assert.deepEqual(plain(compilation.imports), [{ dependency: 0, name: 'value', local: 'value' }]);
  const dependency = immutableNamespace({ value: () => currentValue });
  let currentValue = 6;
  const { generator, getters } = invokeFactory(compilation, [dependency]);
  assert.deepEqual(generator.next(), { value: undefined, done: true });
  assert.deepEqual(getters.sample()(), [6, 6, 11, 8, 6, undefined]);

  currentValue = 9;
  assert.deepEqual(getters.sample()(), [9, 9, 11, 8, 9, undefined]);
  assert.throws(() => getters.write()(), TypeError);
  assert.throws(() => getters.destructureWrite()(), TypeError);
  assert.throws(() => getters.defaultWrite()(), TypeError);
});

test('keeps local import aliases available to getters and reports indirect exports', () => {
  const compilation = compiler.compile(`
    import fallback, { "odd-name" as local } from './dep.js';
    import * as ns from './dep.js';
    export { local as namedAlias, ns as namespaceAlias, fallback as defaultAlias };
    export { remote as exposed, default as other } from './reexport.js';
    export * from './star.js';
    export * as starNamespace from './namespace.js';
  `);
  assert.deepEqual(plain(compilation.dependencies), ['./dep.js', './reexport.js', './star.js', './namespace.js']);
  assert.deepEqual(plain(compilation.imports), [
    { dependency: 0, name: 'default', local: 'fallback' },
    { dependency: 0, name: 'odd-name', local: 'local' },
    { dependency: 0, name: '*', local: 'ns' },
  ]);
  assert.deepEqual(plain(compilation.exports), [
    { name: 'namedAlias', local: 'local' },
    { name: 'namespaceAlias', local: 'ns' },
    { name: 'defaultAlias', local: 'fallback' },
  ]);
  assert.deepEqual(plain(compilation.reexports), [
    { name: 'exposed', dependency: 1, imported: 'remote' },
    { name: 'other', dependency: 1, imported: 'default' },
    { name: 'starNamespace', dependency: 3, imported: '*' },
  ]);
  assert.deepEqual(plain(compilation.stars), [2]);
});

test('transforms import.meta and dynamic import through the private context parameter', async () => {
  const compilation = compiler.compile(`
    export const meta = import.meta;
    export async function load(specifier, options) { return import(specifier, options); }
  `);
  assert.equal(compilation.async, false, 'await inside an async function is not top-level await');
  const calls = [];
  const context = {
    meta: { url: 'https://example.test/base/entry.js' },
    import(specifier, options) {
      calls.push([this, specifier, options]);
      return Promise.resolve('loaded');
    },
  };
  const { generator, getters } = invokeFactory(compilation, [], context);
  assert.deepEqual(generator.next(), { value: undefined, done: true });
  assert.equal(getters.meta(), context.meta);
  assert.equal(await getters.load()('feature.js', { with: { type: 'json' } }), 'loaded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], context);
  assert.equal(calls[0][1], 'feature.js');
  assert.deepEqual(calls[0][2], { with: { type: 'json' } });
});

test('suspends and resumes real top-level await in an async generator', async () => {
  let resolveValue;
  const waitForValue = new Promise(resolve => { resolveValue = resolve; });
  const compilation = compiler.compile(`import { waitForValue } from './dep.js'; export let result = await waitForValue;`);
  assert.equal(compilation.async, true);
  assert.equal(compilation.hasTopLevelAwait, true);
  const dependency = immutableNamespace({ waitForValue: () => waitForValue });
  const { generator, getters } = await invokeFactory(compilation, [dependency], { meta: {}, import: () => {} });
  await assert.rejects(Promise.resolve().then(() => getters.result()), ReferenceError);
  const completion = generator.next();
  resolveValue(42);
  assert.deepEqual(await completion, { value: undefined, done: true });
  assert.equal(getters.result(), 42);
});

test('preserves anonymous default function and class names and default-expression TDZ', async () => {
  const functionCompilation = compiler.compile(`export default function () { return this; }`);
  const functionModule = invokeFactory(functionCompilation);
  assert.equal(functionModule.getters.default().name, 'default');
  assert.equal(functionModule.getters.default()(), undefined);
  assert.deepEqual(functionModule.generator.next(), { value: undefined, done: true });

  const classCompilation = compiler.compile(`export default class {}`);
  const classModule = invokeFactory(classCompilation);
  assert.throws(() => classModule.getters.default(), ReferenceError);
  assert.deepEqual(classModule.generator.next(), { value: undefined, done: true });
  assert.equal(classModule.getters.default().name, 'default');

  const expressionCompilation = compiler.compile(`export default 17;`);
  const expressionModule = invokeFactory(expressionCompilation);
  assert.throws(() => expressionModule.getters.default(), ReferenceError);
  assert.deepEqual(expressionModule.generator.next(), { value: undefined, done: true });
  assert.equal(expressionModule.getters.default(), 17);
});

test('preserves module undefined this while keeping nested function this bindings', () => {
  const compilation = compiler.compile(`
    export const moduleThis = this;
    export const arrowThis = () => this;
    export function localThis() { return this; }
    export class Receiver { method() { return this; } field = () => this; }
  `);
  const { generator, getters } = invokeFactory(compilation);
  assert.deepEqual(generator.next(), { value: undefined, done: true });
  assert.equal(getters.moduleThis(), undefined);
  assert.equal(getters.arrowThis()(), undefined);
  const receiver = { marker: true };
  assert.equal(getters.localThis().call(receiver), receiver);
  const instance = new (getters.Receiver())();
  assert.equal(instance.method(), instance);
  assert.equal(instance.field(), instance);
});

test('rewrites module and arrow arguments while preserving ordinary function arguments', () => {
  const compilation = compiler.compile(`
    export const moduleType = typeof arguments;
    export const arrowType = () => typeof arguments;
    export const arrowRead = () => arguments;
    export function localArguments() { return arguments.length; }
  `);
  const { generator, getters } = invokeFactory(compilation);
  assert.deepEqual(generator.next(), { value: undefined, done: true });
  assert.equal(getters.moduleType(), 'undefined');
  assert.equal(getters.arrowType()(), 'undefined');
  assert.throws(() => getters.arrowRead()(), ReferenceError);
  assert.equal(getters.localArguments()(1, 2, 3), 3);
});

test('rejects static module attributes rather than silently removing them', () => {
  assert.throws(
    () => compiler.compile(`import data from './data.json' with { type: 'json' };`),
    /Static module attributes are not supported/,
  );
  assert.throws(
    () => compiler.compile(`export { value } from './data.json' with { type: 'json' };`),
    /Static module attributes are not supported/,
  );
});

test('reports direct eval binding limitations and forwards syntax errors', () => {
  const compilation = compiler.compile(`import { value } from './dep.js'; export function read() { return eval('value'); }`);
  assert.equal(compilation.limitations.length, 1);
  assert.match(compilation.limitations[0], /Direct eval/);
  assert.throws(() => compiler.compile('export const = ;', 'https://example.test/broken.js'), error => {
    assert.equal(error.name, 'SyntaxError');
    return true;
  });
});
