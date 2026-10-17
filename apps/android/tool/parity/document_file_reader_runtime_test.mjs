import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundlePath=process.env.PIRC_DOCUMENT_SCRIPT_RUNTIME_BUNDLE || new URL('../../assets/document-script-runtime.js',import.meta.url);
function runtime(script='') {
 const ctx=vm.createContext({}); vm.runInContext(readFileSync(bundlePath,'utf8'),ctx,{timeout:3000});
 const result=invoke(ctx,'init',{url:'https://example.test/read',html:'<p id="result">WAIT</p><script>'+script+'</script>'});
 assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]); return ctx;
}
function invoke(ctx,method,arg={}) {return JSON.parse(vm.runInContext(`__pircDocument.${method}(${JSON.stringify(arg)})`,ctx,{timeout:3000}));}
function value(ctx,code) {return JSON.parse(vm.runInContext('JSON.stringify('+code+')',ctx,{timeout:3000}));}
async function drain(ctx) {
 let out=invoke(ctx,'snapshot');
 for(let i=0;i<100 && out.scheduler.timerDelayMs!==null;i++) {
  out=invoke(ctx,'pump',{now:(i+1)*10}); await Promise.resolve(); await Promise.resolve();
  out=invoke(ctx,'snapshot');
 }
 assert.equal(out.scheduler.timerDelayMs,null);return out;
}
const trace=`window.trace=[];window.reader=new FileReader();
for(const type of ['loadstart','progress','load','error','abort','loadend']) reader.addEventListener(type,e=>trace.push({
 type:e.type,state:reader.readyState,loaded:e.loaded,total:e.total,lengthComputable:e.lengthComputable,
 bubbles:e.bubbles,cancelable:e.cancelable,composed:e.composed,isTrusted:e.isTrusted,
 phase:e.eventPhase,target:e.target===reader,currentTarget:e.currentTarget===reader,
 error:reader.error&&reader.error.name,result:reader.result===null?'null':typeof reader.result
}));`;

test('FileReader is asynchronous, branded, exposes constants, and preserves binary/text/data URL results',async()=>{
 for(const [method,expected] of [
 ['readAsText','A尾'],['readAsArrayBuffer',[65,229,176,190]],
 ['readAsBinaryString',[65,229,176,190]],['readAsDataURL','data:application/octet-stream;base64,QeWwvg=='],
 ]) {
  const ctx=runtime(trace+`reader.${method}(new Blob([new Uint8Array([65,229,176,190])]));`);
  assert.deepEqual(value(ctx,'[reader.readyState,reader.result,reader.error,trace.length]'),[1,null,null,0]);
  await drain(ctx);
  const result=method==='readAsArrayBuffer'?'Array.from(new Uint8Array(reader.result))':method==='readAsBinaryString'?'Array.from(reader.result,c=>c.charCodeAt(0))':'reader.result';
  assert.deepEqual(value(ctx,result),expected);
  assert.deepEqual(value(ctx,'[reader.readyState,reader.error,reader instanceof EventTarget,FileReader.EMPTY,reader.LOADING,reader.DONE]'),[2,null,true,0,1,2]);
  assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['loadstart','progress','load','loadend']);
  for(const e of value(ctx,'trace')) assert.deepEqual([e.bubbles,e.cancelable,e.composed,e.isTrusted,e.phase,e.target,e.currentTarget],[false,false,false,true,2,true,true]);
 }
});

test('busy read throws InvalidStateError while type validation does not mutate the active read',async()=>{
 const ctx=runtime(trace+`reader.readAsText(new Blob(['first']));window.errors=[];
 try{reader.readAsText(new Blob(['second']));}catch(e){errors.push([e.name,e.code,e instanceof DOMException]);}
 try{reader.readAsText({});}catch(e){errors.push([e.name]);}`);
 assert.deepEqual(value(ctx,'errors'),[['InvalidStateError',11,true],['TypeError']]);
 await drain(ctx);assert.equal(value(ctx,'reader.result'),'first');
});

