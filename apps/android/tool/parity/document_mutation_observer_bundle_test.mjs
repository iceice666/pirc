import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';

const host = createDocumentScriptHostVm(vm);
const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
const run = (context, source) => new host.Script(source).runInContext(context, {timeout: 3000});
const invoke = (context, method, input = {}) => JSON.parse(run(context, `__pircDocument.${method}(${JSON.stringify(input)})`));
function runtime(script = '') {
  const context = vm.createContext({}, {microtaskMode: 'afterEvaluate'});
  run(context, bundle);
  const initial = invoke(context, 'init', {
    url: 'https://example.test/mutations',
    html: `<!doctype html><html><body><main id="root"><p id="nested">first</p></main><script>${script}</script></body></html>`,
  });
  assert.deepEqual(initial.diagnostics.filter(d => d.severity === 'error'), []);
  return context;
}

// These use the packaged bundle and classic-script host protocol. Android IPC
// checkpoints are checked independently by the native integration fixture.
test('packaged public observer delivers before a later Promise and survives native snapshots', () => {
  const context = runtime(`
    var events=[], records=[];
    var root=document.getElementById('root');
    var observer=new MutationObserver(function(batch,self){
      events.push('mutation');
      var receiver=this;
      records.push(...batch.map(function(r){return {
        type:r.type,target:r.target.id,oldValue:r.oldValue,name:r.attributeName,
        nodes:Array.from(r.addedNodes).map(function(n){return n.id}),
        self:self===observer,receiver:receiver===observer,
        record:r instanceof MutationRecord,nodeList:r.addedNodes instanceof NodeList
      }}));
    });
    observer.observe(root,{childList:true,attributes:true,attributeOldValue:true,subtree:true});
    root.setAttribute('data-chart','ready');
    Promise.resolve().then(function(){events.push('promise')});
    events.push('sync');
  `);
  assert.deepEqual(JSON.parse(run(context, 'JSON.stringify(events)')), ['sync', 'mutation', 'promise']);
  const expected = [{type:'attributes', target:'root', oldValue:null, name:'data-chart', nodes:[], self:true, receiver:true, record:true, nodeList:true}];
  assert.deepEqual(JSON.parse(run(context, 'JSON.stringify(records)')), expected);
  for (let index=0; index<3; index++) invoke(context,'snapshot');
  assert.deepEqual(JSON.parse(run(context, 'JSON.stringify(records)')), expected, 'private clone/marker writes must not leak');
  run(context, `var inserted=document.createElement('b');inserted.id='inserted';document.getElementById('nested').appendChild(inserted)`);
  const actual = JSON.parse(run(context,'JSON.stringify(records)'));
  assert.equal(actual.length,2);
  assert.deepEqual(actual[1], {type:'childList',target:'nested',oldValue:null,name:null,nodes:['inserted'],self:true,receiver:true,record:true,nodeList:true});
});

test('packaged snapshots preserve pending guest records and takeRecords cancels their delivery', () => {
  const context=runtime();
  run(context, `
    globalThis.count=0;
    globalThis.mo=new MutationObserver(function(records){count+=records.length});
    mo.observe(document.getElementById('root'),{attributes:true,attributeOldValue:true});
  `);
  // Mutate, serialize and take synchronously in one real guest turn, before the
  // VM checkpoint. Serialization must suppress its own records only.
  const result=JSON.parse(run(context, `(() => {
    document.getElementById('root').setAttribute('data-value','one');
    __pircDocument.snapshot();
    return JSON.stringify(mo.takeRecords().map(r=>({type:r.type,name:r.attributeName,old:r.oldValue})));
  })()`));
  assert.deepEqual(result,[{type:'attributes',name:'data-value',old:null}]);
  assert.equal(run(context,'count'),0);
  run(context, `mo.disconnect();document.getElementById('root').setAttribute('data-value','two')`);
  assert.equal(run(context,'count'),0);
});

test('packaged characterData reports the text node and original values', () => {
  const context=runtime(`
    var seen=[];
    var text=document.getElementById('nested').firstChild;
    var mo=new MutationObserver(function(records){seen.push(...records.map(r=>({type:r.type,same:r.target===text,old:r.oldValue}))) });
    mo.observe(document.getElementById('root'),{subtree:true,characterDataOldValue:true});
    text.data='second';text.nodeValue='third';
  `);
  assert.deepEqual(JSON.parse(run(context,'JSON.stringify(seen)')),[
    {type:'characterData',same:true,old:'first'},
    {type:'characterData',same:true,old:'second'},
  ]);
});


test('style property writes report one attribute record with the genuine previous value', () => {
  const context=runtime(`
    var styleRecords=[],root=document.getElementById('root');
    var mo=new MutationObserver(records=>styleRecords.push(...records.map(r=>({name:r.attributeName,old:r.oldValue}))));
    mo.observe(root,{attributes:true,attributeOldValue:true});
    root.style.width='120px';
    root.style.width='120px';
    root.style.width='121px';
    root.style.setProperty('height','60px');
    root.style.removeProperty('width');
    root.style.removeProperty('width');
    root.style.height='';
  `);
  assert.deepEqual(JSON.parse(run(context,'JSON.stringify(styleRecords)')),[
    {name:'style',old:null},
    {name:'style',old:'width:120px'},
    {name:'style',old:'width:121px'},
    {name:'style',old:'width:121px;height:60px'},
    {name:'style',old:'height:60px'},
  ]);
  assert.equal(run(context,'document.getElementById("root").style.height'),'');
});
