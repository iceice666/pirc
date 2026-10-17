import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
function setup(script){
 const context=vm.createContext({});vm.runInContext(bundle,context);
 const call=(name,args={})=>JSON.parse(vm.runInContext(`__pircDocument.${name}(${JSON.stringify(args)})`,context));
 const run=source=>vm.runInContext(source,context);
 const initial=call('init',{url:'https://example.test/docs/page',html:`<pre id="result"></pre><script>${script}</script>`,now:0});
 assert.deepEqual(initial.diagnostics.filter(e=>e.severity==='error'),[]);
 return {call,run,initial};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const complete=(id,text,other={})=>({id,ok:true,status:200,statusText:'OK',url:'https://example.test/docs/data',headers:[['content-type','text/plain;charset=UTF-8']],bodyBase64:Buffer.from(text).toString('base64'),type:'basic',...other});
test('bundled XHR uses native fetch and paints DOM after Chinese text load',async()=>{
 const {call,run,initial}=setup(`window.events=[];window.x=new XMLHttpRequest();x.onreadystatechange=()=>events.push('state'+x.readyState);x.onloadstart=()=>events.push('start');x.onload=()=>document.querySelector('#result').textContent=x.responseText;x.open('GET','data');x.send();window.sync=events.slice();`);
 assert.deepEqual(JSON.parse(run('JSON.stringify(sync)')),['state1','start']);
 assert.equal(run('x instanceof XMLHttpRequestEventTarget && x instanceof EventTarget && x.upload instanceof XMLHttpRequestUpload'),true);
 const request=initial.resourceRequests[0];assert.equal(request.kind,'fetch');assert.equal(request.url,'https://example.test/docs/data');assert.equal(request.forcePreflight,undefined);
 call('completeResource',complete(request.id,'原生 XHR 資料'));await flush();
 const final=call('snapshot');assert.match(final.html,/原生 XHR 資料/);assert.equal(run('x.status'),200);assert.equal(run('x.readyState'),4);
 assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),['state1','start','state2','state3','state4']);
});
test('bundled upload listeners force preflight and retain credential selection',async()=>{
 const {call,run,initial}=setup(`window.x=new XMLHttpRequest();window.upload=[];x.upload.onprogress=e=>upload.push(e.loaded);x.open('POST','https://cross.test/upload');x.withCredentials=true;x.setRequestHeader('Cookie','must not leave');x.setRequestHeader('X-Trace','one');x.setRequestHeader('x-trace','two');x.send('payload');`);
 const req=initial.resourceRequests[0];assert.equal(req.forcePreflight,true);assert.equal(req.credentials,'include');assert.equal(req.bodyBase64,Buffer.from('payload').toString('base64'));assert.ok(!req.headers.some(([k])=>k==='cookie'));assert.ok(req.headers.some(([k,v])=>k==='x-trace'&&v==='one, two'));assert.deepEqual(JSON.parse(run('JSON.stringify(upload)')),[]);
 call('completeResource',complete(req.id,'ok',{type:'cors',headers:[['content-type','text/plain']]}));await flush();call('snapshot');assert.deepEqual(JSON.parse(run('JSON.stringify(upload)')),[7]);
});
test('loadstart abort cannot enqueue a phantom native network request',()=>{
 const {run,initial}=setup(`window.x=new XMLHttpRequest();window.events=[];x.onloadstart=()=>x.abort();x.onabort=()=>events.push(['abort',x.readyState]);x.onloadend=()=>events.push(['end',x.readyState]);x.open('GET','no-network');x.send();`);
 assert.deepEqual(initial.resourceRequests,[]);assert.equal(run('x.readyState'),0);assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),[['abort',4],['end',4]]);
});
test('host deadline timeout discards a native completion after terminal events',async()=>{
 const {run,call,initial}=setup(`window.events=[];window.x=new XMLHttpRequest();x.open('GET','slow');x.timeout=10;x.ontimeout=()=>events.push([x.status,x.readyState]);x.send();`);
 const req=initial.resourceRequests[0];call('pump',{now:15});await flush();call('snapshot');assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),[[0,4]]);
 assert.equal(call('completeResource',complete(req.id,'late')).resourceKind,'fetch');await flush();assert.equal(run('x.status'),0);assert.equal(run('x.responseText'),'');assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),[[0,4]]);
});
test('JSON has stable identity and non-text responseText reports InvalidStateError',async()=>{
 const {run,call,initial}=setup(`window.x=new XMLHttpRequest();x.open('GET','json');x.responseType='json';x.send();`);
 call('completeResource',complete(initial.resourceRequests[0].id,'{"ok":true}',{headers:[['content-type','application/json']]}));await flush();call('snapshot');
 assert.equal(run('x.response===x.response && x.response.ok'),true);assert.equal(run(`(()=>{try{x.responseText;return null;}catch(e){return e.name;}})()`),'InvalidStateError');
});


