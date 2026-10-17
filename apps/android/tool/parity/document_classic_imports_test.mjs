import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const require=createRequire(import.meta.url),parser=require('./vendor/acorn-8.18.0/acorn.js');
const source=readFileSync(new URL('./document_classic_imports_source.js',import.meta.url),'utf8');
function environment(prefix='') {
 const context=vm.createContext({parser});if(prefix)vm.runInContext(prefix,context);
 const calls=[];context.loadModule=(specifier,attributes,metadata)=>{calls.push({specifier,attributes,metadata});return Promise.resolve({value:7});};
 vm.runInContext(source+`\nglobalThis.rewriter=createPircDocumentClassicImports({parser,global:globalThis,globalEval:eval,importModule:loadModule});`,context);
 return {context,calls,rewrite:context.rewriter.rewrite};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('AST rewriting preserves classic globals and callback this/arguments without a source wrapper',async()=>{
 const env=environment();const metadata={baseURL:'https://example.test/base/'};
 const code=`var publicValue=3;function load(source){return import(source).then(module=>[module.value,this.flag,arguments[0],publicValue]);}globalThis.receiver={flag:5,load};globalThis.result=receiver.load('./dep.js');`;
 vm.runInContext(env.rewrite(code,metadata),env.context);
 assert.equal(vm.runInContext('publicValue',env.context),3);
 assert.deepEqual(plain(await env.context.result),[7,5,'./dep.js',3]);
 assert.equal(env.calls[0].metadata,metadata);
});

test('comments, strings, property methods, regexp and literal template text remain unmodified',async()=>{
 const env=environment();const code=`// import('comment')\nconst text="import('text')";const pattern=/import\\(/;const template=\`import('template')\`;const object={import(value){return value}};globalThis.literal=[text,pattern.source,template,object.import('property')];globalThis.result=import(/*preserved*/ './dep.js');`;
 const rewritten=env.rewrite(code,{});assert.ok(rewritten.includes("/*preserved*/ './dep.js'"));vm.runInContext(rewritten,env.context);
 await env.context.result;assert.equal(env.calls.length,1);assert.equal(env.calls[0].specifier,'./dep.js');
 assert.equal(env.context.literal[3],'property');
});

test('nested import calls and options keep their original expression order',async()=>{
 const env=environment();vm.runInContext(env.rewrite(`globalThis.result=import(import('./inner.js'),{with:{}});`,{}),env.context);
 await env.context.result;assert.equal(env.calls.length,2);assert.equal(env.calls[0].specifier,'./inner.js');assert.equal(typeof env.calls[1].specifier.then,'function');
});

test('hook names avoid both source identifiers and existing undefined global lexical bindings',async()=>{
 const env=environment('let __pircImport__0;');
 const code=`function load(__pircImport__1,window,self,globalThis){return import('./dep.js')}globalThis.result=load();`;
 const rewritten=env.rewrite(code,{});assert.match(rewritten,/__pircImport__2\(/);vm.runInContext(rewritten,env.context);await env.context.result;
 assert.equal(env.calls.length,1);
 assert.equal(vm.runInContext("Object.keys(globalThis).some(name=>name.startsWith('__pircImport_'))",env.context),false);
 assert.equal(Object.getOwnPropertyDescriptor(env.context,'__pircImport__2').writable,false);
});

test('handler return statements remain valid only with the explicit function-body parse option',async()=>{
 const env=environment();const body="return import('./dep.js')";
 assert.throws(()=>env.rewrite(body,{}),/outside of function/);
 const rewritten=env.rewrite(body,{}, {allowReturnOutsideFunction:true});
 const result=vm.runInContext('(function(event){'+rewritten+'})()',env.context);assert.equal((await result).value,7);
});
