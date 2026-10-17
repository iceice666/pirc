import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const parser=require('./vendor/acorn-8.18.0/acorn.js');
const compilerSource=readFileSync(new URL('./document_modules_compiler_source.js',import.meta.url),'utf8');
const loaderSource=readFileSync(new URL('./document_modules_source.js',import.meta.url),'utf8');
function environment(sources) {
  const context=vm.createContext({parser, URL});
  const calls=[];
  context.fetchModule=async (url,options)=>{
    calls.push({url,options});
    const source=sources[url];
    if(source===undefined)throw new TypeError('404 '+url);
    return typeof source==='string'?{source,url}:source;
  };
  vm.runInContext(compilerSource+'\n'+loaderSource+`\nglobalThis.loader=createPircDocumentModules({compiler:createPircDocumentModuleCompiler(parser),URL,fetch:fetchModule});`,context);
  return {context,loader:context.loader,calls};
}
const origin='https://document.example/';
const json=value=>JSON.parse(JSON.stringify(value));
async function execute(env,source,url=origin+'main.js') {
  const record=await env.loader.inline(source,url);
  await env.loader.execute(record);
  return record;
}

test('static graphs preserve live exports and read-only module namespaces',async()=>{
  const env=environment({[origin+'state.js']:'export let count=1; export function increment(){count++}'});
  const root=await execute(env,`import {count,increment} from './state.js'; import * as state from './state.js'; globalThis.values=[count]; increment(); values.push(count,state.count); globalThis.namespace=state;`);
  assert.deepEqual(json(env.context.values),[1,2,2]);
  assert.equal(Object.getPrototypeOf(env.context.namespace),null);
  assert.equal(Object.isExtensible(env.context.namespace),false);
  assert.equal(Object.prototype.toString.call(env.context.namespace),'[object Module]');
  assert.throws(()=>vm.runInContext('"use strict"; namespace.count=20',env.context),/read only|getter|set property/i);
  assert.equal(env.calls.length,1);
});

test('star exports omit conflicts but preserve aliases of the same original binding',async()=>{
  const env=environment({
    [origin+'a.js']:'export let count=1; export default 9',
    [origin+'b.js']:"import {count} from './a.js'; export {count};",
    [origin+'both.js']:"export * from './a.js'; export * from './b.js';",
    [origin+'other.js']:'export let count=2',
    [origin+'conflict.js']:"export * from './a.js';export * from './other.js';export const ok=3;",
  });
  await execute(env,`import * as both from './both.js'; import * as conflict from './conflict.js'; globalThis.values=[Object.keys(both),both.count,Object.keys(conflict),conflict.ok];`);
  assert.deepEqual(json(env.context.values),[['count'],1,['ok'],3]);
});

test('missing and ambiguous named imports fail before any module body executes',async()=>{
  for(const source of ["export const other=1;globalThis.leaked=true;","export * from './a.js';export * from './b.js';globalThis.leaked=true;"]){
    const env=environment({[origin+'dep.js']:source,[origin+'a.js']:'export const value=1',[origin+'b.js']:'export const value=2'});
    await assert.rejects(env.loader.inline("import {value} from './dep.js';globalThis.ran=true;",origin+'main.js'),/unambiguous export/);
    assert.equal(env.context.leaked,undefined);assert.equal(env.context.ran,undefined);
  }
});

test('function cycles link before evaluation while lexical TDZ cycles reject',async()=>{
  const env=environment({
    [origin+'a.js']:"import {b} from './b.js';export function a(){return 'a'};globalThis.cycle=b();",
    [origin+'b.js']:"import {a} from './a.js';export function b(){return a()+'b'};",
  });
  const record=await env.loader.external(origin+'a.js');await env.loader.execute(record);
  assert.equal(env.context.cycle,'ab');
  const tdz=environment({[origin+'a.js']:"import './b.js';export let value=1;",[origin+'b.js']:"import {value} from './a.js';globalThis.cycle=value;"});
  const failing=await tdz.loader.external(origin+'a.js');await assert.rejects(tdz.loader.execute(failing),/initialization/);
  assert.equal(tdz.context.cycle,undefined);
});

test('synchronous module errors stop importers and repeat evaluation does not retry',async()=>{
  const env=environment({[origin+'bad.js']:"globalThis.attempts=(globalThis.attempts||0)+1;throw Error('failed module')"});
  const root=await env.loader.inline("import './bad.js';globalThis.leaked=true;",origin+'main.js');
  await assert.rejects(env.loader.execute(root),/failed module/);
  await assert.rejects(env.loader.execute(root),/failed module/);
  assert.equal(env.context.attempts,1);assert.equal(env.context.leaked,undefined);
});

test('top-level await starts independent siblings and delays dependent bodies',async()=>{
  const env=environment({
    [origin+'a.js']:"globalThis.trace.push('a:start');await new Promise(resolve=>globalThis.release=resolve);trace.push('a:end');export const value=2;",
    [origin+'b.js']:"trace.push('b');",
  });env.context.trace=[];
  const root=await env.loader.inline("import {value} from './a.js';import './b.js';trace.push('root:'+value)",origin+'main.js');
  const done=env.loader.execute(root);
  await Promise.resolve();assert.deepEqual(json(env.context.trace),['a:start','b']);
  env.context.release();await done;assert.deepEqual(json(env.context.trace),['a:start','b','a:end','root:2']);
});

test('redirected module response URLs determine import.meta and child resolution',async()=>{
  const env=environment({
    [origin+'entry.js']:{url:origin+'folder/main.js',source:"import {value} from './child.js';globalThis.result=[value,import.meta.url,import.meta.resolve('./asset.svg')];"},
    [origin+'folder/child.js']:'export const value=7;',
  });const root=await env.loader.external(origin+'entry.js');await env.loader.execute(root);
  assert.deepEqual(json(env.context.result),[7,origin+'folder/main.js',origin+'folder/asset.svg']);
  assert.equal(env.calls[1].url,origin+'folder/child.js');
});

test('dynamic import caches evaluation and inherits fetching options',async()=>{
  const env=environment({[origin+'dep.js']:'globalThis.count=(globalThis.count||0)+1;export const value=3;'});
  const options={crossOrigin:'use-credentials'};
  const root=await env.loader.inline("globalThis.a=import('./dep.js');globalThis.b=import('./dep.js');",origin+'main.js',options);
  await env.loader.execute(root);const [a,b]=await Promise.all([env.context.a,env.context.b]);
  assert.equal(a,b);assert.equal(a.value,3);assert.equal(env.context.count,1);assert.equal(env.calls.length,1);
  assert.equal(env.calls[0].options.crossOrigin,'use-credentials');
});

test('namespace reexports and strict module execution retain default values',async()=>{
  const env=environment({[origin+'dep.js']:'export default function(){return 4};export const value=2;'});
  await execute(env,"export * as group from './dep.js';import f from './dep.js';globalThis.result=[this,typeof arguments,f.name,f()];");
  assert.deepEqual(json(env.context.result),[null,'undefined','default',4]);
});

test('bare specifiers and unsupported import attributes reject explicitly',async()=>{
  const env=environment({});
  await assert.rejects(env.loader.inline("import value from 'unmapped';",origin+'main.js'),/bare module/);
  await assert.rejects(env.loader.import('./data.json',origin+'main.js',{with:{type:'json'}}),/import attributes/);
});
