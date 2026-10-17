import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
const bundle=readFileSync(new URL('../../assets/document-script-runtime.js',import.meta.url),'utf8');
function runtime(html) {
  const c=vm.createContext({});vm.runInContext(bundle,c,{timeout:5000});
  return {c,initial:call(c,'init',{html,url:'https://page.example/docs/page'})};
}
function call(c,name,arg={}) {return JSON.parse(vm.runInContext('__pircDocument.'+name+'('+JSON.stringify(arg)+')',c,{timeout:5000}));}
function read(c,expression) {return JSON.parse(vm.runInContext('JSON.stringify('+expression+')',c,{timeout:5000}));}
function run(c,source) {vm.runInContext(source,c,{timeout:5000});return call(c,'snapshot');}

test('bundled style CSSOM edits and current media/disabled reach host without changing DOM source',()=>{
 const {c,initial}=runtime('<style id="s">p {color:red}</style><p>Probe</p>');
 const request=initial.resourceRequests.find(x=>x.kind==='stylesheet');
 assert.match(request.id,/^stylesheet-[1-9]/);
 call(c,'completeResource',{id:request.id,ok:true});
 let snapshot=run(c,`window.saved=document.querySelector('#s').sheet;saved.insertRule('p {width:123px}',1);saved.cssRules[0].style.setProperty('color','blue');`);
 assert.match(snapshot.stylesheets.sheets[0].cssText,/color: blue/);
 assert.match(snapshot.stylesheets.sheets[0].cssText,/width: 123px/);
 assert.match(snapshot.html,/p \{color:red\}/);
 assert.equal(snapshot.resourceRequests[0].notifyLoad,false);
 const next=run(c,`document.querySelector('#s').media='(min-width:600px)';saved.disabled=true`);
 assert.equal(next.stylesheets.sheets[0].disabled,true);
 assert.equal(next.stylesheets.sheets[0].media,'(min-width:600px)');
 assert.equal(next.resourceRequests.length,0);
 snapshot=run(c,`document.querySelector('#s').textContent='p{height:17px}';window.newIdentity=document.querySelector('#s').sheet!==saved;`);
 assert.equal(read(c,'newIdentity'),true);
 assert.match(snapshot.stylesheets.sheets[0].cssText,/height/);
});

test('external CSS bytes never enter JS while load/error events and document load wait for current request',()=>{
 const {c,initial}=runtime(`<link id="theme" rel="stylesheet" href="theme.css" crossorigin="anonymous" integrity="sha256-example" referrerpolicy="no-referrer"><script>
 window.events=[];document.querySelector('#theme').addEventListener('load',()=>events.push('sheet'));document.querySelector('#theme').addEventListener('error',()=>events.push('error'));window.addEventListener('load',()=>events.push('window'));
 </script>`);
 const request=initial.resourceRequests[0];
 assert.equal(request.url,'https://page.example/docs/theme.css');
 assert.equal(request.crossOrigin,'anonymous');
 assert.equal(request.referrerPolicy,'no-referrer');
 assert.equal(request.stylesheetReferrerUrl,'https://page.example/docs/page');
 assert.equal(initial.stylesheets.links[0].referrerPolicy,'no-referrer');
 assert.equal(initial.stylesheets.links[0].stylesheetReferrerUrl,'https://page.example/docs/page');
 assert.equal(initial.stylesheets.links[0].crossOrigin,'anonymous');
 assert.equal('cssText' in request,false);
 assert.deepEqual(read(c,'events'),[]);
 const loaded=call(c,'completeResource',{id:request.id,ok:true,bodyBytes:[83,69,67,82,69,84],source:'SECRET_CROSS_ORIGIN_CSS'});
 assert.deepEqual(read(c,'events'),['sheet','window']);
 assert.equal(JSON.stringify(loaded).includes('SECRET_CROSS_ORIGIN_CSS'),false);
 const changed=run(c,`document.querySelector('#theme').href='replacement.css'`);
 const replacement=changed.resourceRequests[0];
 assert.equal(changed.stylesheets.links[0].loadState,'pending');
 assert.equal(call(c,'completeResource',{id:request.id,ok:true}).resourceIgnored,true);
 call(c,'completeResource',{id:replacement.id,ok:false,error:'HTTP 404'});
 assert.deepEqual(read(c,'events'),['sheet','window','error']);
});

test('replaced and removed pending stylesheets cancel once; a base change keeps selected URL frozen',()=>{
 const {c,initial}=runtime('<base href="https://assets.example/a/"><link id="theme" rel="stylesheet" href="theme.css">');
 const first=initial.resourceRequests[0];
 let snapshot=run(c,`document.querySelector('base').href='https://assets.example/b/'`);
 assert.equal(snapshot.resourceRequests.length,0);
 assert.equal(snapshot.stylesheets.links[0].href,'https://assets.example/b/theme.css');
 assert.equal(snapshot.stylesheets.links[0].fetchHref,'https://assets.example/a/theme.css');
 snapshot=run(c,`document.querySelector('#theme').href='new.css'`);
 assert.deepEqual(snapshot.resourceCancellations,[first.id]);
 const second=snapshot.resourceRequests[0];
 assert.equal(second.url,'https://assets.example/b/new.css');
 snapshot=run(c,`document.querySelector('#theme').remove()`);
 assert.deepEqual(snapshot.resourceCancellations,[second.id]);
 assert.equal(call(c,'snapshot').resourceCancellations.length,0);
 assert.equal(call(c,'completeResource',{id:second.id,ok:true}).resourceIgnored,true);
});

test('load handler mutations are rescanned before completion response is returned',()=>{
 const {c,initial}=runtime(`<link id="a" rel="stylesheet" href="first.css"><script>
 document.querySelector('#a').addEventListener('load',()=>{let s=document.createElement('style');s.textContent='p{color:green}';document.head.append(s)});
 </script><p>Probe</p>`);
 const loaded=call(c,'completeResource',{id:initial.resourceRequests[0].id,ok:true});
 assert.equal(loaded.stylesheets.sheets.length,1);
 assert.equal(loaded.resourceRequests.length,1);
 assert.equal(loaded.resourceRequests[0].ownerType,'style');
 assert.match(loaded.stylesheets.sheets[0].cssText,/green/);
});

test('initial CSSOM inspection preserves raw seed identity and a changed base keeps the selected link',()=>{
 const source='@import "child.css"; .probe {color: red}';
 const {initial}=runtime(`<base href="https://assets.example/one/"><style id="inspect">${source}</style><link rel="stylesheet" href="theme.css"><script>
 window.rules=document.querySelector('#inspect').sheet.cssRules.length;
 window.again=document.querySelector('#inspect').sheet;
 document.querySelector('base').href='https://assets.example/two/';
 </script>`);
 assert.equal(initial.stylesheets.sheets[0].cssText,source);
 assert.equal(initial.resourceRequests.filter(item=>item.ownerType==='style').length,1);
 assert.equal(initial.resourceCancellations.length,0);
 assert.equal(initial.stylesheets.links[0].fetchHref,'https://assets.example/one/theme.css');
 assert.equal(initial.stylesheets.links[0].baseURL,'https://assets.example/two/');
 assert.equal(initial.resourceRequests.find(item=>item.ownerType==='link').url,'https://assets.example/one/theme.css');
});
