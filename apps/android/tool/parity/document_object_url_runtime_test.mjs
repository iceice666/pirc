import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
import test from 'node:test';
const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
function runtime(nonce = 'a'.repeat(48)) {
  const ctx = vm.createContext({});
  vm.runInContext(bundle, ctx);
  const initial = JSON.parse(vm.runInContext(`__pircDocument.init(${JSON.stringify({html:'<p id="result">WAIT</p>', url:'https://example.test/blob',objectUrlNonce:nonce})})`,ctx));
  assert.deepEqual(initial.diagnostics.filter(d=>d.severity==='error'), []);
  return ctx;
}
const evaluate = (ctx,source) => vm.runInContext(source,ctx,{timeout:3000});
test('bundled globals resolve blob fetch without native HTTP, preserve bytes and revoke future reads',async()=>{
  const ctx=runtime();
  await evaluate(ctx,`(async()=>{
    const u=URL.createObjectURL(new Blob([new Uint8Array([0,127,128,255])],{type:'application/octet-stream'}));
    window.url=u;window.pending=fetch(u);URL.revokeObjectURL(u);
    const response=await pending;window.result={status:response.status,type:response.type,url:response.url===u,bytes:Array.from(new Uint8Array(await response.clone().arrayBuffer())),length:response.headers.get('content-length')};
    try{await fetch(u);result.revoked=false;}catch(e){result.revoked=e.name;}
  })()`);
  assert.deepEqual(JSON.parse(evaluate(ctx,'JSON.stringify(result)')),{status:200,type:'basic',url:true,bytes:[0,127,128,255],length:'4',revoked:'TypeError'});
  assert.deepEqual(JSON.parse(evaluate(ctx,'__pircDocument.snapshot()')).resourceRequests,[]);
  assert.equal(JSON.parse(evaluate(ctx,'__pircDocument.readObjectURL(url)')).ok,false);
});
test('bundled host byte bridge stays scoped and preserves fragment-normalized identity',()=>{
  const first=runtime(),second=runtime('b'.repeat(48));
  const url=evaluate(first,`URL.createObjectURL(new Blob(['native'],{type:'text/plain'}))`);
  const read=JSON.parse(evaluate(first,`__pircDocument.readObjectURL(${JSON.stringify(url+'#preview')})`));
  assert.deepEqual(read,{ok:true,url,type:'text/plain',size:6,bytesBase64:'bmF0aXZl'});
  assert.equal(JSON.parse(evaluate(second,`__pircDocument.readObjectURL(${JSON.stringify(url)})`)).ok,false);
});
test('blob fetch range uses bounded bytes and abort does not enqueue native work',async()=>{
  const ctx=runtime();
  await evaluate(ctx,`(async()=>{
    const u=URL.createObjectURL(new Blob(['abcdef'],{type:'text/plain'}));
    const r=await fetch(u+'#part',{headers:{Range:'bytes=2-4'}});
    window.result=[r.status,r.statusText,r.headers.get('content-range'),await r.text()];
    const c=new AbortController();const p=fetch(u,{signal:c.signal});c.abort();
    try{await p;result.push('bad');}catch(e){result.push(e.name);}
  })()`);
  assert.deepEqual(JSON.parse(evaluate(ctx,'JSON.stringify(result)')),[206,'OK','bytes 2-4/6','cde','AbortError']);
  assert.deepEqual(JSON.parse(evaluate(ctx,'__pircDocument.snapshot()')).resourceRequests,[]);
});
