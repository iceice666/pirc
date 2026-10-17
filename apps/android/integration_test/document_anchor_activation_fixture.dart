const documentAnchorActivationFixture =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>Anchor activation fixture</title></head><body>
<h1>Anchor activation</h1>
<p id="instructions">Choose one case. Each browser oracle case starts in a fresh document.</p>
<section id="case-buttons" aria-label="Anchor activation cases"></section>
<p id="status">READY</p>
<pre id="result">READY</pre>
<div id="anchor-host"></div>
<script>
(function() {
  var caseIds = [
    'detached-click',
    'connected-click',
    'child-click',
    'mouse-dispatch',
    'plain-event-dispatch',
    'prevent-default',
    'mutate-href',
    'add-href-in-listener',
    'remove-href-in-listener',
    'mutate-target',
    'mutate-download',
    'remove-anchor',
    'target-blank-default',
    'base-target',
    'rel-noopener',
    'rel-noreferrer',
    'referrerpolicy',
    'data-download',
    'blob-download',
    'blob-download-revoke',
    'gesture-popup',
    'startup-popup',
    'timer-popup'
  ];
  var resultNode = document.querySelector('#result');
  var statusNode = document.querySelector('#status');
  var anchorHost = document.querySelector('#anchor-host');
  var triggerSnapshots = [];

  function destination(caseId) {
    return '/destination/' + encodeURIComponent(caseId);
  }

  function anchorSnapshot(anchor) {
    return {
      connected: anchor.isConnected,
      hrefAttribute: anchor.getAttribute('href'),
      href: anchor.href,
      targetAttribute: anchor.getAttribute('target'),
      target: anchor.target,
      downloadAttribute: anchor.getAttribute('download'),
      download: anchor.download,
      rel: anchor.rel,
      referrerPolicy: anchor.referrerPolicy
    };
  }

  function eventSnapshot(event) {
    return {
      type: event.type,
      targetId: event.target && event.target.id ? event.target.id : '',
      currentTargetId: event.currentTarget && event.currentTarget.id ? event.currentTarget.id : '',
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      detail: typeof event.detail === 'number' ? event.detail : null,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      button: typeof event.button === 'number' ? event.button : null,
      buttons: typeof event.buttons === 'number' ? event.buttons : null,
      isMouseEvent: event instanceof MouseEvent,
      isPointerEvent: typeof PointerEvent === 'function' && event instanceof PointerEvent
    };
  }

  function publish(result) {
    window.documentAnchorActivationResult = result;
    resultNode.textContent = JSON.stringify(result);
    statusNode.textContent = 'DONE ' + result.caseId;
    if (typeof window.__recordAnchorOracleResult === 'function') {
      window.__recordAnchorOracleResult(result);
    }
  }

  function makeAnchor(caseId) {
    var anchor = document.createElement('a');
    anchor.id = 'activation-anchor';
    anchor.textContent = 'Activate ' + caseId;
    anchor.href = destination(caseId);

    if (caseId === 'mutate-target' || caseId === 'gesture-popup' ||
        caseId === 'startup-popup' || caseId === 'timer-popup' ||
        caseId === 'target-blank-default' || caseId === 'rel-noopener' ||
        caseId === 'rel-noreferrer' || caseId === 'referrerpolicy') {
      anchor.href = destination(caseId);
    }
    if (caseId === 'mutate-download') {
      anchor.href = '/download/server-bytes.txt';
    }
    if (caseId === 'data-download') {
      anchor.href = 'data:text/plain;charset=utf-8,ANCHOR_DATA_DOWNLOAD_SNOW_%E2%9C%85';
      anchor.download = 'anchor-data.txt';
    }
    if (caseId === 'blob-download' || caseId === 'blob-download-revoke') {
      var bytes = new Uint8Array([
        65, 78, 67, 72, 79, 82, 95, 66, 76, 79, 66, 95, 83, 78, 79, 87, 95,
        226, 156, 133
      ]);
      anchor.href = URL.createObjectURL(new Blob([bytes], {type: 'text/plain;charset=utf-8'}));
      anchor.download = caseId === 'blob-download-revoke'
        ? 'anchor-blob-revoke.txt'
        : 'anchor-blob.txt';
    }
    if (caseId === 'mutate-target') {
      anchor.href = '/destination/mutate-target-original';
      anchor.target = '_self';
    }
    if (caseId === 'mutate-download') anchor.removeAttribute('download');
    if (caseId === 'target-blank-default' || caseId === 'rel-noopener' ||
        caseId === 'rel-noreferrer' || caseId === 'referrerpolicy' ||
        caseId === 'gesture-popup' || caseId === 'startup-popup' ||
        caseId === 'timer-popup') {
      anchor.target = '_blank';
    }
    if (caseId === 'rel-noopener') anchor.rel = 'noopener';
    if (caseId === 'rel-noreferrer') anchor.rel = 'noreferrer';
    if (caseId === 'referrerpolicy') anchor.referrerPolicy = 'no-referrer';

    return anchor;
  }

  function runDocumentAnchorActivation(caseId, invocation) {
    if (caseIds.indexOf(caseId) === -1) {
      throw new Error('Unknown anchor activation case: ' + caseId);
    }
    anchorHost.textContent = '';

    var base = document.querySelector('#activation-base');
    if (base) base.parentNode.removeChild(base);
    if (caseId === 'base-target') {
      base = document.createElement('base');
      base.id = 'activation-base';
      base.target = '_blank';
      document.head.appendChild(base);
    }

    var anchor = makeAnchor(caseId);
    var isDetached = caseId === 'detached-click';
    if (caseId === 'add-href-in-listener') anchor.removeAttribute('href');
    if (!isDetached) anchorHost.appendChild(anchor);
    var child = null;
    if (caseId === 'child-click') {
      child = document.createElement('span');
      child.id = 'activation-anchor-child';
      child.textContent = 'Anchor child';
      anchor.textContent = '';
      anchor.appendChild(child);
    }

    var before = anchorSnapshot(anchor);
    var eventRecord = null;
    anchor.addEventListener('click', function(event) {
      var eventBeforeMutation = eventSnapshot(event);
      var anchorBeforeMutation = anchorSnapshot(anchor);
      if (caseId === 'prevent-default') event.preventDefault();
      if (caseId === 'mutate-href') anchor.href = destination('mutate-href-mutated');
      if (caseId === 'add-href-in-listener') anchor.href = destination(caseId);
      if (caseId === 'remove-href-in-listener') anchor.removeAttribute('href');
      if (caseId === 'mutate-target') anchor.target = '_blank';
      if (caseId === 'mutate-download') {
        anchor.href = '/download/server-bytes.txt';
        anchor.download = 'listener-mutated.txt';
      }
      if (caseId === 'remove-anchor' && anchor.parentNode) {
        anchor.parentNode.removeChild(anchor);
      }
      eventRecord = {
        event: eventBeforeMutation,
        defaultPreventedAfterListener: event.defaultPrevented,
        anchorBeforeListenerChanges: anchorBeforeMutation,
        anchorAfterListenerChanges: anchorSnapshot(anchor)
      };
      publish({
        caseId: caseId,
        invocation: invocation || 'api',
        anchorBeforeActivation: before,
        event: eventRecord,
        childId: child ? child.id : null,
        triggerEvents: triggerSnapshots.slice()
      });
    });

    if (caseId === 'mouse-dispatch') {
      anchor.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 1,
        view: window
      }));
    } else if (caseId === 'plain-event-dispatch') {
      anchor.dispatchEvent(new Event('click', {bubbles: true, cancelable: true}));
    } else if (caseId === 'child-click') {
      child.click();
    } else {
      anchor.click();
    }

    if (caseId === 'blob-download-revoke') URL.revokeObjectURL(anchor.href);

    return window.documentAnchorActivationResult || {
      caseId: caseId,
      invocation: invocation || 'api',
      anchorBeforeActivation: before,
      event: eventRecord,
      triggerEvents: triggerSnapshots.slice()
    };
  }

  window.runDocumentAnchorActivation = runDocumentAnchorActivation;
  window.getDocumentAnchorActivationTriggerEvents = function() {
    return triggerSnapshots.slice();
  };

  caseIds.forEach(function(caseId) {
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'run-' + caseId;
    button.setAttribute('data-case', caseId);
    button.textContent = 'Run ' + caseId;
    button.addEventListener('click', function(event) {
      triggerSnapshots.push({
        caseId: caseId,
        type: event.type,
        isTrusted: event.isTrusted,
        detail: event.detail,
        button: event.button,
        buttons: event.buttons
      });
      runDocumentAnchorActivation(caseId, 'visible-button');
    });
    document.querySelector('#case-buttons').appendChild(button);
  });

  var initialCase = new URLSearchParams(location.search).get('case');
  if (initialCase === 'startup-popup') {
    runDocumentAnchorActivation(initialCase, 'parser-startup');
  } else if (initialCase === 'timer-popup') {
    setTimeout(function() {
      runDocumentAnchorActivation(initialCase, 'timer');
    }, 0);
  }
})();
</script></body></html>''';
