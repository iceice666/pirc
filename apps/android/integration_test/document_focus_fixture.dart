const documentFocusFixture =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>Document focus and blur</title>
<style>
body { font: 16px sans-serif; padding: 16px; min-height: 3500px; }
#case-buttons { display: flex; flex-wrap: wrap; gap: 8px; position: sticky; top: 0; background: white; z-index: 2; }
#case-buttons button { padding: 6px 10px; }
#target-host { margin-top: 16px; }
#result { white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body>
<h1>Document focus and blur</h1>
<p>Each visible button runs a named focus case. The oracle prepares initial focus programmatically before clicking a case button.</p>
<section id="case-buttons" aria-label="Document focus cases"></section>
<p id="status">READY</p>
<pre id="result">READY</pre>
<div id="target-host"></div>
<script>
(function() {
  var caseIds = [
    'input-focus-blur',
    'textarea-focus-blur',
    'select-focus-blur',
    'button-focus-blur',
    'checkbox-focus-blur',
    'range-focus-blur',
    'file-focus-blur',
    'same-element-repeat',
    'focus-switch',
    'listener-snapshot',
    'focus-event-flags',
    'focus-prevent-default',
    'blur-prevent-default',
    'disabled-property',
    'disabled-fieldset',
    'disabled-first-legend',
    'hidden-attribute',
    'display-none-ancestor',
    'visibility-hidden',
    'readonly-input',
    'detached-element',
    'plain-div',
    'tabindex-negative',
    'link-href',
    'blur-nonactive',
    'focus-prevent-scroll',
    'reentrant-blur-handler-focus',
    'reentrant-focus-handler-redirect',
    'dirty-user-edit-script-focus'
  ];
  var buttonHost = document.querySelector('#case-buttons');
  var targetHost = document.querySelector('#target-host');
  var resultNode = document.querySelector('#result');
  var statusNode = document.querySelector('#status');
  var currentCaseId = null;
  var currentStatus = 'READY';
  var invocation = null;
  var phase = 'idle';
  var origin = null;
  var target = null;
  var redirect = null;
  var eventLog = [];
  var operations = [];
  var handlerActions = [];
  var initialCapture = null;
  var preventDefaultSeen = null;
  var eventIds = new WeakMap();
  var nextEventId = 1;

  function nodeId(node) {
    if (!node) return null;
    if (node === window) return 'window';
    if (node === document) return 'document';
    return node.id || node.localName || 'node';
  }

  function activeElementSnapshot() {
    var active = document.activeElement;
    return {
      id: nodeId(active),
      tag: active && active.localName ? active.localName : null,
      isBody: active === document.body,
      isDocumentElement: active === document.documentElement
    };
  }

  function elementSnapshot(element) {
    if (!element) return null;
    return {
      id: nodeId(element),
      tag: element.localName,
      type: typeof element.type === 'string' ? element.type : null,
      connected: element.isConnected,
      disabled: typeof element.disabled === 'boolean' ? element.disabled : null,
      disabledByFieldset: typeof element.matches === 'function' ? element.matches(':disabled') : false,
      readOnly: typeof element.readOnly === 'boolean' ? element.readOnly : null,
      hidden: !!element.hidden,
      tabindexAttribute: element.getAttribute ? element.getAttribute('tabindex') : null,
      tabIndexProperty: typeof element.tabIndex === 'number' ? element.tabIndex : null,
      inlineDisplay: element.style ? element.style.display : null,
      inlineVisibility: element.style ? element.style.visibility : null,
      focused: element === document.activeElement
    };
  }

  function eventSnapshot(event) {
    if (!eventIds.has(event)) eventIds.set(event, nextEventId++);
    return {
      dispatchId: eventIds.get(event),
      phase: phase,
      type: event.type,
      targetId: nodeId(event.target),
      currentTargetId: nodeId(event.currentTarget),
      relatedTargetId: nodeId(event.relatedTarget),
      eventPhase: event.eventPhase,
      timeStamp: event.timeStamp,
      bubbles: event.bubbles,
      composed: event.composed,
      cancelable: event.cancelable,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      activeElement: activeElementSnapshot(),
      focusedTarget: event.target === document.activeElement,
      targetConnected: !!event.target.isConnected,
      path: event.composedPath().map(nodeId)
    };
  }

  function resultValue() {
    return {
      status: currentStatus,
      caseId: currentCaseId,
      invocation: invocation,
      initialCapture: initialCapture,
      target: elementSnapshot(target),
      activeElement: activeElementSnapshot(),
      events: eventLog.slice(),
      operations: operations.slice(),
      handlerActions: handlerActions.slice(),
      preventDefaultSeen: preventDefaultSeen
    };
  }

  function publish() {
    var result = resultValue();
    window.documentFocusResult = result;
    resultNode.textContent = JSON.stringify(result);
    statusNode.textContent = currentStatus + (currentCaseId ? ' ' + currentCaseId : '');
  }

  function addTargetListener(element, type, callback, options) {
    element.addEventListener(type, callback, options);
  }

  function installLogging() {
    var types = ['focus', 'blur', 'focusin', 'focusout', 'input', 'change'];
    var listener = function(event) { eventLog.push(eventSnapshot(event)); };
    types.forEach(function(type) {
      window.addEventListener(type, listener, true);
      document.addEventListener(type, listener, true);
      document.addEventListener(type, listener, false);
      window.addEventListener(type, listener, false);
    });
    [origin, target, redirect].filter(function(element, index, list) {
      return element && list.indexOf(element) === index;
    }).forEach(function(element) {
      types.forEach(function(type) {
        element.addEventListener(type, listener, true);
        element.addEventListener(type, listener, false);
      });
    });
  }

  function makeInput(id, type) {
    var element = document.createElement('input');
    element.id = id;
    element.type = type || 'text';
    return element;
  }

  function buildCase(caseId) {
    targetHost.textContent = '';
    origin = makeInput('origin', 'text');
    origin.setAttribute('aria-label', 'starting focus');
    redirect = makeInput('redirect', 'text');
    redirect.setAttribute('aria-label', 'redirect focus');
    target = makeInput('target', 'text');
    target.setAttribute('aria-label', 'case target');
    var wrapper = document.createElement('div');
    wrapper.id = 'target-wrapper';
    targetHost.appendChild(origin);
    targetHost.appendChild(redirect);
    targetHost.appendChild(wrapper);

    if (caseId === 'textarea-focus-blur') {
      target = document.createElement('textarea');
      target.id = 'target';
      target.setAttribute('aria-label', 'case target');
    } else if (caseId === 'select-focus-blur') {
      target = document.createElement('select');
      target.id = 'target';
      target.setAttribute('aria-label', 'case target');
      var option = document.createElement('option');
      option.value = 'one';
      option.textContent = 'one';
      target.appendChild(option);
    } else if (caseId === 'button-focus-blur') {
      target = document.createElement('button');
      target.id = 'target';
      target.type = 'button';
      target.textContent = 'Case button';
    } else if (caseId === 'checkbox-focus-blur') {
      target = makeInput('target', 'checkbox');
    } else if (caseId === 'range-focus-blur') {
      target = makeInput('target', 'range');
    } else if (caseId === 'file-focus-blur') {
      target = makeInput('target', 'file');
    } else if (caseId === 'disabled-property') {
      target.disabled = true;
    } else if (caseId === 'disabled-fieldset' || caseId === 'disabled-first-legend') {
      var fieldset = document.createElement('fieldset');
      fieldset.id = 'target-fieldset';
      fieldset.disabled = true;
      if (caseId === 'disabled-first-legend') {
        var legend = document.createElement('legend');
        legend.textContent = 'First legend ';
        legend.appendChild(target);
        fieldset.appendChild(legend);
      } else {
        fieldset.appendChild(target);
      }
      wrapper.appendChild(fieldset);
    } else if (caseId === 'hidden-attribute') {
      target.hidden = true;
    } else if (caseId === 'display-none-ancestor') {
      wrapper.style.display = 'none';
    } else if (caseId === 'visibility-hidden') {
      target.style.visibility = 'hidden';
    } else if (caseId === 'readonly-input') {
      target.readOnly = true;
    } else if (caseId === 'detached-element') {
      // The target remains detached; the wrapper only contains the visible setup controls.
    } else if (caseId === 'plain-div' || caseId === 'tabindex-negative') {
      target = document.createElement('div');
      target.id = 'target';
      target.textContent = caseId === 'plain-div' ? 'plain div' : 'tabindex minus one';
      if (caseId === 'tabindex-negative') target.setAttribute('tabindex', '-1');
    } else if (caseId === 'link-href') {
      target = document.createElement('a');
      target.id = 'target';
      target.href = '#focus-destination';
      target.textContent = 'focus link';
    } else if (caseId === 'focus-prevent-scroll') {
      target.style.marginTop = '2400px';
    }

    if (caseId !== 'disabled-fieldset' && caseId !== 'disabled-first-legend' &&
        caseId !== 'detached-element' && target.parentNode !== wrapper) {
      wrapper.appendChild(target);
    }

    if (caseId === 'reentrant-blur-handler-focus') {
      var blurRedirected = false;
      origin.addEventListener('blur', function() {
        if (blurRedirected) return;
        blurRedirected = true;
        var before = activeElementSnapshot();
        redirect.focus();
        handlerActions.push({handler: 'origin-blur', action: 'redirect.focus', before: before, after: activeElementSnapshot()});
      }, true);
    }
    if (caseId === 'reentrant-focus-handler-redirect') {
      var focusRedirected = false;
      target.addEventListener('focus', function() {
        if (focusRedirected) return;
        focusRedirected = true;
        var before = activeElementSnapshot();
        redirect.focus();
        handlerActions.push({handler: 'target-focus', action: 'redirect.focus', before: before, after: activeElementSnapshot()});
      }, true);
    }
    if (caseId === 'focus-prevent-default') {
      target.addEventListener('focus', function(event) {
        event.preventDefault();
        preventDefaultSeen = {type: event.type, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented};
      }, true);
    }
    if (caseId === 'blur-prevent-default') {
      target.addEventListener('blur', function(event) {
        event.preventDefault();
        preventDefaultSeen = {type: event.type, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented};
      }, true);
    }

    installLogging();
  }

  function scrollSnapshot() {
    return {x: window.scrollX, y: window.scrollY};
  }

  function prepare(caseId) {
    if (caseIds.indexOf(caseId) === -1) throw new Error('Unknown focus case: ' + caseId);
    currentCaseId = caseId;
    currentStatus = 'READY';
    invocation = null;
    phase = 'setup';
    eventLog = [];
    operations = [];
    handlerActions = [];
    preventDefaultSeen = null;
    buildCase(caseId);
    if (caseId === 'dirty-user-edit-script-focus') target.focus();
    else origin.focus();
    initialCapture = {
      activeElement: activeElementSnapshot(),
      origin: elementSnapshot(origin),
      target: elementSnapshot(target),
      scroll: scrollSnapshot(),
      events: eventLog.slice()
    };
    eventLog = [];
    phase = caseId === 'dirty-user-edit-script-focus' ? 'user-edit' : 'idle';
    publish();
    return initialCapture;
  }

  function recordOperation(name, element) {
    operations.push({
      name: name,
      targetId: nodeId(element),
      activeElement: activeElementSnapshot(),
      targetFocused: element === document.activeElement,
      targetConnected: !!element.isConnected,
      scroll: scrollSnapshot()
    });
  }

  function run(caseId, source) {
    if (caseId !== currentCaseId) prepare(caseId);
    invocation = source || 'programmatic';
    currentStatus = 'RUNNING';
    phase = 'action';

    if (caseId === 'dirty-user-edit-script-focus') {
      phase = 'script-focus';
      redirect.focus();
      recordOperation('redirect.focus after real user edit', redirect);
    } else if (caseId === 'blur-nonactive') {
      target.blur();
      recordOperation('blur non-active target', target);
    } else if (caseId === 'focus-switch' || caseId === 'listener-snapshot') {
      target.focus();
      recordOperation('target.focus', target);
      redirect.focus();
      recordOperation('redirect.focus', redirect);
    } else if (caseId === 'same-element-repeat') {
      target.focus();
      recordOperation('first target.focus', target);
      target.focus();
      recordOperation('second target.focus', target);
      target.blur();
      recordOperation('target.blur', target);
    } else if (caseId === 'input-focus-blur' || caseId === 'textarea-focus-blur' ||
        caseId === 'select-focus-blur' || caseId === 'button-focus-blur' ||
        caseId === 'checkbox-focus-blur' || caseId === 'range-focus-blur' ||
        caseId === 'file-focus-blur' || caseId === 'focus-event-flags' ||
        caseId === 'focus-prevent-default' || caseId === 'blur-prevent-default') {
      target.focus();
      recordOperation('target.focus', target);
      target.blur();
      recordOperation('target.blur', target);
    } else if (caseId === 'focus-prevent-scroll') {
      window.scrollTo(0, 0);
      target.focus({preventScroll: true});
      recordOperation('target.focus({preventScroll:true})', target);
    } else if (caseId === 'reentrant-blur-handler-focus' || caseId === 'reentrant-focus-handler-redirect') {
      target.focus();
      recordOperation('target.focus with reentrant handler', target);
    } else {
      target.focus();
      recordOperation('target.focus', target);
    }

    currentStatus = 'DONE';
    phase = 'complete';
    publish();
    return resultValue();
  }

  caseIds.forEach(function(caseId) {
    var button = document.createElement('button');
    button.type = 'button';
    button.dataset.case = caseId;
    button.textContent = caseId;
    button.setAttribute('aria-label', 'Run ' + caseId);
    button.addEventListener('mousedown', function(event) {
      // Let the case runner's programmatic focus transition remain the only focus action.
      event.preventDefault();
    });
    button.addEventListener('click', function() { run(caseId, 'trusted-visible-button'); });
    buttonHost.appendChild(button);
  });

  window.documentFocusCaseIds = caseIds.slice();
  window.prepareDocumentFocusCase = prepare;
  window.runDocumentFocusCase = run;
  window.beginDocumentFocusUserEdit = function() { phase = 'user-edit'; };
  window.publishDocumentFocusResult = publish;
})();
</script></body></html>''';
