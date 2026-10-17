const formDataExpectedOracleJson = r'''{
  "buttonSubmit": {
    "method": "POST",
    "path": "/button-before",
    "search": "",
    "contentType": "multipart/form-data",
    "targetFrame": "button-before-frame",
    "responseText": "DONE:POST:/button-before",
    "entries": [
      {"name": "city", "kind": "text", "value": "城市"},
      {"name": "dup", "kind": "text", "value": "replaced"},
      {"name": "message", "kind": "text", "value": "first line\r\nsecond line"},
      {"name": "choice", "kind": "text", "value": "yes"},
      {"name": "upload", "kind": "file", "filename": "selected-資料.bin", "mimeType": "application/octet-stream", "size": 6, "base64": "AH+A/w0K"},
      {"name": "go", "kind": "text", "value": "yes"},
      {"name": "hook", "kind": "text", "value": "from-event"},
      {"name": "upload", "kind": "file", "filename": "from-event.bin", "mimeType": "application/octet-stream", "size": 3, "base64": "AP8K"},
      {"name": "weird", "kind": "file", "filename": "folder/segment\\tail.bin", "mimeType": "application/octet-stream", "size": 3, "base64": "UQD/"}
    ]
  },
  "requestSubmit": {
    "method": "GET",
    "path": "/request-before",
    "search": "?item=one&dup=last&via=request&request-hook=from-event",
    "contentType": null,
    "targetFrame": "request-before-frame",
    "responseText": "DONE:GET:/request-before",
    "entries": [
      {"name": "item", "kind": "text", "value": "one"},
      {"name": "dup", "kind": "text", "value": "last"},
      {"name": "via", "kind": "text", "value": "request"},
      {"name": "request-hook", "kind": "text", "value": "from-event"}
    ]
  },
  "directSubmit": {
    "method": "POST",
    "path": "/direct-submit",
    "search": "",
    "contentType": "multipart/form-data",
    "targetFrame": "direct-frame",
    "responseText": "DONE:POST:/direct-submit",
    "entries": [{"name": "direct", "kind": "text", "value": "yes"}]
  },
  "reentry": {
    "method": "POST",
    "path": "/reentry-submit",
    "search": "",
    "contentType": "multipart/form-data",
    "targetFrame": "reentry-frame",
    "responseText": "DONE:POST:/reentry-submit",
    "entries": [{"name": "entry", "kind": "text", "value": "one"}],
    "submitEvents": 1,
    "formdataEvents": 1,
    "nested": {
      "submit": "returned",
      "requestSubmit": "returned",
      "newFormData": "throws:InvalidStateError"
    }
  },
  "cancel": {
    "submitEvents": 1,
    "formdataEvents": 0,
    "defaultPrevented": true,
    "requestCount": 0
  },
  "submissionCounts": {
    "button-form": {"submit": 1, "formdata": 1},
    "request-form": {"submit": 1, "formdata": 1},
    "direct-form": {"submit": 0, "formdata": 1},
    "reentry-form": {"submit": 1, "formdata": 1},
    "cancel-form": {"submit": 1, "formdata": 0}
  },
  "nativeEventFlags": {
    "bubbles": true,
    "cancelable": false,
    "composed": false,
    "isTrusted": true,
    "defaultPrevented": false,
    "formEventPhase": 2,
    "documentEventPhase": 3,
    "targetIsForm": true
  },
  "buttonEventOrder": ["submit", "formdata-property", "formdata-listener", "formdata-document"],
  "attributeMutations": {
    "button": {"actionPath": "/button-after", "method": "get", "enctype": "text/plain", "target": "button-after-frame"},
    "request": {"actionPath": "/request-after", "method": "post", "enctype": "multipart/form-data", "target": "request-after-frame"}
  },
  "propertyCases": {
    "attributeFirstType": "function",
    "attributeFirstOrder": ["inline", "listener"],
    "getterIdentityAfterProperty": true,
    "propertyOverrideOrder": ["property-one", "listener"],
    "getterIdentityAfterReplacement": true,
    "propertyReplacementOrder": ["property-two", "listener"],
    "replacementBefore": ["property-one", "listener"],
    "replacementOrder": ["property-two", "listener"],
    "nullAssignmentReturnsNull": true,
    "attributePresentAfterNull": true,
    "nullSuppressesAttributeOrder": ["listener"],
    "removeExistingAttribute": {
      "assignedIdentityBeforeRemove": true,
      "getterIsNullAfterRemove": true,
      "attributeIsAbsent": true,
      "eventOrder": ["listener"]
    },
    "removeAbsentAttribute": {
      "getterIdentityAfterRemove": true,
      "eventOrder": ["property-two", "listener"]
    },
    "setAttributeAfterProperty": {
      "getterIdentityAfterSetAttribute": false,
      "attributeValue": "window.__propertyTrace.push('inline')",
      "eventOrder": ["inline", "listener"]
    }
  }
}''';

