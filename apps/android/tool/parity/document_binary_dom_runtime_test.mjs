import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);

const bundlePath = process.env.PIRC_DOCUMENT_SCRIPT_RUNTIME_BUNDLE || fileURLToPath(
  new URL('../../assets/document-script-runtime.js', import.meta.url)
);
const bundle = readFileSync(bundlePath, 'utf8');
const RUN_TIMEOUT_MS = 3000;

function createRuntime() {
  const context = vm.createContext({});
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(
    context,
    { timeout: RUN_TIMEOUT_MS }
  );
  return context;
}

function invoke(context, method, argument) {
  const expression = '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  const serialized = new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS
  });
  return JSON.parse(serialized);
}

function evaluate(context, expression) {
  return new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS
  });
}

function jsonEvaluate(context, expression) {
  const value = evaluate(context, 'JSON.stringify(' + expression + ')');
  return JSON.parse(value);
}

async function asyncJsonEvaluate(context, body) {
  const promise = evaluate(context, '(async function() {' + body + '\n})()');
  const value = await promise;
  return JSON.parse(JSON.stringify(value));
}

function elementId(context, selector) {
  return evaluate(
    context,
    'document.querySelector(' + JSON.stringify(selector) +
      ').getAttribute("data-pirc-script-id")'
  );
}

function initializedRuntime(html) {
  const context = createRuntime();
  const result = invoke(context, 'init', {
    url: 'https://example.test/document',
    html
  });
  assert.equal(
    result.diagnostics.some((item) => item.severity === 'error'),
    false,
    JSON.stringify(result.diagnostics)
  );
  return context;
}

