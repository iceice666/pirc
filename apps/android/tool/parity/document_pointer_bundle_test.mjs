import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
function setup(html) {
 const ctx=vm.createContext({}); vm.runInContext(bundle,ctx);
 function call(name,data={}) { return JSON.parse(vm.runInContext(`__pircDocument.${name}(${JSON.stringify(data)})`,ctx)); }
 const initial=call('init',{url:'https://example.test/canvas',html});
 assert.deepEqual(initial.diagnostics.filter(d=>d.severity==='error'),[]);
 const id=vm.runInContext('document.querySelector("canvas").getAttribute("data-pirc-script-id")',ctx);
 return {ctx,call,id};
}
const data={pointerId:3,pointerType:'touch',isPrimary:true,clientX:64,clientY:87,offsetX:40,offsetY:55,button:0,buttons:1,pressure:.5,geometry:{left:24,top:32,width:300,height:150}};
test('bundled native pointer route exposes real CSS geometry and capture while redrawing',()=>{
 const {ctx,call,id}=setup(`<canvas width="240" height="120"></canvas><script>
 window.events=[]; const c=document.querySelector('canvas');
 c.onpointerdown=e=>{events.push([e.type,e instanceof PointerEvent,e instanceof MouseEvent,e.offsetX,e.offsetY,c.getBoundingClientRect().width,c.hasPointerCapture(e.pointerId)]);c.setPointerCapture(e.pointerId);};
 c.onpointermove=e=>{c.getContext('2d').fillRect(e.offsetX*.8,e.offsetY*.8,5,5);events.push(e.type);};
 c.onpointerup=e=>events.push([e.type,e.buttons,e.pressure]);
 </script>`);
 for(const [type,eventData] of [['pointerdown',data],['pointermove',{...data,offsetX:150,clientX:174}],['pointerup',{...data,buttons:0,pressure:0}]]) {
  const result=call('dispatch',{id,type,eventData}); assert.equal(result.error,undefined);assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]);
 }
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(events)',ctx)),[['pointerdown',true,true,40,55,300,true],'pointermove',['pointerup',0,0]]);
 assert.ok(call('snapshot').canvases[0].commands.length>0);
});
test('pointer property assignment replaces inline source; null and later attributes stay effective',()=>{
 const {ctx,call,id}=setup(`<canvas onpointerdown="window.count=(window.count||0)+100"></canvas><script>
 window.count=0;document.querySelector('canvas').onpointerdown=function(e){count++;return false;};</script>`);
 assert.equal(call('dispatch',{id,type:'pointerdown',eventData:data}).defaultPrevented,true);
 assert.equal(vm.runInContext('count',ctx),1);
 vm.runInContext('document.querySelector("canvas").onpointerdown=null',ctx);
 call('dispatch',{id,type:'pointerup',eventData:{...data,buttons:0,pressure:0}});
 call('dispatch',{id,type:'pointerdown',eventData:data}); assert.equal(vm.runInContext('count',ctx),1);
 vm.runInContext('document.querySelector("canvas").setAttribute("onpointerdown","count+=10")',ctx);
 call('dispatch',{id,type:'pointerup',eventData:{...data,buttons:0,pressure:0}});
 call('dispatch',{id,type:'pointerdown',eventData:data}); assert.equal(vm.runInContext('count',ctx),11);
});
test('pointer click metadata preserves generic anchor cancellation and constructor identity',()=>{
 const {ctx,call,id}=setup(`<a href="https://example.test/next"><canvas></canvas></a><script>document.querySelector('canvas').onclick=e=>{window.clickInfo=[e instanceof PointerEvent,e.offsetX,e.buttons];return false;};</script>`);
 const result=call('dispatch',{id,type:'click',eventData:{...data,buttons:0,pressure:0}});
 assert.equal(result.defaultPrevented,true);
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(clickInfo)',ctx)),[true,40,0]);
 assert.deepEqual(result.navigationActions,[]);
});

