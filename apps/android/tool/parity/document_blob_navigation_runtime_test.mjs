import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
import test from 'node:test';
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
function invoke(ctx,name,options={}){return JSON.parse(vm.runInContext(`__pircDocument.${name}(${JSON.stringify(options)})`,ctx));}
function runtime(html=''){
 const ctx=vm.createContext({});vm.runInContext(bundle,ctx);
 const initial=invoke(ctx,'init',{url:'blob:https://example.test/document-token',referrer:'https://example.test/creator?x=1',objectUrlNonce:'f'.repeat(48),html});
 assert.deepEqual(initial.diagnostics.filter(d=>d.severity==='error'),[]);
 return {ctx,initial};
}
function read(ctx,expression){return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`,ctx));}
test('blob documents keep opaque URL/baseURI and inherited origin plus immutable creator referrer',()=>{
 const {ctx}=runtime('<p>blob child</p>');
 assert.deepEqual(read(ctx,'[location.href,location.protocol,location.origin,document.URL,document.documentURI,document.baseURI,document.referrer]'),[
  'blob:https://example.test/document-token','blob:','https://example.test','blob:https://example.test/document-token','blob:https://example.test/document-token','blob:https://example.test/document-token','https://example.test/creator?x=1']);
 vm.runInContext('try{document.referrer="https://attacker.test/"}catch(e){}',ctx);
 assert.equal(read(ctx,'document.referrer'),'https://example.test/creator?x=1');
});
test('relative fetch fails with a blob base while explicit base enables bounded HTTP requests',async()=>{
 const {ctx}=runtime('<base href="https://example.test/assets/"><p>child</p>');
 assert.equal(read(ctx,'document.baseURI'),'https://example.test/assets/');
 vm.runInContext('fetch("relative.txt").catch(()=>{})',ctx);
 let requests=invoke(ctx,'snapshot').resourceRequests;
 assert.equal(requests.length,1);assert.equal(requests[0].url,'https://example.test/assets/relative.txt');
 const other=runtime().ctx;
 await vm.runInContext('fetch("relative.txt").then(()=>window.failure="wrong",e=>window.failure=e.name)',other);
 assert.equal(read(other,'failure'),'TypeError');
 assert.deepEqual(invoke(other,'snapshot').resourceRequests,[]);
});
test('user gesture navigation keeps blob destinations and hash identity',()=>{
 const {ctx,initial}=runtime('<button id="navigate" onclick="location.assign(URL.createObjectURL(new Blob([\'child\'],{type:\'text/plain\'})))">Open</button><button id="hash" onclick="location.hash=\'part\'">Hash</button>');
 const buttonId=(id)=>{const html=invoke(ctx,'snapshot').html;const tag=html.match(new RegExp('<button[^>]*id="'+id+'"[^>]*>'))[0];return tag.match(/data-pirc-script-id="([^\"]+)"/)[1];};
 const nav=invoke(ctx,'dispatch',{id:buttonId('navigate'),type:'click'}).navigationActions;
 assert.equal(nav.length,1);assert.equal(nav[0].kind,'navigate');assert.match(nav[0].url,/^blob:https:\/\/example\.test\//);assert.equal(nav[0].target,'_self');
 const hash=invoke(ctx,'dispatch',{id:buttonId('hash'),type:'click'}).navigationActions;
 assert.equal(hash.length,1);assert.equal(hash[0].url,'blob:https://example.test/document-token#part');
});