test('DOM FormData constructors capture form entries, submitter, events, and errors', () => {
  const context = initializedRuntime([
    '<form id="form">',
    '  <input name="city" value="城市">',
    '  <input name="dup" value="first">',
    '  <input name="dup" value="second">',
    '  <textarea name="message">first line\nsecond line</textarea>',
    '  <input type="checkbox" name="choice" value="yes" checked>',
    '  <input type="checkbox" name="unchecked" value="no">',
    '  <input name="disabled" value="skip" disabled>',
    '  <input type="hidden" name="_charset_" value="original">',
    '  <input id="upload" type="file" name="upload" multiple>',
    '  <button id="not-submit" type="button" name="ignored" value="no">No</button>',
    '  <button id="send" type="submit" name="go" value="yes">Send</button>',
    '</form>',
    '<button id="foreign" type="submit" name="foreign" value="yes">Foreign</button>'
  ].join('\n'));

  const result = jsonEvaluate(context, `(() => {
    const form = document.querySelector('#form');
    const send = document.querySelector('#send');
    const events = [];
    const reentrantErrors = [];
    const summarize = data => Array.from(data, ([name, value]) =>
      typeof value === 'string'
        ? { name, kind: 'text', value }
        : {
            name,
            kind: 'file',
            filename: value.name,
            mimeType: value.type,
            size: value.size,
            lastModifiedIsNumber: Number.isFinite(value.lastModified)
          }
    );
    const record = (listener, event) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, 'formData');
      events.push({
        listener,
        isFormDataEvent: event instanceof FormDataEvent,
        isFormData: event.formData instanceof FormData,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        targetIsForm: event.target === form,
        formDataReadonly: descriptor && {
          writable: descriptor.writable,
          configurable: descriptor.configurable
        }
      });
    };
    form.addEventListener('formdata', event => {
      record('form', event);
      event.formData.append('hook', 'from-event');
      try {
        new FormData(form);
      } catch (error) {
        reentrantErrors.push({ name: error.name, message: error.message });
      }
    });
    document.addEventListener('formdata', event => record('document', event));

    const primary = new FormData(form, send);
    const nullSubmitter = new FormData(form, null);
    const undefinedSubmitter = new FormData(form, undefined);
    const attempt = callback => {
      try {
        callback();
        return { threw: false };
      } catch (error) {
        return { threw: true, name: error.name, message: error.message };
      }
    };
    const nonSubmitterError = attempt(() =>
      new FormData(form, document.querySelector('#not-submit'))
    );
    const foreignSubmitterError = attempt(() =>
      new FormData(form, document.querySelector('#foreign'))
    );
    const noForm = new FormData();

    return {
      globalsMatchWindow: ['Blob', 'File', 'FormData', 'FormDataEvent']
        .every(name => globalThis[name] === window[name]),
      primary: summarize(primary),
      nullSubmitter: summarize(nullSubmitter),
      undefinedSubmitter: summarize(undefinedSubmitter),
      noFormIsEmpty: Array.from(noForm).length === 0,
      nonSubmitterError,
      foreignSubmitterError,
      events,
      reentrantErrors
    };
  })()`);

  assert.equal(result.globalsMatchWindow, true);
  assert.deepEqual(result.primary, [
    { name: 'city', kind: 'text', value: '城市' },
    { name: 'dup', kind: 'text', value: 'first' },
    { name: 'dup', kind: 'text', value: 'second' },
    { name: 'message', kind: 'text', value: 'first line\nsecond line' },
    { name: 'choice', kind: 'text', value: 'yes' },
    { name: '_charset_', kind: 'text', value: 'UTF-8' },
    {
      name: 'upload', kind: 'file', filename: '',
      mimeType: 'application/octet-stream', size: 0, lastModifiedIsNumber: true
    },
    { name: 'go', kind: 'text', value: 'yes' },
    { name: 'hook', kind: 'text', value: 'from-event' }
  ]);
  for (const entries of [result.nullSubmitter, result.undefinedSubmitter]) {
    assert.equal(entries.some((entry) => entry.name === 'go'), false);
    assert.equal(entries.some((entry) => entry.name === 'disabled'), false);
    assert.equal(entries.some((entry) => entry.name === 'unchecked'), false);
    assert.equal(entries.find((entry) => entry.name === '_charset_')?.value, 'UTF-8');
    assert.deepEqual(entries.at(-1), {
      name: 'hook', kind: 'text', value: 'from-event'
    });
  }
  assert.equal(result.noFormIsEmpty, true);
  assert.equal(result.nonSubmitterError.threw, true);
  assert.equal(result.nonSubmitterError.name, 'TypeError');
  assert.equal(result.foreignSubmitterError.threw, true);
  assert.equal(result.foreignSubmitterError.name, 'NotFoundError');
  assert.equal(result.events.length, 6);
  for (const event of result.events) {
    assert.equal(event.isFormDataEvent, true);
    assert.equal(event.isFormData, true);
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, false);
    assert.equal(event.targetIsForm, true);
    assert.deepEqual(event.formDataReadonly, { writable: false, configurable: false });
  }
  assert.equal(result.events.filter((event) => event.listener === 'document').length, 3);
  assert.deepEqual(result.reentrantErrors.map((error) => error.name), [
    'InvalidStateError', 'InvalidStateError', 'InvalidStateError'
  ]);
});