test('captured mouse boundaries wait for release and compat move uses MouseEvent fields',()=>{
 const {ctx,call,id}=setup(`<canvas></canvas><script>window.log=[];const c=document.querySelector('canvas');c.onpointerdown=e=>c.setPointerCapture(e.pointerId);for(const type of ['pointerout','pointerleave','pointerup','lostpointercapture']) c.addEventListener(type,e=>log.push(type));c.onmousemove=e=>window.mouseMove=[e.button,e.detail];</script>`);
 const mouse={...data,pointerId:1,pointerType:'mouse'};
 const send=(type,eventData=mouse)=>call('dispatch',{id,type,eventData});
 send('pointerdown');send('pointermove',{...mouse,button:-1});
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(mouseMove)',ctx)),[0,0]);
 send('pointerout');send('pointerleave');
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)',ctx)),[]);
 send('pointerup',{...mouse,buttons:0,pressure:0});
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)',ctx)),['pointerup','lostpointercapture','pointerout','pointerleave']);
});

test('mouse pointer boundary compatibility uses MouseEvent with browser flags',()=>{
 const {ctx,call,id}=setup(`<canvas></canvas><script>window.boundaries=[];for(const type of ['mouseover','mouseenter','mouseout','mouseleave'])document.querySelector('canvas').addEventListener(type,e=>boundaries.push([e.type,e instanceof MouseEvent,e instanceof PointerEvent,e.clientX,e.clientY,e.detail,e.bubbles,e.cancelable,e.composed]));</script>`);
 const mouse={...data,pointerId:1,pointerType:'mouse',buttons:0,pressure:0};
 for(const type of ['pointerover','pointerenter','pointerout','pointerleave'])call('dispatch',{id,type,eventData:mouse});
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(boundaries)',ctx)),[
  ['mouseover',true,false,64,87,0,true,true,true],
  ['mouseenter',true,false,64,87,0,false,false,false],
  ['mouseout',true,false,64,87,0,true,true,true],
  ['mouseleave',true,false,64,87,0,false,false,false]
 ]);
});

test('native outside-touch mouseout resolves current related target and retains coordinates',()=>{
 const {ctx,call,id}=setup(`<canvas></canvas><button id="other">Other</button><script>document.querySelector('canvas').onmouseout=e=>{window.exit=[e instanceof MouseEvent,e.clientX,e.clientY,e.relatedTarget===document.getElementById('other'),e.detail,e.bubbles,e.cancelable,e.isTrusted];};</script>`);
 const other=vm.runInContext('document.getElementById("other").getAttribute("data-pirc-script-id")',ctx);
 const result=call('dispatch',{id,type:'mouseout',eventData:{clientX:385,clientY:120,relatedTarget:other}});
 assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]);
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(exit)',ctx)),[true,385,120,true,0,true,true,true]);
 // An unknown or removed related target cannot cross document ownership.
 call('dispatch',{id,type:'mouseout',eventData:{clientX:385,clientY:120,relatedTarget:'missing'}});
 assert.equal(vm.runInContext('exit[3]',ctx),false);
});

test('captured mouse boundaries emit compatibility exit once after capture release',()=>{
 const {ctx,call,id}=setup(`<canvas></canvas><script>window.log=[];const c=document.querySelector('canvas');c.onpointerdown=e=>c.setPointerCapture(e.pointerId);for(const type of ['pointerout','pointerleave','pointerup','lostpointercapture','mouseout','mouseleave'])c.addEventListener(type,e=>log.push(type));</script>`);
 const mouse={...data,pointerId:1,pointerType:'mouse'};
 for(const type of ['pointerdown','pointerout','pointerleave'])call('dispatch',{id,type,eventData:mouse});
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)',ctx)),[]);
 call('dispatch',{id,type:'pointerup',eventData:{...mouse,buttons:0,pressure:0}});
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(log)',ctx)),['pointerup','lostpointercapture','pointerout','mouseout','pointerleave','mouseleave']);
});
