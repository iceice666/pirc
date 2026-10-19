import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);
import test from 'node:test';
const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
function runtime(html = '', url = 'https://example.test/start', history = {}) {
  const context = vm.createContext({});
  vm.runInContext(bundle, context, {timeout: 3000});
  const call = (method, data) => JSON.parse(vm.runInContext(`__pircDocument.${method}(${JSON.stringify(data)})`, context, {timeout: 3000}));
  const run = code => vm.runInContext(code, context, {timeout: 3000});
  const json = code => JSON.parse(run(`JSON.stringify(${code})`));
  const initial = call('init', {html, url, history: {entryKey: 'native-1', index: 1, length: 2, ...history}});
  assert.equal(initial.diagnostics.some(d => d.severity === 'error'), false, JSON.stringify(initial.diagnostics));
  return {context, call, run, json, initial};
}
function snapshot(action, extras = {}) {
  return {url: action.url, entryKey: action.entryKey, stateGraph: action.stateGraph,
    index: 2, length: 3, ackRevision: action.revision, scrollRestoration: 'auto', ...extras};
}
test('startup exposes one History instance and initial state before page scripts', () => {
  const r = runtime('<script>window.startup = [history.length, history.state, history === window.history, history instanceof History]</script>');
  assert.deepEqual(r.json('window.startup'), [2, null, true, true]);
  assert.equal(r.run('Object.prototype.toString.call(history)'), '[object History]');
  assert.throws(() => r.run('new History()'), /Illegal constructor/);
  assert.throws(() => r.run('History.prototype.back.call({})'), /Illegal invocation/);
});
test('push/replace update all live URL getters synchronously without events or network', () => {
  const r = runtime('<base href="/base/"><script>window.events=[]; window.onpopstate=e=>events.push(e.type); window.onhashchange=e=>events.push(e.type)</script>');
  r.run('history.pushState({page:1}, "", "next?x=1#section"); history.replaceState({page:2}, "", "#two")');
  assert.deepEqual(r.json('[location.href,document.URL,document.documentURI,document.baseURI,history.length,history.state,events]'),
    ['https://example.test/base/#two', 'https://example.test/base/#two',
      'https://example.test/base/#two', 'https://example.test/base/', 3, {page:2}, []]);
  const response = r.call('snapshot', {});
  assert.deepEqual(response.navigationActions.map(a => a.method), ['push', 'replace']);
  assert.equal(response.navigationActions[0].entryKey, response.navigationActions[1].entryKey);
  assert.deepEqual(response.resourceRequests, []);
});
test('nullable and empty URLs preserve current URL despite a different base', () => {
  const r = runtime('<base href="https://elsewhere.test/">');
  r.run('history.pushState(1, ""); history.pushState(2, "", null); history.pushState(3, "", undefined); history.pushState(4, "", "")');
  assert.equal(r.run('location.href'), 'https://example.test/start');
  assert.equal(r.run('history.length'), 6);
});
test('state cloning is atomic, detached from input, stable on ack, fresh on traversal', () => {
  const r = runtime('<script>window.events=[]; window.onpopstate=e=>events.push([e.type,e.isTrusted,e.state===history.state,e.state]); window.onhashchange=e=>events.push([e.type,e.isTrusted,e.oldURL,e.newURL])</script>');
  r.run('window.input={nested:{value:1}}; input.self=input; history.pushState(input,"","#one"); window.pushed=history.state; input.nested.value=2; history.state.nested.value=3');
  const push = r.call('snapshot', {}).navigationActions[0];
  r.call('updateHistory', snapshot(push));
  assert.equal(r.run('history.state === pushed'), true);
  assert.equal(r.run('history.state.nested.value'), 3);
  assert.equal(r.run('history.state.self === history.state'), true);
  r.call('updateHistory', {url:'https://example.test/start', entryKey:'native-1', index:1,length:3,ackRevision:1});
  r.call('updateHistory', snapshot(push));
  assert.equal(r.run('history.state === pushed'), false);
  assert.equal(r.run('history.state.nested.value'), 1);
  assert.deepEqual(r.json('events.map(e=>e.slice(0,3))'), [['popstate',true,true],['hashchange',true,'https://example.test/start#one'],['popstate',true,true],['hashchange',true,'https://example.test/start']]);
});
test('same URL entries and null states still produce traversal popstate, not push events', () => {
  const r = runtime('<script>window.events=[]; window.onpopstate=e=>events.push([e.type,e.state,e.isTrusted]); window.onhashchange=e=>events.push(e.type)</script>');
  r.run('history.pushState(null,"",location.href)');
  const push = r.call('snapshot', {}).navigationActions[0];
  assert.deepEqual(r.json('events'), []);
  r.call('updateHistory', snapshot(push));
  assert.deepEqual(r.json('events'), []);
  r.call('updateHistory', {url:'https://example.test/start', entryKey:'native-1',index:1,length:3,ackRevision:1});
  assert.deepEqual(r.json('events'), [['popstate',null,true]]);
});
test('host fragment navigation emits popstate before hashchange, including empty hash', () => {
  const r = runtime('<script>window.events=[]; window.onpopstate=e=>events.push([e.type,history.state,location.href]); window.onhashchange=e=>events.push([e.type,e.oldURL,e.newURL])</script>');
  r.call('updateHistory', {url:'https://example.test/start#', entryKey:'native-2',index:2,length:3,ackRevision:0});
  assert.deepEqual(r.json('events'), [['popstate',null,'https://example.test/start#'], ['hashchange','https://example.test/start','https://example.test/start#']]);
});
test('stale acknowledgments never roll back a later synchronous mutation', () => {
  const r = runtime();
  r.run('history.pushState(1,"","?one"); history.pushState(2,"","?two")');
  const [one,two] = r.call('snapshot', {}).navigationActions;
  r.call('updateHistory', snapshot(one));
  assert.equal(r.run('location.search'), '?two');
  assert.equal(r.run('history.state'), 2);
  r.call('updateHistory', snapshot(two,{index:3,length:4}));
  assert.equal(r.run('history.length'),4);
});
test('popstate listener pushes cannot change captured hashchange URLs', () => {
  const r = runtime('<script>window.events=[]; window.onpopstate=()=>history.pushState(9,"","#listener"); window.onhashchange=e=>events.push([e.oldURL,e.newURL,location.href])</script>');
  r.call('updateHistory', {url:'https://example.test/start#target',entryKey:'native-2',index:2,length:3,ackRevision:0});
  assert.deepEqual(r.json('events'), [['https://example.test/start','https://example.test/start#target','https://example.test/start#listener']]);
  assert.equal(r.run('history.length'),4);
});
test('security and cloning failures leave URL, state, length and action queue unchanged', () => {
  const r = runtime();
  for (const url of ['https://other.test/a','http://example.test/a','https://u@example.test/a','https://example.test:444/a','http://[']) {
    assert.equal(r.run(`(()=>{try {history.pushState(1,'',${JSON.stringify(url)});return 'no-error'}catch(e){return e.name}})()`),'SecurityError');
  }
  assert.equal(r.run("(()=>{try{history.pushState(()=>{},'', 'https://other.test/')}catch(e){return e.name}})()"),'DataCloneError');
  assert.equal(r.run("(()=>{try{history.pushState(document,'')}catch(e){return e.name}})()"),'DataCloneError');
  assert.throws(() => r.run('history.pushState(1)'), /requires/);
  assert.throws(() => r.run('history.pushState(1, Symbol())'), /Symbol/);
  assert.throws(() => r.run('history.pushState(1, "", Symbol())'), /Symbol/);
  assert.deepEqual(r.json('[location.href,history.state,history.length]'), ['https://example.test/start',null,2]);
  assert.deepEqual(r.call('snapshot', {}).navigationActions, []);
});
test('blob history allows fragment rewrites only', () => {
  const r = runtime('', 'blob:https://example.test/id');
  r.run('history.pushState(1,"","#one")');
  assert.equal(r.run('location.href'), 'blob:https://example.test/id#one');
  assert.equal(r.run("(()=>{try{history.pushState(2,'','?q=1')}catch(e){return e.name}})()"), 'SecurityError');
});
test('go conversions queue asynchronous host actions without optimistic URL/state changes', () => {
  const r = runtime('', 'https://example.test/start', {index:2,length:5});
  r.run('history.back();history.forward();history.go();history.go(4294967295);history.go(Infinity);history.go(1.9)');
  assert.equal(r.run('location.href'),'https://example.test/start');
  assert.deepEqual(r.call('snapshot',{}).navigationActions.map(a=>a.delta),[-1,1,0,-1,0,1]);
  assert.throws(() => r.run('history.go(1n)'), /BigInt/);
});
test('history mutations survive navigation coalescing and scrolling stays per entry', () => {
  const r = runtime();
  r.run('history.scrollRestoration="manual"; history.pushState(1,"","?one"); location.href="/next"; history.pushState(2,"","?two")');
  const actions = r.call('snapshot',{}).navigationActions;
  assert.deepEqual(actions.map(a=>a.kind==='history'?a.method:a.kind),['scroll','push','navigate','push']);
  assert.equal(actions[1].scrollRestoration,'manual');
  assert.equal(r.run('history.scrollRestoration'),'manual');
  assert.throws(() => r.run('history.scrollRestoration="invalid"'), /ScrollRestoration/);
  assert.deepEqual(r.call('snapshot',{}).navigationActions, []);
});
test('synthetic PopStateEvent retains supplied state identity and is untrusted', () => {
  const r = runtime();
  assert.deepEqual(r.json('(()=>{const state={a:1};const e=new PopStateEvent("popstate",{state});return [e instanceof Event,e.state===state,e.isTrusted,e.bubbles,e.cancelable]})()'),[true,true,false,false,false]);
});