test('host file snapshots preserve bytes, identity, clear epochs, and unavailable-content errors', async () => {
  const context = initializedRuntime(
    '<form id="form"><input id="upload" type="file" name="upload" multiple></form>'
  );
  const uploadId = elementId(context, '#upload');
  const fileSnapshot = [{
    name: '城市.bin',
    type: 'application/octet-stream',
    size: 6,
    lastModified: 123,
    bytesBase64: 'AH+A/w0K'
  }];

  invoke(context, 'dispatch', {
    id: uploadId,
    type: 'file-state',
    controls: [{ id: uploadId, files: fileSnapshot, fileResetVersion: 0 }]
  });
  evaluate(context, 'window.__fileSnapshot = document.querySelector("#upload").files[0]');
  invoke(context, 'dispatch', {
    id: uploadId,
    type: 'file-state',
    controls: [{ id: uploadId, files: fileSnapshot, fileResetVersion: 0 }]
  });
  assert.equal(
    evaluate(context, 'document.querySelector("#upload").files[0] === window.__fileSnapshot'),
    true,
    'reapplying an unchanged host snapshot should preserve the File object'
  );

  const selected = await asyncJsonEvaluate(context, `
    const form = document.querySelector('#form');
    const inputFile = form.querySelector('#upload').files[0];
    const submittedFile = new FormData(form).get('upload');
    return {
      inputFile: {
        name: inputFile.name,
        type: inputFile.type,
        size: inputFile.size,
        lastModified: inputFile.lastModified
      },
      submittedFile: {
        name: submittedFile.name,
        type: submittedFile.type,
        size: submittedFile.size,
        lastModified: submittedFile.lastModified,
        text: await submittedFile.text(),
        bytes: Array.from(new Uint8Array(await submittedFile.arrayBuffer()))
      }
    };
  `);
  assert.deepEqual(selected.inputFile, {
    name: '城市.bin', type: 'application/octet-stream', size: 6, lastModified: 123
  });
  assert.deepEqual(selected.submittedFile, {
    name: '城市.bin',
    type: 'application/octet-stream',
    size: 6,
    lastModified: 123,
    text: '\u0000\u007f\ufffd\ufffd\r\n',
    bytes: [0, 127, 128, 255, 13, 10]
  });

  evaluate(context, 'document.querySelector("#upload").value = ""');
  const cleared = invoke(context, 'snapshot', {});
  assert.match(cleared.html, /data-pirc-file-reset-version="1"/);
  invoke(context, 'dispatch', {
    id: uploadId,
    type: 'file-state',
    controls: [{ id: uploadId, files: fileSnapshot, fileResetVersion: 0 }]
  });
  const staleSelection = jsonEvaluate(context, `(() => {
    const input = document.querySelector('#upload');
    const file = new FormData(document.querySelector('#form')).get('upload');
    return {
      inputValue: input.value,
      inputFileCount: input.files.length,
      file: { name: file.name, type: file.type, size: file.size }
    };
  })()`);
  assert.deepEqual(staleSelection, {
    inputValue: '',
    inputFileCount: 0,
    file: { name: '', type: 'application/octet-stream', size: 0 }
  });

  const metadataOnlyContext = initializedRuntime(
    '<form id="form"><input id="upload" type="file" name="upload"></form>'
  );
  const metadataUploadId = elementId(metadataOnlyContext, '#upload');
  invoke(metadataOnlyContext, 'dispatch', {
    id: metadataUploadId,
    type: 'file-state',
    controls: [{
      id: metadataUploadId,
      files: [{
        name: 'unavailable.bin',
        type: 'application/octet-stream',
        size: 6,
        lastModified: 456
      }],
      fileResetVersion: 0
    }]
  });
  const unavailable = await asyncJsonEvaluate(metadataOnlyContext, `
    const form = document.querySelector('#form');
    const file = new FormData(form).get('upload');
    const read = async operation => {
      try {
        await operation();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, name: error.name, message: error.message };
      }
    };
    let requestError;
    try {
      new Request('https://example.test/upload', {
        method: 'POST',
        body: new FormData(form)
      });
      requestError = { threw: false };
    } catch (error) {
      requestError = { threw: true, name: error.name, message: error.message };
    }
    return {
      metadata: { name: file.name, type: file.type, size: file.size },
      textRead: await read(() => file.text()),
      arrayBufferRead: await read(() => file.arrayBuffer()),
      requestError
    };
  `);
  assert.deepEqual(unavailable.metadata, {
    name: 'unavailable.bin', type: 'application/octet-stream', size: 6
  });
  assert.equal(unavailable.textRead.rejected, true);
  assert.match(unavailable.textRead.message, /unavailable/i);
  assert.equal(unavailable.arrayBufferRead.rejected, true);
  assert.match(unavailable.arrayBufferRead.message, /unavailable/i);
  assert.equal(unavailable.requestError.threw, true);
  assert.match(unavailable.requestError.message, /unavailable/i);
});
