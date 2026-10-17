import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);

const bundle = readFileSync(new URL('../../assets/document-script-runtime.js', import.meta.url), 'utf8');
function runtime(html) {
  const context = vm.createContext({});
  vm.runInContext(bundle, context, {timeout: 3000});
  const result = invoke(context, 'init', {html, url: 'https://example.test/source'});
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);
  return context;
}
function invoke(context, method, argument) {
  return JSON.parse(vm.runInContext(`__pircDocument.${method}(${JSON.stringify(argument)})`, context, {timeout: 3000}));
}
function evaluate(context, code) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context, {timeout: 3000}));
}

// The ordering and attribute interactions here were measured separately in
// Chrome 155; expected results are not computed by the native implementation.
test('onformdata property and inline attribute share a stable ordered handler slot', () => {
  const context = runtime('<form id="f" onformdata="window.calls.push(\'inline\')"></form>');
  const result = evaluate(context, `(() => {
    const form = document.querySelector('#f');
    window.calls = [];
    const listener = () => calls.push('listener');
    const first = () => calls.push('property');
    const second = () => calls.push('replacement');
    const runs = [];
    const run = () => { calls.length = 0; new FormData(form); runs.push(calls.slice()); };
    form.addEventListener('formdata', listener);
    run();
    form.onformdata = first;
    const identity = form.onformdata === first;
    run();
    form.onformdata = second;
    run();
    form.onformdata = null;
    const isNull = form.onformdata === null;
    run();
    form.onformdata = first;
    run();
    form.removeAttribute('onformdata');
    const removedIsNull = form.onformdata === null;
    run();
    form.onformdata = first;
    form.removeAttribute('onformdata');
    const absentRemovalKeepsIdentity = form.onformdata === first;
    run();
    form.setAttribute('onformdata', "window.calls.push('new-inline')");
    run();
    form.onformdata = first;
    // Re-applying the same attribute is a new attribute-handler assignment.
    form.setAttribute('onformdata', "window.calls.push('new-inline')");
    run();
    return {identity, isNull, removedIsNull, absentRemovalKeepsIdentity, runs};
  })()`);
  assert.deepEqual(result, {
    identity: true, isNull: true, removedIsNull: true, absentRemovalKeepsIdentity: true,
    runs: [
      ['inline', 'listener'], ['property', 'listener'], ['replacement', 'listener'],
      ['listener'], ['listener', 'property'], ['listener'], ['listener', 'property'],
      ['listener', 'new-inline'], ['listener', 'new-inline'],
    ],
  });
});

test('default submission uses event-edited entries and the original navigation attributes', () => {
  for (const mode of ['click', 'request', 'direct']) {
    const context = runtime(`<form id="f" action="/before" method="post" enctype="multipart/form-data" target="original">
      <input name="remove" value="gone"><input name="dup" value="one"><input name="dup" value="two">
      <input id="file" name="upload" type="file"><button id="send" name="go" value="yes">Send</button></form>
      <script>
      window.submitCount = 0; window.formdataCount = 0; window.nestedError = '';
      const f = document.querySelector('#f');
      f.addEventListener('submit', () => submitCount++);
      f.onformdata = event => {
        formdataCount++;
        event.formData.delete('remove'); event.formData.set('dup', 'replaced');
        event.formData.append('tail', '城市');
        event.formData.append('binary', new File([new Uint8Array([0,127,128,255])], 'folder/城市\\\\tail.bin', {type:'application/octet-stream',lastModified:123}));
        f.action='/after'; f.method='get'; f.enctype='text/plain'; f.target='changed';
        f.submit(); f.requestSubmit();
        try { new FormData(f); } catch (error) { nestedError = error.name; }
      };
      </script>`);
    const controlId = evaluate(context, `document.querySelector('#file').getAttribute('data-pirc-script-id')`);
    invoke(context, 'dispatch', {
      id: controlId, type: 'change', controls: [{id: controlId, fileResetVersion: '0', files: [{
        name: 'selected.bin', type: 'application/octet-stream', size: 3 * 1024 * 1024,
        lastModified: 1, contentError: 'Outside script byte budget',
      }]}],
    });
    const result = mode === 'click'
      ? invoke(context, 'dispatch', {id: evaluate(context, `document.querySelector('#send').getAttribute('data-pirc-script-id')`), type: 'click'})
      : (evaluate(context, `(document.querySelector('#f').${mode === 'direct' ? 'submit()' : "requestSubmit(document.querySelector('#send'))"}, true)`), invoke(context, 'snapshot', {}));
    assert.deepEqual(evaluate(context, '[submitCount, formdataCount, nestedError]'), [mode === 'direct' ? 0 : 1, 1, 'InvalidStateError']);
    assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);
    assert.equal(result.formActions.length, 1);
    const action = result.formActions[0];
    assert.deepEqual([action.action, action.method, action.enctype, action.target], ['/before', 'post', 'multipart/form-data', 'original']);
    assert.deepEqual(action.entries, [
      {name: 'dup', value: 'replaced'},
      {name: 'upload', file: {controlId, resetVersion: '0', index: 0}},
      ...(mode === 'direct' ? [] : [{name: 'go', value: 'yes'}]),
      {name: 'tail', value: '城市'},
      {name: 'binary', inlineFile: {name:'folder/城市\\tail.bin',type:'application/octet-stream',lastModified:123,bytesBase64:'AH+A/w=='}},
    ]);
  }
});

