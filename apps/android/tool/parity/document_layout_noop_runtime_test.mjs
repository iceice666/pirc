import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
const run=(context,source)=>new vm.Script(source).runInContext(context,{timeout:3000});
const invoke=(context,method,input)=>JSON.parse(run(context,'__pircDocument.'+method+'('+JSON.stringify(input)+')'));
function runtime(markup='<canvas id="target" width="120" height="60" class="chart" style="display:block;width:120px;height:60px"></canvas>') {
  const context=vm.createContext({});run(context,bundle);
  const initial=invoke(context,'init',{hostLayout:true,url:'https://example.test/noop',html:'<!doctype html>'+markup});
  run(context,'globalThis.target=document.getElementById("target");globalThis.declaration=getComputedStyle(target)');
  const id=run(context,'target.getAttribute("data-pirc-script-id")');
  const packet={revision:initial.layout.revision,generation:1,viewport:{width:390,height:844,scrollX:0,scrollY:0},
    boxes:initial.layout.ids.map(key=>key===id?{id:key,kind:'box',x:10,y:12,width:120,height:60,
      computedStyle:{width:'120px',height:'60px',display:'block'}}:{id:key,kind:'none'})};
  assert.equal(invoke(context,'updateLayout',packet).layoutAccepted,true);
  return {context,packet};
}

test('same Canvas dimensions reset bitmap/context without invalidating the measured native layout',()=>{
  const {context,packet}=runtime();
  run(context,'globalThis.ctx=target.getContext("2d");ctx.fillStyle="red";ctx.fillRect(0,0,20,20)');
  assert.equal(invoke(context,'snapshot',{}).canvases[0].commands.length,1);
  run(context,'target.height=target.height;target.width=target.width');
  assert.equal(run(context,'declaration.width'),'120px');
  assert.equal(run(context,'target.getBoundingClientRect().width'),120);
  assert.equal(run(context,'ctx.fillStyle'),'#000000');
  const snapshot=invoke(context,'snapshot',{});
  assert.equal(snapshot.layout.revision,packet.revision);
  assert.equal(snapshot.layout.required,false);
  assert.deepEqual(snapshot.canvases[0].commands,[]);
});

test('exact repeated style, class and data values retain a current measured declaration',()=>{
  const {context,packet}=runtime('<div id="target" class="chart" data-kind="bar" style="width:120px;height:60px"></div>');
  run(context,'target.style.width="120px";target.setAttribute("class","chart");target.dataset.kind="bar"');
  assert.equal(run(context,'declaration.width'),'120px');
  const snapshot=invoke(context,'snapshot',{});
  assert.equal(snapshot.layout.revision,packet.revision);
  assert.equal(snapshot.layout.required,false);
});

test('real bitmap dimension changes still fence both computed style and geometry',()=>{
  const {context,packet}=runtime();
  run(context,'target.width=121');
  assert.throws(()=>run(context,'declaration.width'),{name:'NotSupportedError'});
  assert.throws(()=>run(context,'target.getBoundingClientRect()'),{name:'NotSupportedError'});
  const snapshot=invoke(context,'snapshot',{});
  assert.ok(snapshot.layout.revision>packet.revision);
  assert.equal(snapshot.layout.required,true);
});

test('same-value resource and live-control assignments keep their invalidation fence',()=>{
  for(const [markup,change] of [
    ['<img id="target" src="https://example.test/image.png">','target.setAttribute("src",target.getAttribute("src"))'],
    ['<input id="target" value="original">','target.setAttribute("value","original")'],
  ]) {
    const {context,packet}=runtime(markup);
    run(context,change);
    assert.throws(()=>run(context,'declaration.width'),{name:'NotSupportedError'});
    const snapshot=invoke(context,'snapshot',{});
    assert.ok(snapshot.layout.revision>packet.revision);
    assert.equal(snapshot.layout.required,true);
  }
});

test('a real mutation followed by restoring an attribute remains conservatively unmeasured',()=>{
  const {context}=runtime();
  run(context,'target.setAttribute("class","other");target.setAttribute("class","chart")');
  assert.throws(()=>run(context,'declaration.width'),{name:'NotSupportedError'});
  assert.equal(invoke(context,'snapshot',{}).layout.required,true);
});
