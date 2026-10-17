import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
const origin = 'https://storage.example';
const seed = (sessionKey='a', revision=0, local=[], session=[]) => ({origin,sessionKey,generation:17,revision,quotaBytes:10485760,quotaCodeUnits:5242880,quotaEntries:50000,local,session});
function runtime() { const c=vm.createContext({}); vm.runInContext(bundle,c,{timeout:5000}); return c; }
function call(c, name, arg={}) {return JSON.parse(vm.runInContext('__pircDocument.'+name+'('+JSON.stringify(arg)+')',c,{timeout:5000}));}
function read(c, expression) {return JSON.parse(vm.runInContext('JSON.stringify('+expression+')',c,{timeout:5000}));}
function chunks(c, name, part, text) {for(let i=0;i<text.length;i+=65536) call(c,name,{part,text:text.slice(i,i+65536)});}
function sync(c,state) {
  const {local,session,...meta}=state; call(c,'storageSyncBegin',meta);
  for(const area of ['local','session']) for(const [key,value] of state[area]) {
    call(c,'storageEntryBegin',{area,keyLength:key.length,valueLength:value.length});
    chunks(c,'storageEntryPart','key',key); chunks(c,'storageEntryPart','value',value); call(c,'storageEntryEnd');
  }
  call(c,'storageSyncFinish');
}
function event(c,payload) {
  const meta={...payload};
  for(const part of ['key','oldValue','newValue','url']) {meta[part+'Length']=payload[part]==null?null:payload[part].length; delete meta[part];}
  call(c,'storageEventBegin',meta);
  for(const part of ['key','oldValue','newValue','url']) if(payload[part]!=null) chunks(c,'storageEventPart',part,payload[part]);
  return call(c,'storageEventFinish');
}
function init(c,html='<p>Storage</p>',url=origin+'/page') {return call(c,'init',{html,url});}

test('actual bundled globals, stable identity, named access and host write chunks',()=>{
 const c=runtime();sync(c,seed());
 const result=init(c,`<script>window.saved=localStorage; localStorage.name='猫😀'; sessionStorage.setItem('draft',123); window.immediate=[window.localStorage===localStorage,localStorage.name,sessionStorage.getItem('draft')];</script>`);
 assert.deepEqual(result.diagnostics.filter(x=>x.severity==='error'),[]);
 assert.deepEqual(read(c,'immediate'),[true,'猫😀','123']);
 assert.equal(result.storageWritesPending,true);
 assert.equal(call(c,'storageWritesBegin').count,2);
 assert.deepEqual(call(c,'storageWriteInfo',{index:0}),{area:'local',type:'set',generation:17,keyLength:4,valueLength:3,urlLength:(origin+'/page').length});
 assert.equal(call(c,'storageWritePart',{index:0,part:'value',offset:0}).text,'猫😀');
 call(c,'storageWritesEnd');sync(c,seed('a',2,[['name','native']],[['draft','123']]));
 assert.deepEqual(read(c,'[saved===localStorage,saved.name]'),[true,'native']);
});

test('local events cross window namespaces; session events do not; onstorage ordering works',()=>{
 const c=runtime();sync(c,seed('receiver'));init(c,`<script>
 window.seen=[];
 window.addEventListener('storage',e=>seen.push(['listener',e.key,e.newValue,e.storageArea===localStorage,e.isTrusted,e.url]));
 window.onstorage=e=>seen.push(['handler',e.key]);
 </script>`);
 const payload={area:'local',origin,sessionKey:'other',generation:17,revision:1,key:'shared',oldValue:null,newValue:'value',url:origin+'/after-push'};
 event(c,payload);
 assert.deepEqual(read(c,'seen'),[['listener','shared','value',true,true,origin+'/after-push'],['handler','shared']]);
 event(c,{...payload,area:'session',key:'private'});assert.equal(read(c,'seen.length'),2);
 event(c,{...payload,generation:16});assert.equal(read(c,'seen.length'),2);
 vm.runInContext('window.onstorage=null',c);event(c,{...payload,key:'second'});assert.equal(read(c,'seen.length'),3);
});

test('full Chrome-sized UTF16 storage uses bounded field chunks in and out of the isolate',()=>{
 const value='漢😀'.repeat(1700000); // 5.1M units, ~11.9 MB UTF8, exceeds ordinary DOM message cap.
 const c=runtime();sync(c,seed('large',0,[['large',value]]));
 const result=init(c,`<script>
 window.summary=[localStorage.large.length,localStorage.large.slice(-3)];
 sessionStorage.setItem('copy',localStorage.large);
 window.onstorage=e=>window.storageSummary=[e.newValue.length,e.newValue.slice(-3),e.storageArea===localStorage];
 </script>`);
 assert.deepEqual(result.diagnostics.filter(x=>x.severity==='error'),[]);
 assert.deepEqual(read(c,'summary'),[value.length,'漢😀']);
 assert.equal(call(c,'storageWritesBegin').count,1);
 const info=call(c,'storageWriteInfo',{index:0});assert.equal(info.valueLength,value.length);
 const parts=[];for(let offset=0;offset<info.valueLength;offset+=65536){const text=call(c,'storageWritePart',{index:0,part:'value',offset}).text;assert.ok(text.length<=65536);parts.push(text);}
 assert.equal(parts.join(''),value);call(c,'storageWritesEnd');
 event(c,{area:'local',origin,generation:17,sessionKey:'other',revision:1,key:'event',oldValue:null,newValue:value,url:origin+'/sender'});
 assert.deepEqual(read(c,'storageSummary'),[value.length,'漢😀',true]);
});

// Node's contextified global swallows exceptions from global accessor lookup;
// invoke the actual getters here. Android integration covers ordinary lookup.
test('opaque document getter implementations throw SecurityError',()=>{
 const c=runtime();init(c,`<script>window.errors=[];for(const name of ['localStorage','sessionStorage'])try{Object.getOwnPropertyDescriptor(globalThis,name).get()}catch(e){errors.push(e.name)}</script>`,'data:text/html,opaque');
 assert.deepEqual(read(c,'errors'),['SecurityError','SecurityError']);
});