test('queued traversals retain their call-time target through synchronous pushes', () => {
  const r=runtime();
  r.run('history.pushState(1,"","?one"); history.back(); history.pushState(2,"","?two")');
  const actions=r.call('snapshot',{}).navigationActions;
  assert.equal(actions[1].index,1);
  assert.equal(r.run('history.length'),4);
  const other=runtime();
  other.run('history.pushState(1,"","?one"); history.pushState(2,"","?two");history.back();history.forward()');
  assert.deepEqual(other.call('snapshot',{}).navigationActions.filter(a=>a.method==='go').map(a=>a.index),[2]);
});

test('persisted controls restore into the scripted DOM without input/change events', () => {
  const r = runtime('<html><body><input id="draft" value="initial"><script>window.inputEvents=[];document.querySelector("input").addEventListener("input",e=>inputEvents.push(e.type));document.querySelector("input").addEventListener("change",e=>inputEvents.push(e.type));</script></body></html>');
  const id=r.run('document.querySelector("input").getAttribute("data-pirc-script-id")');
  r.call('restoreControls',{controls:[{id,value:'restored draft'}]});
  assert.equal(r.run('document.querySelector("input").value'),'restored draft');
  assert.deepEqual(r.json('inputEvents'),[]);
  assert.equal(r.run('document.querySelector("input").defaultValue'),'initial');
});

test('traversal selects its target after popstate and before hashchange', () => {
  const r = runtime('<div id="one"></div><div id="two"></div><script>window.targets=[];for(const type of ["popstate","hashchange"])addEventListener(type,()=>targets.push([type,location.hash,document.querySelector(":target")?.id]))</script>', 'https://example.test/start#one');
  r.call('updateHistory', {url:'https://example.test/start#two',entryKey:'native-2',index:2,length:3,ackRevision:0,targetRevision:1,targetUrl:'https://example.test/start#two'});
  assert.deepEqual(r.json('targets'), [['popstate','#two','one'],['hashchange','#two','two']]);
});

test('traversal across query routes suppresses hashchange', () => {
  const r = runtime('<script>window.events=[];for(const type of ["popstate","hashchange"])addEventListener(type,()=>events.push(type))</script>', 'https://example.test/start?route=changed#one');
  r.call('updateHistory', {url:'https://example.test/start?route=original',entryKey:'native-2',index:2,length:3,ackRevision:0});
  assert.deepEqual(r.json('events'), ['popstate']);
});
