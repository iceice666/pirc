import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
function create() {
  const context = vm.createContext({}, {microtaskMode: 'afterEvaluate'});
  const evaluate = source => new vm.Script(source).runInContext(context);
  evaluate(bundle);
  const invoke = (method, value = {}) => JSON.parse(evaluate(`__pircDocument.${method}(${JSON.stringify(value)})`));
  invoke('init', {html:'<div id="target"></div>', hostLayout:true, url:'https://example.test/frame', now:0});
  let generation = 0;
  function measure(width = 100) {
    const pending = invoke('snapshot');
    return invoke('updateLayout', {
      revision:pending.layout.revision, generation:++generation,
      viewport:{width:390,height:844,scrollX:0,scrollY:0},
      boxes:pending.layout.ids.map(id => ({id,kind:'box',x:0,y:0,width,height:40,
        resize:{kind:'box',contentRect:{x:0,y:0,width,height:40},borderBoxSize:{inlineSize:width,blockSize:40}}})),
    });
  }
  measure();
  return {evaluate,invoke,measure,events:()=>JSON.parse(evaluate('JSON.stringify(window.events)'))};
}
function step(r, out) {
  return r.invoke('continueAnimationFrame', {id:out.frameContinuation.id});
}

test('native frame callbacks keep one timestamp, checkpoint Promise jobs, cancellation and nested-frame selection', () => {
  const r = create();
  r.evaluate(`window.events=[];
    requestAnimationFrame(function(t){
      events.push(['first',t,this===window]);
      Promise.resolve().then(function(){events.push(['microtask']);cancelAnimationFrame(cancelled)});
      requestAnimationFrame(function(t){events.push(['nested',t])});
    });
    var cancelled=requestAnimationFrame(function(){events.push(['cancelled'])});
    requestAnimationFrame(function(t){events.push(['second',t])});`);
  let out = r.invoke('pump', {now:10,animationFrame:true,nativeFrameSteps:true});
  assert.deepEqual(r.events(), [['first',10,true],['microtask']]);
  assert.ok(out.frameContinuation);
  out = step(r,out);
  assert.deepEqual(r.events(), [['first',10,true],['microtask'],['second',10]]);
  out = step(r,out);
  assert.equal(out.frameContinuation,null);
  assert.equal(out.scheduler.animationFrame,true);
  out = r.invoke('pump', {now:30,animationFrame:true,nativeFrameSteps:true});
  assert.deepEqual(r.events().at(-1),['nested',30]);
  out = step(r,out);
  assert.deepEqual(out.scheduler,{timerDelayMs:null,animationFrame:false});
});

test('Promise DOM mutations require a measured frame before the next selected callback', () => {
  const r = create();
  r.evaluate(`window.events=[];
    requestAnimationFrame(function(){Promise.resolve().then(function(){document.getElementById('target').style.width='120px'})});
    requestAnimationFrame(function(){events.push(document.getElementById('target').getBoundingClientRect().width)});`);
  let out = r.invoke('pump', {animationFrame:true,nativeFrameSteps:true});
  // The result was serialized before the Promise job; use a new VM snapshot.
  assert.equal(out.layout.required,false);
  const fresh = r.invoke('snapshot');
  assert.equal(fresh.layout.required,true);
  out = step(r,out);
  assert.deepEqual(r.events(),[]);
  assert.equal(out.layout.required,true);
  r.measure(120);
  out = step(r,out);
  assert.deepEqual(r.events(),[120]);
  out = step(r,out);
  assert.equal(out.frameContinuation,null);
  assert.equal(out.diagnostics.some(d=>d.severity==='error'),false);
});

test('a paused frame neither runs timers nor selects callbacks queued during that frame', () => {
  const r=create();
  r.evaluate(`window.events=[];
    setTimeout(function(){events.push('timer')},0);
    requestAnimationFrame(function(){events.push('first');requestAnimationFrame(function(){events.push('nested')})});
    requestAnimationFrame(function(){events.push('second')});`);
  let out=r.invoke('pump',{now:16,animationFrame:true,nativeFrameSteps:true});
  const id=out.frameContinuation.id;
  out=r.invoke('pump',{now:32,animationFrame:false,nativeFrameSteps:true});
  assert.equal(out.frameContinuation.id,id);
  assert.deepEqual(r.events(),['first']);
  out=step(r,out);out=step(r,out);
  assert.deepEqual(r.events(),['first','second']);
  r.invoke('pump',{now:33});
  assert.deepEqual(r.events(),['first','second','timer']);
  r.invoke('pump',{now:48,animationFrame:true,nativeFrameSteps:true});
  assert.deepEqual(r.events(),['first','second','timer','nested']);
});

test('callback errors retain later callbacks and reject stale or foreign continuations', () => {
  const r=create();
  r.evaluate(`window.events=[];requestAnimationFrame(function(){throw new Error('frame boom')});requestAnimationFrame(function(){events.push('second')});`);
  let out=r.invoke('pump',{animationFrame:true,nativeFrameSteps:true});
  assert.equal(out.diagnostics.find(d=>d.code==='scheduler.callback_error').message,'frame boom');
  assert.throws(()=>r.invoke('continueAnimationFrame',{id:out.frameContinuation.id+1}),/matching native animation frame/);
  const id=out.frameContinuation.id;
  out=step(r,out);out=step(r,out);
  assert.deepEqual(r.events(),['second']);
  assert.equal(out.frameContinuation,null);
  assert.throws(()=>r.invoke('continueAnimationFrame',{id}),/matching native animation frame/);
});

test('ResizeObserver delivery follows the last callback Promise job and its accepted native layout', () => {
  const r=create();
  r.evaluate(`window.events=[];
    new ResizeObserver(function(entries){events.push(['resize',entries[0].contentRect.width])}).observe(document.getElementById('target'));
    requestAnimationFrame(function(){events.push(['frame']);Promise.resolve().then(function(){events.push(['microtask']);document.getElementById('target').style.width='140px'})});`);
  let out=r.invoke('pump',{animationFrame:true,nativeFrameSteps:true});
  assert.deepEqual(r.events(),[['frame'],['microtask']]);
  out=step(r,out);
  assert.ok(out.frameContinuation);
  r.measure(140);
  out=step(r,out);
  assert.deepEqual(r.events(),[['frame'],['microtask'],['resize',140]]);
  assert.equal(out.frameContinuation,null);
});