test('JSON ignores charset and UTF-16 BOM while text keeps the declared charset',async()=>{
 const {run,call,initial}=setup(`window.x=new XMLHttpRequest();x.open('GET','json');x.responseType='json';x.send();`);
 call('completeResource',complete(initial.resourceRequests[0].id,'{"city":"台北"}',{headers:[['content-type','application/json;charset=windows-1252']]}));await flush();call('snapshot');assert.equal(run('x.response.city'),'台北');
 run(`x.open('GET','bad-json');x.send()`);const req=call('snapshot').resourceRequests[0];
 call('completeResource',complete(req.id,'',{headers:[['content-type','application/json;charset=utf-16le']],bodyBase64:Buffer.from([255,254,123,0,125,0]).toString('base64')}));await flush();assert.equal(run('x.response'),null);
});
test('XHR response Document preserves fragment siblings, final URL, base and inert window',async()=>{
 const {run,call,initial}=setup(`window.x=new XMLHttpRequest();x.open('GET','page');x.responseType='document';x.send();`);
 call('completeResource',complete(initial.resourceRequests[0].id,'<!doctype html><title>標題</title><base href="/assets/"><p>正文</p>',{headers:[['content-type','text/html']],url:'https://example.test/result'}));await flush();
 assert.deepEqual(JSON.parse(run('JSON.stringify([x.response.documentElement.localName,x.response.title,x.response.body.textContent,x.response.URL,x.response.baseURI,x.response.defaultView])')),['html','標題','正文','https://example.test/result','https://example.test/assets/',null]);
});
test('readystatechange uses Event and download progress uses trusted ProgressEvent',async()=>{
 const {run,call,initial}=setup(`window.types=[];window.x=new XMLHttpRequest();x.onreadystatechange=e=>types.push([e.type,e instanceof ProgressEvent,e.isTrusted]);x.onprogress=e=>types.push([e.type,e instanceof ProgressEvent,e.isTrusted]);x.open('GET','data');x.send();`);
 call('completeResource',complete(initial.resourceRequests[0].id,'ok'));await flush();
 const observed=JSON.parse(run('JSON.stringify(types)'));assert.ok(observed.some(e=>e[0]==='progress'&&e[1]===true&&e[2]===true));assert.ok(observed.filter(e=>e[0]==='readystatechange').every(e=>e[1]===false&&e[2]===true));
});


test('send snapshots multipart and typed bodies before loadstart handlers mutate inputs',async()=>{
 const {run,call,initial}=setup(`window.x=new XMLHttpRequest();window.data=new FormData();data.append('value','first');window.upload=[];x.upload.onprogress=e=>upload.push(e.loaded);x.onloadstart=()=>data.set('value','second');x.open('POST','upload');x.send(data);`);
 const req=initial.resourceRequests[0];const bytes=Buffer.from(req.bodyBase64,'base64');const contentType=req.headers.find(([k])=>k==='content-type')[1];const boundary=/boundary=(.*)/.exec(contentType)[1];
 assert.ok(bytes.toString().includes('first'));assert.ok(!bytes.toString().includes('second'));assert.ok(bytes.toString().includes('--'+boundary));
 call('completeResource',complete(req.id,'ok'));await flush();assert.deepEqual(JSON.parse(run('JSON.stringify(upload)')),[bytes.length]);
 run(`window.arr=new Uint8Array([1,2,255]);x.onloadstart=()=>arr.fill(9);x.open('POST','binary');x.send(arr);`);const next=call('snapshot').resourceRequests[0];assert.deepEqual([...Buffer.from(next.bodyBase64,'base64')],[1,2,255]);
});


test('download terminal events retain ProgressEvent metadata including old loadend after reentry',async()=>{
 const {run,call,initial}=setup(`window.events=[];window.x=new XMLHttpRequest();for(const type of ['load','loadend'])x.addEventListener(type,e=>{events.push([e.type,e instanceof ProgressEvent,e.loaded,e.total,e.lengthComputable,x.readyState]);if(e.type==='load')x.open('GET','next');});x.open('GET','data');x.send();`);
 call('completeResource',complete(initial.resourceRequests[0].id,'abc',{headers:[['content-type','text/plain'],['content-length','3']]}));await flush();
 assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),[['load',true,3,3,true,4],['loadend',true,3,3,true,1]]);
});


test('suspended XHR uses native completion time instead of delivery time',async()=>{
 for(const [completedAt,expected] of [[50,'load'],[150,'timeout']]) {
  const {run,call,initial}=setup(`window.events=[];window.x=new XMLHttpRequest();x.open('GET','data');x.timeout=100;x.onload=()=>events.push('load');x.ontimeout=()=>events.push('timeout');x.send();`);
  call('completeResource',complete(initial.resourceRequests[0].id,'ok',{completedAt,now:300}));await flush();call('pump',{now:300});await flush();
  assert.deepEqual(JSON.parse(run('JSON.stringify(events)')),[expected]);
  assert.equal(run('performance.now()'),300);
 }
});
