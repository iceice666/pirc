import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
function setup(html) {
 const ctx=vm.createContext({}); vm.runInContext(bundle,ctx);
 const call=(name,data={})=>JSON.parse(vm.runInContext(`__pircDocument.${name}(${JSON.stringify(data)})`,ctx));
 const initial=call('init',{url:'https://example.test/images/page',html});
 assert.deepEqual(initial.diagnostics.filter(d=>d.severity==='error'),[]);
 return {ctx,call,initial,run:source=>vm.runInContext(source,ctx)};
}
const loaded=(id,imageId='canvas-image-1')=>({id,ok:true,imageId,width:4,height:4,originClean:true});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('bundled Image loads metadata and records native drawImage without bytes',async()=>{
 const {run,call,initial}=setup(`<canvas></canvas><script>window.log=[];window.img=new Image();img.onload=()=>{log.push([img.complete,img.naturalWidth,img.currentSrc]);document.querySelector('canvas').getContext('2d').drawImage(img,2,3,8,8);};img.src='../red.png';</script>`);
 assert.equal(initial.resourceRequests.length,1);
 const req=initial.resourceRequests[0];assert.equal(req.kind,'image');assert.equal(req.url,'https://example.test/red.png');
 call('completeResource',loaded(req.id)); await flush();
 const result=call('snapshot');assert.deepEqual(result.imageReferences,['canvas-image-1']);
 assert.deepEqual(result.canvases[0].commands[0].args,['canvas-image-1',0,0,4,4,2,3,8,8]);
 assert.deepEqual(JSON.parse(run('JSON.stringify(log)')),[[true,4,'https://example.test/red.png']]);
 assert.equal(run('img instanceof HTMLImageElement && img instanceof Image'),true);
 assert.deepEqual(JSON.parse(run('JSON.stringify([img.width,img.height])')),[4,4]);
});
test('bundled onload IDL overrides inline exactly once, null and later attribute work',async()=>{
 const {run,call,initial}=setup(`<canvas></canvas><img id="im" onload="window.count+=100"><script>window.count=0;window.img=document.querySelector('#im');img.onload=()=>count++;img.src='one.png';</script>`);
 call('completeResource',loaded(initial.resourceRequests[0].id));await flush();call('snapshot');assert.equal(run('count'),1);
 run("img.onload=null;img.src='two.png'");let next=call('snapshot');call('completeResource',loaded(next.resourceRequests[0].id,'canvas-image-2'));await flush();call('snapshot');assert.equal(run('count'),1);
 run(`img.setAttribute('onload','window.count+=10');img.src='three.png'`);next=call('snapshot');call('completeResource',loaded(next.resourceRequests[0].id,'canvas-image-3'));await flush();call('snapshot');assert.equal(run('count'),11);
});
test('snapshot cloning cannot create image requests or replace source versions',async()=>{
 const {call,initial}=setup(`<canvas></canvas><img src="untouched.png" loading="lazy" srcset="large.png 2x"><script>window.img=new Image();img.src='active.png';</script>`);
 assert.equal(initial.resourceRequests.length,1);assert.match(initial.resourceRequests[0].url,/active.png$/);
 call('completeResource',loaded(initial.resourceRequests[0].id));await flush();
 for(let i=0;i<4;i++) {const result=call('snapshot');assert.deepEqual(result.resourceRequests,[]);assert.deepEqual(result.imageReferences,['canvas-image-1']);}
});
test('stale image completions cannot publish replacement images',async()=>{
 const {run,call,initial}=setup(`<canvas></canvas><script>window.log=[];window.img=new Image();img.onload=()=>log.push(img.currentSrc);img.src='old.png';</script>`);
 run("img.src='new.png'");const newer=call('snapshot').resourceRequests[0];
 assert.equal(call('completeResource',loaded(initial.resourceRequests[0].id)).resourceIgnored,true);
 call('completeResource',loaded(newer.id,'canvas-image-2'));await flush();
 assert.deepEqual(JSON.parse(run('JSON.stringify(log)')),['https://example.test/images/new.png']);
 assert.deepEqual(call('snapshot').imageReferences,['canvas-image-2']);
});