test('cancelled submit and constraint validation never construct formdata', () => {
  const context = runtime(`<form id="cancel"><button id="send">Send</button></form><form id="invalid"><input required></form>
    <script>window.count=0; const cancel=document.querySelector('#cancel');
    cancel.onformdata=()=>count++; cancel.onsubmit=e=>e.preventDefault();
    document.querySelector('#invalid').onformdata=()=>count++;
    document.querySelector('#invalid').requestSubmit(); cancel.requestSubmit();</script>`);
  assert.equal(evaluate(context, 'count'), 0);
  assert.equal(invoke(context, 'snapshot', {}).formActions.filter(a => a.kind === 'submit').length, 0);
});

test('inline file aggregate budget rejects rather than silently dropping entries', () => {
  const context = runtime('<form id="f"></form>');
  assert.equal(evaluate(context, `(() => {
    const f=document.querySelector('#f');
    f.onformdata=e=>{const file=new File([new Uint8Array(1024*1024+1)],'large');e.formData.append('a',file);e.formData.append('b',file);};
    try { f.submit(); return 'accepted'; } catch(e) { return e.name; }
  })()`), 'RangeError');
  assert.equal(invoke(context, 'snapshot', {}).formActions.length, 0);
});


test('FormDataEvent distinguishes internal construction from public events and cannot cancel a non-cancelable event', () => {
  const context = runtime('<form id="f"></form>');
  assert.deepEqual(evaluate(context, `(() => {
    const f = document.querySelector('#f');
    let flags;
    f.onformdata = e => {
      e.preventDefault();
      flags = [e.bubbles,e.cancelable,e.composed,e.isTrusted,e.defaultPrevented,e.eventPhase,e.target===f];
    };
    new FormData(f);
    const event = new FormDataEvent('formdata', {formData:new FormData(),cancelable:true,composed:true});
    event.preventDefault();
    const forged = new FormDataEvent('formdata', {formData:new FormData()}, {});
    return {flags, custom:[event.cancelable,event.composed,event.isTrusted,event.defaultPrevented],forged:forged.isTrusted};
  })()`), {flags:[true,false,false,true,false,2,true],custom:[true,true,false,true],forged:false});
});

test('shared Chrome fixture preserves property cases, generated event flags, counts and navigation snapshots', () => {
  const source = readFileSync(new URL('../../integration_test/document_formdata_fixture.dart', import.meta.url), 'utf8');
  const html = source.match(/const formDataHtml\s*=\s*r'''([\s\S]*?)''';/)[1];
  const expected = JSON.parse(source.match(/const formDataExpectedOracleJson\s*=\s*r'''([\s\S]*?)''';/)[1]);
  const context = runtime(html);
  assert.deepEqual(evaluate(context, 'window.__propertyCases'), expected.propertyCases);
  const fileId = evaluate(context, `document.querySelector('#selected-file').getAttribute('data-pirc-script-id')`);
  invoke(context, 'dispatch', {id:fileId,type:'change',controls:[{id:fileId,fileResetVersion:'0',files:[{
    name:'selected-資料.bin',type:'application/octet-stream',lastModified:1,size:6,bytesBase64:'AH+A/w0K',
  }]}]});
  for (const [selector,key] of [
    ['#button-submit','buttonSubmit'], ['#request-submit-runner','requestSubmit'],
    ['#direct-submit-runner','directSubmit'], ['#reentry-submit-runner','reentry'],
  ]) {
    const id = evaluate(context, `document.querySelector(${JSON.stringify(selector)}).getAttribute('data-pirc-script-id')`);
    const result = invoke(context, 'dispatch', {id,type:'click'});
    assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'), []);
    assert.equal(result.formActions.length, 1, key);
    const action = result.formActions[0];
    assert.deepEqual([action.method.toUpperCase(),action.action,action.target], [expected[key].method,expected[key].path,expected[key].targetFrame]);
  }
  const cancelId = evaluate(context, `document.querySelector('#cancel-submit-runner').getAttribute('data-pirc-script-id')`);
  assert.equal(invoke(context, 'dispatch', {id:cancelId,type:'click'}).formActions.length, 0);
  const actual = evaluate(context, 'window.__formDataOracle');
  assert.deepEqual(actual.counts, expected.submissionCounts);
  assert.deepEqual(actual.reentry.nested, expected.reentry.nested);
  assert.equal(actual.cancel.defaultPrevented, true);
  const events = actual.events.filter(e=>e.form==='button-form');
  assert.deepEqual(events.map(e=>e.type), expected.buttonEventOrder);
  const formFlags = events.find(e=>e.type==='formdata-property').flags;
  const docFlags = events.find(e=>e.type==='formdata-document').flags;
  const flags = expected.nativeEventFlags;
  assert.deepEqual(formFlags, {
    bubbles:flags.bubbles,cancelable:flags.cancelable,composed:flags.composed,isTrusted:flags.isTrusted,
    defaultPrevented:flags.defaultPrevented,eventPhase:flags.formEventPhase,targetIsForm:flags.targetIsForm,
  });
  assert.deepEqual(docFlags, {...formFlags,eventPhase:flags.documentEventPhase});
});
