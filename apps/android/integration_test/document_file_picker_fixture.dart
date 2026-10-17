const documentFilePickerFixture =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>File picker activation</title>
<style>
body { font: 16px sans-serif; padding: 16px; }
#case-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
#case-buttons button { padding: 6px 10px; }
#file-host { margin-top: 16px; min-height: 32px; }
#result { white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body>
<h1>File picker activation</h1>
<p>Each case has a visible button. Physical cases prepare a file input or label for the browser host to click.</p>
<section id="case-buttons" aria-label="File picker cases"></section>
<p id="status">READY</p>
<pre id="result">READY</pre>
<div id="file-host"></div>
<script>
(function() {
  var caseIds = [
    'connected-click',
    'hidden-click',
    'detached-click',
    'showPicker',
    'hidden-showPicker',
    'readonly-showPicker',
    'explicit-label-click',
    'implicit-label-click',
    'mouse-dispatch',
    'plain-event-dispatch',
    'prevent-default',
    'disabled-click',
    'disabled-showPicker',
    'fieldset-disabled-click',
    'fieldset-legend-click',
    'mutate-accept-multiple',
    'microtask-click',
    'timer-click',
    'repeated-clicks',
    'startup-click',
    'startup-showPicker',
    'physical-file',
    'physical-label-explicit',
    'physical-label-implicit'
  ];
  var resultNode = document.querySelector('#result');
  var statusNode = document.querySelector('#status');
  var fileHost = document.querySelector('#file-host');
  var currentCaseId = null;
  var currentInvocation = null;
  var currentStatus = 'READY';
  var input = null;
  var label = null;
  var eventLog = [];
  var labelEventLog = [];
  var attempts = [];
  var capturedFiles = [];
  var fileCaptureGeneration = 0;
  var triggerEvents = [];

  function fileMetadata(file) {
    return {name: file.name, type: file.type, size: file.size};
  }

  function selectedFileMetadata(control) {
    return Array.prototype.map.call(control.files || [], fileMetadata);
  }

  function controlSnapshot(control) {
    return {
      id: control.id,
      type: control.type,
      connected: control.isConnected,
      disabledProperty: control.disabled,
      disabledByFieldset: control.matches(':disabled'),
      readOnlyProperty: control.readOnly,
      acceptAttribute: control.getAttribute('accept'),
      accept: control.accept,
      multipleAttribute: control.getAttribute('multiple'),
      multiple: control.multiple,
      inlineDisplay: control.style.display,
      value: control.value,
      files: selectedFileMetadata(control)
    };
  }

  function eventSnapshot(event, control) {
    return {
      type: event.type,
      targetId: event.target && event.target.id ? event.target.id : '',
      currentTargetId: event.currentTarget && event.currentTarget.id ? event.currentTarget.id : '',
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      composed: event.composed,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      detail: typeof event.detail === 'number' ? event.detail : null,
      button: typeof event.button === 'number' ? event.button : null,
      buttons: typeof event.buttons === 'number' ? event.buttons : null,
      isMouseEvent: event instanceof MouseEvent,
      isPointerEvent: typeof PointerEvent === 'function' && event instanceof PointerEvent,
      input: controlSnapshot(control)
    };
  }

  function resultValue() {
    return {
      status: currentStatus,
      caseId: currentCaseId,
      invocation: currentInvocation,
      input: input ? controlSnapshot(input) : null,
      events: eventLog.slice(),
      labelEvents: labelEventLog.slice(),
      attempts: attempts.slice(),
      files: capturedFiles.slice(),
      triggerEvents: triggerEvents.slice()
    };
  }

  function publish() {
    var result = resultValue();
    window.documentFilePickerResult = result;
    resultNode.textContent = JSON.stringify(result);
    statusNode.textContent = currentStatus + (currentCaseId ? ' ' + currentCaseId : '');
  }

  function captureSelectedFiles() {
    if (!input) return;
    var generation = ++fileCaptureGeneration;
    var files = Array.prototype.slice.call(input.files || []);
    Promise.all(files.map(function(file) {
      return file.arrayBuffer().then(function(buffer) {
        return {
          name: file.name,
          type: file.type,
          size: file.size,
          bytes: Array.from(new Uint8Array(buffer))
        };
      });
    })).then(function(snapshots) {
      if (generation !== fileCaptureGeneration) return;
      capturedFiles = snapshots;
      publish();
    });
  }

  function buildInput(caseId) {
    fileHost.textContent = '';
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'file-input';
    input.setAttribute('aria-label', 'file input');
    if (caseId === 'hidden-click' || caseId === 'hidden-showPicker') {
      input.style.display = 'none';
    }
    if (caseId === 'readonly-showPicker') input.readOnly = true;
    if (caseId === 'disabled-click' || caseId === 'disabled-showPicker') {
      input.disabled = true;
    }
    if (caseId === 'mutate-accept-multiple') input.accept = '.txt';

    var explicitLabelCase = caseId === 'explicit-label-click' ||
        caseId === 'physical-label-explicit';
    var implicitLabelCase = caseId === 'implicit-label-click' ||
        caseId === 'physical-label-implicit';
    if (explicitLabelCase || implicitLabelCase) {
      label = document.createElement('label');
      label.id = 'file-label';
      label.style.display = 'inline-flex';
      label.style.gap = '8px';
      label.style.alignItems = 'center';
      var labelText = document.createElement('span');
      labelText.id = 'file-label-text';
      labelText.textContent = 'Choose a file';
      label.appendChild(labelText);
      if (explicitLabelCase) {
        label.htmlFor = input.id;
        fileHost.appendChild(label);
        fileHost.appendChild(input);
      } else {
        label.appendChild(input);
        fileHost.appendChild(label);
      }
      label.addEventListener('click', function(event) {
        labelEventLog.push({
          type: event.type,
          targetId: event.target && event.target.id ? event.target.id : '',
          currentTargetId: event.currentTarget && event.currentTarget.id ? event.currentTarget.id : '',
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed,
          isTrusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
          detail: typeof event.detail === 'number' ? event.detail : null
        });
        publish();
      });
    } else if (caseId === 'fieldset-disabled-click' || caseId === 'fieldset-legend-click') {
      var fieldset = document.createElement('fieldset');
      fieldset.id = 'file-fieldset';
      fieldset.disabled = true;
      var legend = document.createElement('legend');
      legend.textContent = 'First legend ';
      if (caseId === 'fieldset-legend-click') {
        legend.appendChild(input);
      }
      fieldset.appendChild(legend);
      if (caseId === 'fieldset-disabled-click') fieldset.appendChild(input);
      fileHost.appendChild(fieldset);
    } else if (caseId !== 'detached-click') {
      fileHost.appendChild(input);
    }

    input.addEventListener('click', function(event) {
      var before = controlSnapshot(input);
      if (caseId === 'prevent-default') event.preventDefault();
      if (caseId === 'mutate-accept-multiple') {
        input.accept = 'application/octet-stream';
        input.multiple = true;
      }
      eventLog.push({
        ...eventSnapshot(event, input),
        defaultPreventedAfterListener: event.defaultPrevented,
        beforeListenerChanges: before,
        afterListenerChanges: controlSnapshot(input)
      });
      publish();
    });
    ['input', 'change', 'cancel'].forEach(function(type) {
      input.addEventListener(type, function(event) {
        eventLog.push(eventSnapshot(event, input));
        if (type === 'input' || type === 'change') {
          currentStatus = 'DONE';
          captureSelectedFiles();
        }
        publish();
      });
    });
  }

  function attempt(method, callback, target) {
    var record = {
      method: method,
      targetId: target && target.id ? target.id : '',
      targetConnected: target ? target.isConnected : null,
      inputBefore: input ? controlSnapshot(input) : null,
      thrownName: null
    };
    attempts.push(record);
    try {
      callback();
    } catch (error) {
      record.thrownName = error && error.name ? error.name : 'Error';
    }
    record.inputAfter = input ? controlSnapshot(input) : null;
    publish();
  }

  function runDocumentFilePickerCase(caseId, invocation, triggerEvent) {
    if (caseIds.indexOf(caseId) === -1) {
      throw new Error('Unknown file picker case: ' + caseId);
    }
    currentCaseId = caseId;
    currentInvocation = invocation || 'api';
    currentStatus = 'DONE';
    input = null;
    label = null;
    eventLog = [];
    labelEventLog = [];
    attempts = [];
    capturedFiles = [];
    fileCaptureGeneration = 0;
    triggerEvents = triggerEvent ? [triggerEvent] : [];
    buildInput(caseId);

    var physicalCase = caseId === 'physical-file' ||
        caseId === 'physical-label-explicit' || caseId === 'physical-label-implicit';
    if (physicalCase) {
      currentStatus = 'READY_TO_CLICK';
      publish();
      return window.documentFilePickerResult;
    }

    var method = caseId.indexOf('showPicker') !== -1 ? 'showPicker' : 'click';
    if (caseId === 'explicit-label-click' || caseId === 'implicit-label-click') {
      attempt('label.click', function() { label.click(); }, label);
    } else if (caseId === 'mouse-dispatch') {
      attempt('dispatchEvent(MouseEvent)', function() {
        input.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: 1,
          view: window
        }));
      }, input);
    } else if (caseId === 'plain-event-dispatch') {
      attempt('dispatchEvent(Event)', function() {
        input.dispatchEvent(new Event('click', {
          bubbles: true,
          cancelable: true,
          composed: true
        }));
      }, input);
    } else if (caseId === 'microtask-click') {
      attempts.push({method: 'schedule microtask click', targetId: input.id, thrownName: null});
      Promise.resolve().then(function() {
        attempt('click from microtask', function() { input.click(); }, input);
      });
    } else if (caseId === 'timer-click') {
      attempts.push({method: 'schedule zero-delay timer click', targetId: input.id, thrownName: null});
      setTimeout(function() {
        attempt('click from zero-delay timer', function() { input.click(); }, input);
      }, 0);
    } else if (caseId === 'repeated-clicks') {
      attempt('first input.click', function() { input.click(); }, input);
      attempt('second input.click', function() { input.click(); }, input);
    } else {
      attempt('input.' + method, function() { input[method](); }, input);
    }
    publish();
    return window.documentFilePickerResult;
  }

  window.runDocumentFilePickerCase = runDocumentFilePickerCase;

  caseIds.forEach(function(caseId) {
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'run-' + caseId;
    button.setAttribute('data-case', caseId);
    button.textContent = 'Run ' + caseId;
    button.addEventListener('click', function(event) {
      var triggerEvent = {
        caseId: caseId,
        type: event.type,
        isTrusted: event.isTrusted,
        detail: event.detail,
        button: event.button,
        buttons: event.buttons
      };
      runDocumentFilePickerCase(caseId, 'visible-button', triggerEvent);
    });
    document.querySelector('#case-buttons').appendChild(button);
  });

  var initialCase = new URLSearchParams(location.search).get('case');
  if (initialCase === 'startup-click' || initialCase === 'startup-showPicker' ||
      initialCase === 'physical-file' || initialCase === 'physical-label-explicit' ||
      initialCase === 'physical-label-implicit') {
    runDocumentFilePickerCase(initialCase,
      initialCase.indexOf('startup-') === 0 ? 'parser-startup' : 'prepare-physical');
  }
})();
</script></body></html>''';