const formDataHtml = r'''<!doctype html>
<html>
<head><meta charset="utf-8"><title>Formdata submission oracle</title></head>
<body>
  <form id="button-form" action="/button-before" method="post" enctype="multipart/form-data" target="button-before-frame">
    <input name="city" value="城市">
    <input name="dup" value="first">
    <input name="dup" value="second">
    <textarea name="message">first line
second line</textarea>
    <input name="remove-me" value="removed">
    <label><input type="checkbox" name="choice" value="yes" checked> Choice</label>
    <input id="selected-file" type="file" name="upload" multiple>
    <button id="button-submit" type="submit" name="go" value="yes">Submit button</button>
  </form>
  <iframe name="button-before-frame"></iframe>
  <iframe name="button-after-frame"></iframe>

  <form id="request-form" action="/request-before" method="get" enctype="application/x-www-form-urlencoded" target="request-before-frame">
    <input name="item" value="one">
    <input name="dup" value="first">
    <input name="dup" value="second">
    <input name="remove-me" value="removed">
    <button id="request-submitter" type="submit" name="via" value="request">Request submitter</button>
  </form>
  <button id="request-submit-runner" type="button">Run requestSubmit</button>
  <iframe name="request-before-frame"></iframe>
  <iframe name="request-after-frame"></iframe>

  <form id="direct-form" action="/direct-submit" method="post" enctype="multipart/form-data" target="direct-frame">
    <input name="direct" value="yes">
  </form>
  <button id="direct-submit-runner" type="button">Run form.submit()</button>
  <iframe name="direct-frame"></iframe>

  <form id="reentry-form" action="/reentry-submit" method="post" enctype="multipart/form-data" target="reentry-frame">
    <input name="entry" value="one">
  </form>
  <button id="reentry-submit-runner" type="button">Run reentry requestSubmit</button>
  <iframe name="reentry-frame"></iframe>

  <form id="cancel-form" action="/cancelled" method="post" enctype="multipart/form-data" target="cancel-frame">
    <input name="cancel" value="yes">
  </form>
  <button id="cancel-submit-runner" type="button">Run cancelled requestSubmit</button>
  <iframe name="cancel-frame"></iframe>

  <form id="attribute-handler-form" onformdata="window.__propertyTrace.push('inline')">
    <input name="attribute" value="yes">
  </form>
  <form id="replace-handler-form"><input name="replace" value="yes"></form>
  <form id="set-attribute-after-property-form"><input name="set-attribute" value="yes"></form>

  <script>
    window.__formDataOracle = {
      events: [],
      counts: {
        'button-form': {submit: 0, formdata: 0},
        'request-form': {submit: 0, formdata: 0},
        'direct-form': {submit: 0, formdata: 0},
        'reentry-form': {submit: 0, formdata: 0},
        'cancel-form': {submit: 0, formdata: 0}
      },
      reentry: {submitEvents: 0, formdataEvents: 0, nested: {}},
      cancel: {defaultPrevented: false}
    };
    const oracle = window.__formDataOracle;
    const flags = (event, form) => ({
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      composed: event.composed,
      isTrusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented,
      eventPhase: event.eventPhase,
      targetIsForm: event.target === form
    });

    const buttonForm = document.querySelector('#button-form');
    buttonForm.addEventListener('submit', event => {
      oracle.counts['button-form'].submit++;
      oracle.events.push({type: 'submit', form: 'button-form', submitter: event.submitter?.id ?? null});
    });
    buttonForm.onformdata = event => {
      oracle.counts['button-form'].formdata++;
      oracle.events.push({type: 'formdata-property', form: 'button-form', flags: flags(event, buttonForm)});
    };
    buttonForm.addEventListener('formdata', event => {
      oracle.events.push({type: 'formdata-listener', form: 'button-form', flags: flags(event, buttonForm)});
      event.formData.delete('remove-me');
      event.formData.set('dup', 'replaced');
      event.formData.append('hook', 'from-event');
      event.formData.append('upload', new File([
        new Uint8Array([0, 255, 10])
      ], 'from-event.bin', {type: 'application/octet-stream', lastModified: 123}));
      event.formData.append('weird', new File([
        new Uint8Array([81, 0, 255])
      ], 'folder/segment' + String.fromCharCode(92) + 'tail.bin', {
        type: 'application/octet-stream',
        lastModified: 124
      }));
      buttonForm.action = '/button-after';
      buttonForm.method = 'get';
      buttonForm.enctype = 'text/plain';
      buttonForm.target = 'button-after-frame';
    });

    const requestForm = document.querySelector('#request-form');
    requestForm.addEventListener('submit', event => {
      oracle.counts['request-form'].submit++;
      oracle.events.push({type: 'submit', form: 'request-form', submitter: event.submitter?.id ?? null});
    });
    requestForm.addEventListener('formdata', event => {
      oracle.counts['request-form'].formdata++;
      oracle.events.push({type: 'formdata-listener', form: 'request-form', flags: flags(event, requestForm)});
      event.formData.delete('remove-me');
      event.formData.set('dup', 'last');
      event.formData.append('request-hook', 'from-event');
      requestForm.action = '/request-after';
      requestForm.method = 'post';
      requestForm.enctype = 'multipart/form-data';
      requestForm.target = 'request-after-frame';
    });
    document.querySelector('#request-submit-runner').addEventListener('click', () => {
      requestForm.requestSubmit(document.querySelector('#request-submitter'));
    });

    const directForm = document.querySelector('#direct-form');
    directForm.addEventListener('submit', () => {
      oracle.counts['direct-form'].submit++;
      oracle.events.push({type: 'submit', form: 'direct-form'});
    });
    directForm.addEventListener('formdata', event => {
      oracle.counts['direct-form'].formdata++;
      oracle.events.push({type: 'formdata-listener', form: 'direct-form', flags: flags(event, directForm)});
    });
    document.querySelector('#direct-submit-runner').addEventListener('click', () => directForm.submit());

    const reentryForm = document.querySelector('#reentry-form');
    let reentryStarted = false;
    reentryForm.addEventListener('submit', () => {
      oracle.counts['reentry-form'].submit++;
      oracle.reentry.submitEvents++;
      oracle.events.push({type: 'submit', form: 'reentry-form'});
    });
    reentryForm.addEventListener('formdata', event => {
      oracle.counts['reentry-form'].formdata++;
      oracle.reentry.formdataEvents++;
      oracle.events.push({type: 'formdata-listener', form: 'reentry-form', flags: flags(event, reentryForm)});
      if (reentryStarted) return;
      reentryStarted = true;
      try {
        reentryForm.submit();
        oracle.reentry.nested.submit = 'returned';
      } catch (error) {
        oracle.reentry.nested.submit = 'throws:' + error.name;
      }
      try {
        reentryForm.requestSubmit();
        oracle.reentry.nested.requestSubmit = 'returned';
      } catch (error) {
        oracle.reentry.nested.requestSubmit = 'throws:' + error.name;
      }
      try {
        new FormData(reentryForm);
        oracle.reentry.nested.newFormData = 'returned';
      } catch (error) {
        oracle.reentry.nested.newFormData = 'throws:' + error.name;
      }
    });
    document.querySelector('#reentry-submit-runner').addEventListener('click', () => reentryForm.requestSubmit());

    const cancelForm = document.querySelector('#cancel-form');
    cancelForm.addEventListener('submit', event => {
      oracle.counts['cancel-form'].submit++;
      event.preventDefault();
      oracle.cancel.defaultPrevented = event.defaultPrevented;
      oracle.events.push({type: 'submit', form: 'cancel-form', defaultPrevented: event.defaultPrevented});
    });
    cancelForm.addEventListener('formdata', event => {
      oracle.counts['cancel-form'].formdata++;
      oracle.events.push({type: 'formdata-listener', form: 'cancel-form', flags: flags(event, cancelForm)});
    });
    document.querySelector('#cancel-submit-runner').addEventListener('click', () => cancelForm.requestSubmit());

    document.addEventListener('formdata', event => {
      oracle.events.push({
        type: 'formdata-document',
        form: event.target.id,
        flags: {
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed,
          isTrusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
          eventPhase: event.eventPhase,
          targetIsForm: event.target instanceof HTMLFormElement
        }
      });
    });

    window.__propertyTrace = [];
    const propertyCases = window.__propertyCases = {};
    const traceFormData = form => {
      window.__propertyTrace.length = 0;
      new FormData(form);
      return [...window.__propertyTrace];
    };

    const attributeForm = document.querySelector('#attribute-handler-form');
    attributeForm.addEventListener('formdata', () => window.__propertyTrace.push('listener'));
    propertyCases.attributeFirstType = typeof attributeForm.onformdata;
    propertyCases.attributeFirstOrder = traceFormData(attributeForm);
    const propertyOne = () => window.__propertyTrace.push('property-one');
    attributeForm.onformdata = propertyOne;
    propertyCases.getterIdentityAfterProperty = attributeForm.onformdata === propertyOne;
    propertyCases.propertyOverrideOrder = traceFormData(attributeForm);
    const propertyTwo = () => window.__propertyTrace.push('property-two');
    attributeForm.onformdata = propertyTwo;
    propertyCases.getterIdentityAfterReplacement = attributeForm.onformdata === propertyTwo;
    propertyCases.propertyReplacementOrder = traceFormData(attributeForm);
    attributeForm.onformdata = null;
    propertyCases.nullAssignmentReturnsNull = attributeForm.onformdata === null;
    propertyCases.attributePresentAfterNull = attributeForm.hasAttribute('onformdata');
    propertyCases.nullSuppressesAttributeOrder = traceFormData(attributeForm);
    attributeForm.onformdata = propertyTwo;
    propertyCases.removeExistingAttribute = {
      assignedIdentityBeforeRemove: attributeForm.onformdata === propertyTwo
    };
    attributeForm.removeAttribute('onformdata');
    propertyCases.removeExistingAttribute.getterIsNullAfterRemove = attributeForm.onformdata === null;
    propertyCases.removeExistingAttribute.attributeIsAbsent = !attributeForm.hasAttribute('onformdata');
    propertyCases.removeExistingAttribute.eventOrder = traceFormData(attributeForm);

    const replaceForm = document.querySelector('#replace-handler-form');
    const replaceOne = () => window.__propertyTrace.push('property-one');
    const replaceTwo = () => window.__propertyTrace.push('property-two');
    replaceForm.onformdata = replaceOne;
    replaceForm.addEventListener('formdata', () => window.__propertyTrace.push('listener'));
    const replaceOrder = traceFormData(replaceForm);
    replaceForm.onformdata = replaceTwo;
    const replacementOrder = traceFormData(replaceForm);
    replaceForm.removeAttribute('onformdata');
    propertyCases.removeAbsentAttribute = {
      getterIdentityAfterRemove: replaceForm.onformdata === replaceTwo,
      eventOrder: traceFormData(replaceForm)
    };
    propertyCases.replacementBefore = replaceOrder;
    propertyCases.replacementOrder = replacementOrder;

    const setAttributeForm = document.querySelector('#set-attribute-after-property-form');
    const assignedProperty = () => window.__propertyTrace.push('property');
    setAttributeForm.onformdata = assignedProperty;
    setAttributeForm.addEventListener('formdata', () => window.__propertyTrace.push('listener'));
    setAttributeForm.setAttribute('onformdata', "window.__propertyTrace.push('inline')");
    propertyCases.setAttributeAfterProperty = {
      getterIdentityAfterSetAttribute: setAttributeForm.onformdata === assignedProperty,
      attributeValue: setAttributeForm.getAttribute('onformdata'),
      eventOrder: traceFormData(setAttributeForm)
    };
  </script>
</body>
</html>''';
