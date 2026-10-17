// Keep the raw HTML and oracle JSON directly extractable by the Chrome runner.
const fileReaderHtml =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>FileReader parity</title></head><body>
<h1>FileReader parity</h1>
<label for="selected-file">Selected file</label>
<input id="selected-file" type="file">
<button id="read-selected" type="button">Read selected file</button>
<button id="read-programmatic" type="button">Read programmatic files</button>
<pre id="file-reader-result">WAITING</pre>
<script>
(() => {
  const resultNode = document.querySelector('#file-reader-result');
  const model = {selected: null, programmatic: null};
  const makeBlob = (bytes, type) => new Blob([Uint8Array.from(bytes)], {type: type || ''});
  const resultTag = value => {
    if (value == null) return null;
    if (value instanceof ArrayBuffer) return 'ArrayBuffer:' + value.byteLength;
    if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + value.byteLength;
    return typeof value + ':' + String(value).length;
  };
  const projectResult = (reader, kind) => {
    const value = reader.result;
    if (value == null) return null;
    if (kind === 'arrayBuffer') return Array.from(new Uint8Array(value));
    if (kind === 'binaryString') return Array.from(value, character => character.charCodeAt(0));
    return value;
  };
  const monitor = reader => {
    const events = [];
    let loadCount = 0;
    for (const type of ['loadstart', 'progress', 'load', 'abort', 'error', 'loadend']) {
      reader.addEventListener(type, event => {
        if (type === 'load') loadCount++;
        events.push({
          type,
          state: reader.readyState,
          loaded: event.loaded,
          total: event.total,
          lengthComputable: event.lengthComputable,
          errorName: reader.error && reader.error.name || null,
          resultTag: resultTag(reader.result),
          flags: {
            bubbles: event.bubbles,
            cancelable: event.cancelable,
            composed: event.composed,
            isTrusted: event.isTrusted
          }
        });
      });
    }
    return {events, get loadCount() { return loadCount; }};
  };
  const summarizeEvents = events => {
    const order = [];
    const stableEvents = [];
    const progress = events.filter(event => event.type === 'progress');
    for (const event of events) {
      if (order.length === 0 || order[order.length - 1] !== event.type) order.push(event.type);
      if (event.type !== 'progress') {
        stableEvents.push({
          type: event.type,
          state: event.state,
          loaded: event.loaded,
          total: event.total,
          lengthComputable: event.lengthComputable,
          errorName: event.errorName,
          resultTag: event.resultTag
        });
      }
    }
    const firstFlags = events.length ? events[0].flags : null;
    return {
      order,
      events: stableEvents,
      progress: progress.length ? {
        present: true,
        firstLoaded: progress[0].loaded,
        lastLoaded: progress[progress.length - 1].loaded,
        maxLoaded: Math.max(...progress.map(event => event.loaded)),
        total: progress[progress.length - 1].total,
        lengthComputableEvery: progress.every(event => event.lengthComputable),
        state: progress[0].state,
        errorName: progress[0].errorName
      } : {present: false},
      flags: firstFlags,
      flagsConsistent: events.every(event =>
        JSON.stringify(event.flags) === JSON.stringify(firstFlags))
    };
  };
  const read = (blob, method, kind, encoding) => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    let value = null;
    reader.addEventListener('load', () => { value = projectResult(reader, kind); });
    reader.addEventListener('loadend', () => resolve({
      result: value,
      finalReadyState: reader.readyState,
      finalErrorName: reader.error && reader.error.name || null,
      events: summarizeEvents(observed.events)
    }), {once: true});
    try {
      if (encoding === undefined) reader[method](blob);
      else reader[method](blob, encoding);
    } catch (error) {
      resolve({thrownName: error.name, events: summarizeEvents(observed.events)});
    }
  });
  const readText = (key, blob, encoding) => read(blob, 'readAsText', 'text', encoding)
    .then(summary => [key, summary]);
  const snapshotReader = (reader, observed) => ({
    finalReadyState: reader.readyState,
    finalErrorName: reader.error && reader.error.name || null,
    finalResultTag: resultTag(reader.result),
    events: summarizeEvents(observed.events)
  });
  const abortInEmpty = () => {
    const reader = new FileReader();
    const observed = monitor(reader);
    reader.abort();
    return snapshotReader(reader, observed);
  };
  const abortImmediately = blob => {
    const reader = new FileReader();
    const observed = monitor(reader);
    reader.readAsArrayBuffer(blob);
    reader.abort();
    const first = snapshotReader(reader, observed);
    reader.abort();
    return {afterFirstAbort: first, afterSecondAbort: snapshotReader(reader, observed)};
  };
  const abortInLoadstart = blob => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    reader.addEventListener('loadstart', () => reader.abort(), {once: true});
    reader.addEventListener('loadend', () => resolve(snapshotReader(reader, observed)), {once: true});
    reader.readAsArrayBuffer(blob);
  });
  const abortInProgress = blob => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    let afterAbortCall = null;
    reader.addEventListener('progress', () => {
      reader.abort();
      afterAbortCall = {
        readyState: reader.readyState,
        errorName: reader.error && reader.error.name || null,
        resultTag: resultTag(reader.result)
      };
    }, {once: true});
    reader.addEventListener('loadend', () => resolve({
      afterAbortCall,
      ...snapshotReader(reader, observed)
    }), {once: true});
    reader.readAsArrayBuffer(blob);
  });
  const abortInDone = blob => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    reader.addEventListener('loadend', () => {
      reader.abort();
      resolve(snapshotReader(reader, observed));
    }, {once: true});
    reader.readAsArrayBuffer(blob);
  });
  const busyRead = blob => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    let secondRead = null;
    reader.addEventListener('loadend', () => resolve({
      secondRead,
      ...snapshotReader(reader, observed)
    }), {once: true});
    reader.readAsArrayBuffer(blob);
    try { reader.readAsText(blob); }
    catch (error) {
      secondRead = {thrownName: error.name, stateAtThrow: reader.readyState};
    }
  });
  const syncLoadReentry = (firstBlob, secondBlob) => new Promise(resolve => {
    const reader = new FileReader();
    const observed = monitor(reader);
    const loadResults = [];
    reader.addEventListener('load', () => {
      loadResults.push(resultTag(reader.result));
      if (observed.loadCount === 1) reader.readAsText(secondBlob);
    });
    reader.addEventListener('loadend', () => {
      if (observed.loadCount >= 2) resolve({
        loadResults,
        ...snapshotReader(reader, observed)
      });
    });
    reader.readAsArrayBuffer(firstBlob);
  });
  const promiseLoadReentry = async (firstBlob, secondBlob) => {
    const reader = new FileReader();
    const observed = monitor(reader);
    const loadResults = [];
    reader.addEventListener('load', () => loadResults.push(resultTag(reader.result)));
    const firstLoad = new Promise(resolve => reader.addEventListener('load', resolve, {once: true}));
    const finishedSecondLoad = new Promise(resolve => reader.addEventListener('loadend', () => {
      if (observed.loadCount >= 2) resolve();
    }));
    reader.readAsText(firstBlob);
    await firstLoad;
    const readyStateAfterAwait = reader.readyState;
    reader.readAsText(secondBlob);
    const readyStateAfterSecondRead = reader.readyState;
    await finishedSecondLoad;
    return {
      readyStateAfterAwait,
      readyStateAfterSecondRead,
      loadResults,
      ...snapshotReader(reader, observed)
    };
  };
  const publish = name => { resultNode.textContent = JSON.stringify(model[name]); };
  document.querySelector('#read-selected').addEventListener('click', async () => {
    resultNode.textContent = 'WAITING';
    resultNode.textContent = 'RUNNING_SELECTED';
    const input = document.querySelector('#selected-file');
    const file = input.files && input.files[0];
    if (!file) {
      resultNode.textContent = 'WAITING_FILE';
      return;
    }
    const entries = await Promise.all([
      read(file, 'readAsText', 'text'),
      read(file, 'readAsArrayBuffer', 'arrayBuffer'),
      read(file, 'readAsDataURL', 'dataURL'),
      read(file, 'readAsBinaryString', 'binaryString')
    ]);
    model.selected = {
      file: {name: file.name, type: file.type, size: file.size},
      reads: {text: entries[0], arrayBuffer: entries[1], dataURL: entries[2], binaryString: entries[3]}
    };
    publish('selected');
  });
  document.querySelector('#read-programmatic').addEventListener('click', async () => {
    resultNode.textContent = 'WAITING';
    resultNode.textContent = 'RUNNING_PROGRAMMATIC';
    const bytes = makeBlob([0, 127, 128, 255, 13, 10], 'application/octet-stream');
    const file = new File([Uint8Array.from([70, 105, 108, 101, 32, 114, 101, 97, 100, 101, 114])], 'reader-file.txt', {
      type: 'text/plain', lastModified: 123456789
    });
    const encodings = [
      readText('utf8Bom', makeBlob([239, 187, 191, 65])),
      readText('utf16leBom', makeBlob([255, 254, 65, 0, 66, 0])),
      readText('utf16beBom', makeBlob([254, 255, 0, 65, 0, 66])),
      readText('utf16BomExplicitUtf8', makeBlob([255, 254, 65, 0, 66, 0]), 'utf-8'),
      readText('utf8BomExplicitWindows1252', makeBlob([239, 187, 191, 65]), 'windows-1252'),
      readText('mimeWindows1252Ignored', makeBlob([128, 147, 65, 148], 'text/plain;charset=windows-1252')),
      readText('mimeQuotedCharsetIgnored', makeBlob([128], 'text/plain;charset="windows-1252"')),
      readText('mimeInvalidCharsetIgnored', makeBlob([128], 'text/plain;charset=invalid-encoding')),
      readText('explicitWindows1252', makeBlob([128]), 'windows-1252'),
      readText('utf8Invalid', makeBlob([226, 130])),
      readText('utf8Truncated', makeBlob([226, 130, 65])),
      readText('windows1252Alias', makeBlob([128]), 'iso-8859-1'),
      readText('fileDefaultText', file)
    ];
    const results = Object.fromEntries(await Promise.all(encodings));
    const binaryReads = {
      text: await read(bytes, 'readAsText', 'text'),
      arrayBuffer: await read(bytes, 'readAsArrayBuffer', 'arrayBuffer'),
      dataURL: await read(bytes, 'readAsDataURL', 'dataURL'),
      binaryString: await read(bytes, 'readAsBinaryString', 'binaryString'),
      emptyArrayBuffer: await read(new Blob([]), 'readAsArrayBuffer', 'arrayBuffer')
    };
    model.programmatic = {
      file: {name: file.name, type: file.type, size: file.size, lastModified: file.lastModified},
      reads: results,
      selectedBytesAsBlob: binaryReads,
      busyRead: await busyRead(bytes),
      abortEmpty: abortInEmpty(),
      abortImmediate: abortImmediately(bytes),
      abortLoadstart: await abortInLoadstart(bytes),
      abortProgress: await abortInProgress(bytes),
      abortDone: await abortInDone(bytes),
      syncLoadReentry: await syncLoadReentry(bytes, new Blob(['second'])),
      promiseLoadReentry: await promiseLoadReentry(new Blob(['first']), new Blob(['second']))
    };
    publish('programmatic');
  });
})();
</script></body></html>''';

// Filled from the real Chrome run by verify_document_file_reader_browser.mjs.
const fileReaderExpectedJson = r'''{
  "programmatic": {
    "file": {
      "name": "reader-file.txt",
      "type": "text/plain",
      "size": 11,
      "lastModified": 123456789
    },
    "reads": {
      "utf8Bom": {
        "result": "A",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 4,
            "lastLoaded": 4,
            "maxLoaded": 4,
            "total": 4,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf16leBom": {
        "result": "AB",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf16beBom": {
        "result": "AB",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf16BomExplicitUtf8": {
        "result": "AB",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf8BomExplicitWindows1252": {
        "result": "A",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 4,
            "lastLoaded": 4,
            "maxLoaded": 4,
            "total": 4,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "mimeWindows1252Ignored": {
        "result": "��A�",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:4"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 4,
              "total": 4,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:4"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 4,
            "lastLoaded": 4,
            "maxLoaded": 4,
            "total": 4,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "mimeQuotedCharsetIgnored": {
        "result": "�",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 1,
            "lastLoaded": 1,
            "maxLoaded": 1,
            "total": 1,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "mimeInvalidCharsetIgnored": {
        "result": "�",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 1,
            "lastLoaded": 1,
            "maxLoaded": 1,
            "total": 1,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "explicitWindows1252": {
        "result": "€",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 1,
            "lastLoaded": 1,
            "maxLoaded": 1,
            "total": 1,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf8Invalid": {
        "result": "�",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 2,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 2,
              "total": 2,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 2,
              "total": 2,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 2,
            "lastLoaded": 2,
            "maxLoaded": 2,
            "total": 2,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "utf8Truncated": {
        "result": "�A",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 3,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 3,
              "total": 3,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 3,
              "total": 3,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:2"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 3,
            "lastLoaded": 3,
            "maxLoaded": 3,
            "total": 3,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "windows1252Alias": {
        "result": "€",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 1,
              "total": 1,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:1"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 1,
            "lastLoaded": 1,
            "maxLoaded": 1,
            "total": 1,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "fileDefaultText": {
        "result": "File reader",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 11,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 11,
              "total": 11,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:11"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 11,
              "total": 11,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:11"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 11,
            "lastLoaded": 11,
            "maxLoaded": 11,
            "total": 11,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      }
    },
    "selectedBytesAsBlob": {
      "text": {
        "result": "\u0000��\r\n",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "arrayBuffer": {
        "result": [
          0,
          127,
          128,
          255,
          13,
          10
        ],
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "dataURL": {
        "result": "data:application/octet-stream;base64,AH+A/w0K",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:45"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:45"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "binaryString": {
        "result": [
          0,
          127,
          128,
          255,
          13,
          10
        ],
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "emptyArrayBuffer": {
        "result": [],
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 0,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:0"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:0"
            }
          ],
          "progress": {
            "present": false
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      }
    },
    "busyRead": {
      "secondRead": {
        "thrownName": "InvalidStateError",
        "stateAtThrow": 1
      },
      "finalReadyState": 2,
      "finalErrorName": null,
      "finalResultTag": "ArrayBuffer:6",
      "events": {
        "order": [
          "loadstart",
          "progress",
          "load",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          }
        ],
        "progress": {
          "present": true,
          "firstLoaded": 6,
          "lastLoaded": 6,
          "maxLoaded": 6,
          "total": 6,
          "lengthComputableEvery": true,
          "state": 1,
          "errorName": null
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    },
    "abortEmpty": {
      "finalReadyState": 0,
      "finalErrorName": null,
      "finalResultTag": null,
      "events": {
        "order": [],
        "events": [],
        "progress": {
          "present": false
        },
        "flags": null,
        "flagsConsistent": true
      }
    },
    "abortImmediate": {
      "afterFirstAbort": {
        "finalReadyState": 2,
        "finalErrorName": "AbortError",
        "finalResultTag": null,
        "events": {
          "order": [
            "abort",
            "loadend"
          ],
          "events": [
            {
              "type": "abort",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": false,
              "errorName": "AbortError",
              "resultTag": null
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": false,
              "errorName": "AbortError",
              "resultTag": null
            }
          ],
          "progress": {
            "present": false
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "afterSecondAbort": {
        "finalReadyState": 2,
        "finalErrorName": "AbortError",
        "finalResultTag": null,
        "events": {
          "order": [
            "abort",
            "loadend"
          ],
          "events": [
            {
              "type": "abort",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": false,
              "errorName": "AbortError",
              "resultTag": null
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 0,
              "total": 0,
              "lengthComputable": false,
              "errorName": "AbortError",
              "resultTag": null
            }
          ],
          "progress": {
            "present": false
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      }
    },
    "abortLoadstart": {
      "finalReadyState": 2,
      "finalErrorName": "AbortError",
      "finalResultTag": null,
      "events": {
        "order": [
          "loadstart",
          "abort",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "abort",
            "state": 2,
            "loaded": 0,
            "total": 0,
            "lengthComputable": false,
            "errorName": "AbortError",
            "resultTag": null
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 0,
            "total": 0,
            "lengthComputable": false,
            "errorName": "AbortError",
            "resultTag": null
          }
        ],
        "progress": {
          "present": false
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    },
    "abortProgress": {
      "afterAbortCall": {
        "readyState": 1,
        "errorName": null,
        "resultTag": null
      },
      "finalReadyState": 2,
      "finalErrorName": null,
      "finalResultTag": "ArrayBuffer:6",
      "events": {
        "order": [
          "loadstart",
          "progress",
          "load",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          }
        ],
        "progress": {
          "present": true,
          "firstLoaded": 6,
          "lastLoaded": 6,
          "maxLoaded": 6,
          "total": 6,
          "lengthComputableEvery": true,
          "state": 1,
          "errorName": null
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    },
    "abortDone": {
      "finalReadyState": 2,
      "finalErrorName": null,
      "finalResultTag": "ArrayBuffer:6",
      "events": {
        "order": [
          "loadstart",
          "progress",
          "load",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          }
        ],
        "progress": {
          "present": true,
          "firstLoaded": 6,
          "lastLoaded": 6,
          "maxLoaded": 6,
          "total": 6,
          "lengthComputableEvery": true,
          "state": 1,
          "errorName": null
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    },
    "syncLoadReentry": {
      "loadResults": [
        "ArrayBuffer:6",
        "string:6"
      ],
      "finalReadyState": 2,
      "finalErrorName": null,
      "finalResultTag": "string:6",
      "events": {
        "order": [
          "loadstart",
          "progress",
          "load",
          "loadstart",
          "progress",
          "load",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "ArrayBuffer:6"
          },
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "string:6"
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "string:6"
          }
        ],
        "progress": {
          "present": true,
          "firstLoaded": 6,
          "lastLoaded": 6,
          "maxLoaded": 6,
          "total": 6,
          "lengthComputableEvery": true,
          "state": 1,
          "errorName": null
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    },
    "promiseLoadReentry": {
      "readyStateAfterAwait": 2,
      "readyStateAfterSecondRead": 1,
      "loadResults": [
        "string:5",
        "string:6"
      ],
      "finalReadyState": 2,
      "finalErrorName": null,
      "finalResultTag": "string:6",
      "events": {
        "order": [
          "loadstart",
          "progress",
          "load",
          "loadstart",
          "progress",
          "load",
          "loadend"
        ],
        "events": [
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 5,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 5,
            "total": 5,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "string:5"
          },
          {
            "type": "loadstart",
            "state": 1,
            "loaded": 0,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": null
          },
          {
            "type": "load",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "string:6"
          },
          {
            "type": "loadend",
            "state": 2,
            "loaded": 6,
            "total": 6,
            "lengthComputable": true,
            "errorName": null,
            "resultTag": "string:6"
          }
        ],
        "progress": {
          "present": true,
          "firstLoaded": 5,
          "lastLoaded": 6,
          "maxLoaded": 6,
          "total": 6,
          "lengthComputableEvery": true,
          "state": 1,
          "errorName": null
        },
        "flags": {
          "bubbles": false,
          "cancelable": false,
          "composed": false,
          "isTrusted": true
        },
        "flagsConsistent": true
      }
    }
  },
  "selected": {
    "file": {
      "name": "selected.bin",
      "type": "application/octet-stream",
      "size": 6
    },
    "reads": {
      "text": {
        "result": "\u0000��\r\n",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "arrayBuffer": {
        "result": [
          0,
          127,
          128,
          255,
          13,
          10
        ],
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "ArrayBuffer:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "dataURL": {
        "result": "data:application/octet-stream;base64,AH+A/w0K",
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:45"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:45"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      },
      "binaryString": {
        "result": [
          0,
          127,
          128,
          255,
          13,
          10
        ],
        "finalReadyState": 2,
        "finalErrorName": null,
        "events": {
          "order": [
            "loadstart",
            "progress",
            "load",
            "loadend"
          ],
          "events": [
            {
              "type": "loadstart",
              "state": 1,
              "loaded": 0,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": null
            },
            {
              "type": "load",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            },
            {
              "type": "loadend",
              "state": 2,
              "loaded": 6,
              "total": 6,
              "lengthComputable": true,
              "errorName": null,
              "resultTag": "string:6"
            }
          ],
          "progress": {
            "present": true,
            "firstLoaded": 6,
            "lastLoaded": 6,
            "maxLoaded": 6,
            "total": 6,
            "lengthComputableEvery": true,
            "state": 1,
            "errorName": null
          },
          "flags": {
            "bubbles": false,
            "cancelable": false,
            "composed": false,
            "isTrusted": true
          },
          "flagsConsistent": true
        }
      }
    }
  }
}''';