test('abort cancels pending tasks and a later read reuses the reader',async()=>{
 const ctx=runtime(trace+`reader.abort();reader.readAsText(new Blob(['cancel']));reader.abort();`);
 assert.deepEqual(value(ctx,'[reader.readyState,reader.result,reader.error&&reader.error.name,trace.map(e=>e.type)]'),[2,null,'AbortError',['abort','loadend']]);
 await drain(ctx); assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['abort','loadend']);
 value(ctx,`(reader.readAsText(new Blob(['again'])),true)`);await drain(ctx);
 assert.equal(value(ctx,'reader.result'),'again'); value(ctx,'(reader.abort(),true)');
 assert.deepEqual(value(ctx,'[reader.readyState,reader.result,reader.error]'),[2,'again',null]);
});

test('loadstart abort cancels, final progress abort has no effect, and load can start a new read',async()=>{
 for(const phase of ['loadstart','progress']) {
  const ctx=runtime(trace+`reader.addEventListener('${phase}',()=>reader.abort(),{once:true});reader.readAsText(new Blob(['cancel']));`);
  await drain(ctx);assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),phase==='loadstart'?['loadstart','abort','loadend']:['loadstart','progress','load','loadend']);
 }
 const ctx=runtime(trace+`reader.onload=()=>{if(reader.result==='one')reader.readAsText(new Blob(['two']));};reader.readAsText(new Blob(['one']));`);
 await drain(ctx);assert.equal(value(ctx,'reader.result'),'two');
 assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['loadstart','progress','load','loadstart','progress','load','loadend']);
});

test('FileReader property slots preserve order, removal, once and abort signals',async()=>{
 const ctx=runtime(`window.order=[];window.r=new FileReader();const a=()=>order.push('old');const b=()=>order.push('new');
 r.onload=a;r.addEventListener('load',()=>order.push('listener'));r.onload=b;
 const once=()=>order.push('once');r.addEventListener('load',once,{once:true});r.addEventListener('load',once,{once:true});
 const remove=()=>order.push('removed');r.addEventListener('load',remove);r.removeEventListener('load',remove);
 const c=new AbortController();r.addEventListener('load',()=>order.push('aborted'),{signal:c.signal});c.abort();
 r.readAsText(new Blob(['one']));`);
 await drain(ctx);assert.deepEqual(value(ctx,'order'),['new','listener','once']);
 value(ctx,`(r.onload=null,r.onload=()=>order.push('last'),r.readAsText(new Blob(['two'])),true)`);
 await drain(ctx);assert.deepEqual(value(ctx,'order'),['new','listener','once','listener','last']);
});

test('unavailable selected bytes report an asynchronous error and never fabricate a successful empty read',async()=>{
 const ctx=runtime(trace+`window.input=document.createElement('input');input.type='file';document.body.appendChild(input);`);
 const id=value(ctx,"input.getAttribute('data-pirc-script-id')");
 invoke(ctx,'dispatch',{id,type:'change',controls:[{id,fileResetVersion:'0',files:[{name:'large.bin',type:'application/octet-stream',size:3*1024*1024,lastModified:1,contentError:'Selected file contents exceed the script budget.'}]}]});
 value(ctx,'(reader.readAsText(input.files[0]),true)');
 assert.equal(value(ctx,'reader.readyState'),1);
 await drain(ctx);
 assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['loadstart','error','loadend']);
 assert.deepEqual(value(ctx,'[reader.readyState,reader.result,reader.error.name,reader.error instanceof DOMException]'),[2,null,'NotReadableError',true]);
});


test('Promise continuation can start the next read before the prior loadend',async()=>{
 const ctx=runtime(trace+`new Promise(resolve=>{reader.onload=resolve;reader.readAsText(new Blob(['first']));})
 .then(()=>{reader.onload=null;reader.readAsText(new Blob(['second']));});`);
 await drain(ctx);
 assert.equal(value(ctx,'reader.result'),'second');
 assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['loadstart','progress','load','loadstart','progress','load','loadend']);
});

test('empty reads have no progress and successful DONE abort preserves the result',async()=>{
 const ctx=runtime(trace+`reader.readAsText(new Blob([]));`); await drain(ctx);
 assert.deepEqual(value(ctx,'trace.map(e=>e.type)'),['loadstart','load','loadend']);
 value(ctx,'(reader.abort(),true)');
 assert.deepEqual(value(ctx,'[reader.readyState,reader.result,reader.error]'),[2,'',null]);
});
