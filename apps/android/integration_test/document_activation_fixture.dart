const documentActivationFixture =
    r'''<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="run-activation-checks" type="button">Run activation checks</button>
<p id="completion">尚未執行啟用行為檢查。</p>
<pre id="result" style="display:none">{"status":"READY"}</pre>

<input id="checkbox" type="checkbox" aria-label="programmatic checkbox">
<input id="cancelled-checkbox" type="checkbox" aria-label="cancelled checkbox">
<input id="radio-one" type="radio" name="radio-group" checked aria-label="radio one">
<input id="radio-two" type="radio" name="radio-group" aria-label="radio two">

<input id="disabled-checkbox" type="checkbox" disabled aria-label="disabled checkbox">
<fieldset id="disabled-fieldset" disabled>
  <legend>Allowed legend <input id="legend-checkbox" type="checkbox" aria-label="legend checkbox"></legend>
  <input id="fieldset-checkbox" type="checkbox" aria-label="fieldset checkbox">
</fieldset>

<form id="submit-form" action="http://127.0.0.1/activation-submit" method="get">
  <button id="submit-button" type="submit"><span id="submit-button-child">Submit from child</span></button>
</form>
<form id="reset-form">
  <input id="reset-value" name="value" value="original">
  <button id="reset-button" type="reset">Reset values</button>
</form>
<form id="cancel-reset-form">
  <input id="cancel-reset-value" name="value" value="original">
  <button id="cancel-reset-button" type="reset">Cancel reset</button>
</form>
<form id="disabled-submit-form" action="http://127.0.0.1/disabled-submit" method="get">
  <button id="disabled-submit-button" type="submit" disabled>Disabled submit</button>
</form>
<form id="disabled-reset-form">
  <input id="disabled-reset-value" name="value" value="original">
  <button id="disabled-reset-button" type="reset" disabled>Disabled reset</button>
</form>
<form id="fieldset-submit-form" action="http://127.0.0.1/fieldset-submit" method="get">
  <fieldset disabled>
    <button id="fieldset-submit-button" type="submit"><span id="fieldset-submit-child">Disabled fieldset submit child</span></button>
  </fieldset>
</form>

<label id="explicit-label" for="explicit-checkbox"><span id="explicit-label-text">Explicit label</span></label>
<input id="explicit-checkbox" type="checkbox" aria-label="explicit checkbox">
<label id="implicit-label"><span id="implicit-label-text">Implicit label</span><input id="implicit-checkbox" type="checkbox" aria-label="implicit checkbox"></label>
<label id="cancel-label" for="cancel-label-checkbox"><span id="cancel-label-text">Cancelled label</span></label>
<input id="cancel-label-checkbox" type="checkbox" aria-label="cancelled label checkbox">
<label id="interactive-label"><button id="interactive-label-child" type="button">Interactive child</button><input id="interactive-label-checkbox" type="checkbox" aria-label="interactive label checkbox"></label>
<label id="disabled-label" for="disabled-label-checkbox">Disabled target label</label>
<input id="disabled-label-checkbox" type="checkbox" disabled aria-label="disabled label checkbox">

<input id="recursive-checkbox" type="checkbox" aria-label="recursive checkbox">
<input id="dispatch-checkbox" type="checkbox" aria-label="dispatch checkbox">
<input id="plain-event-checkbox" type="checkbox" aria-label="plain event checkbox">
<div id="generic-div">Generic element</div>
<button id="generic-button" type="button">Generic button</button>

<input id="physical-checkbox" type="checkbox" aria-label="physical checkbox">
<form id="physical-reset-form">
  <input id="physical-reset-value" name="value" value="original" aria-label="physical reset value">
  <button id="physical-reset-button" type="reset">Physical reset</button>
</form>
<pre id="physical-result" style="display:none">READY</pre>

<script>
(function() {
  var eventLog = [];
  var cancelObservations = [];
  var formObservations = [];
  var runButton = document.querySelector('#run-activation-checks');
  var resultNode = document.querySelector('#result');
  var completionNode = document.querySelector('#completion');
  var physicalResultNode = document.querySelector('#physical-result');

  function snapshot(control, event) {
    var current = event.currentTarget;
    var target = event.target;
    return {
      control: control,
      type: event.type,
      targetId: target && target.id ? target.id : '',
      currentTargetId: current && current.id ? current.id : '',
      checked: current && typeof current.checked === 'boolean' ? current.checked : null,
      indeterminate: current && typeof current.indeterminate === 'boolean' ? current.indeterminate : null,
      value: current && typeof current.value === 'string' ? current.value : null,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      detail: typeof event.detail === 'number' ? event.detail : null,
      button: typeof event.button === 'number' ? event.button : null,
      buttons: typeof event.buttons === 'number' ? event.buttons : null,
      isMouseEvent: event instanceof MouseEvent,
      isPointerEvent: typeof PointerEvent === 'function' && event instanceof PointerEvent,
      submitterId: event.submitter && event.submitter.id ? event.submitter.id : null
    };
  }

  function watch(control, element, types) {
    types.forEach(function(type) {
      element.addEventListener(type, function(event) {
        eventLog.push(snapshot(control, event));
      });
    });
  }

  function checkable(control, selector) {
    watch(control, document.querySelector(selector), ['click', 'input', 'change']);
  }

  checkable('checkbox', '#checkbox');
  checkable('cancelledCheckbox', '#cancelled-checkbox');
  checkable('radioOne', '#radio-one');
  checkable('radioTwo', '#radio-two');
  checkable('disabledCheckbox', '#disabled-checkbox');
  checkable('legendCheckbox', '#legend-checkbox');
  checkable('fieldsetCheckbox', '#fieldset-checkbox');
  checkable('explicitCheckbox', '#explicit-checkbox');
  checkable('implicitCheckbox', '#implicit-checkbox');
  checkable('cancelLabelCheckbox', '#cancel-label-checkbox');
  checkable('interactiveLabelCheckbox', '#interactive-label-checkbox');
  checkable('disabledLabelCheckbox', '#disabled-label-checkbox');
  checkable('recursiveCheckbox', '#recursive-checkbox');
  checkable('dispatchCheckbox', '#dispatch-checkbox');
  checkable('plainEventCheckbox', '#plain-event-checkbox');
  watch('genericDiv', document.querySelector('#generic-div'), ['click']);
  watch('genericButton', document.querySelector('#generic-button'), ['click']);
  watch('submitButton', document.querySelector('#submit-button'), ['click']);
  watch('submitButtonChild', document.querySelector('#submit-button-child'), ['click']);
  watch('submitForm', document.querySelector('#submit-form'), ['submit']);
  watch('resetForm', document.querySelector('#reset-form'), ['reset']);
  watch('cancelResetForm', document.querySelector('#cancel-reset-form'), ['reset']);
  watch('disabledSubmitButton', document.querySelector('#disabled-submit-button'), ['click']);
  watch('disabledSubmitForm', document.querySelector('#disabled-submit-form'), ['submit']);
  watch('disabledResetButton', document.querySelector('#disabled-reset-button'), ['click']);
  watch('disabledResetForm', document.querySelector('#disabled-reset-form'), ['reset']);
  watch('fieldsetSubmitButton', document.querySelector('#fieldset-submit-button'), ['click']);
  watch('fieldsetSubmitChild', document.querySelector('#fieldset-submit-child'), ['click']);
  watch('fieldsetSubmitForm', document.querySelector('#fieldset-submit-form'), ['submit']);
  watch('interactiveLabelChild', document.querySelector('#interactive-label-child'), ['click']);
  watch('physicalCheckbox', document.querySelector('#physical-checkbox'), ['click', 'input', 'change']);
  watch('physicalResetForm', document.querySelector('#physical-reset-form'), ['reset']);

  document.querySelector('#cancelled-checkbox').addEventListener('click', function(event) {
    event.preventDefault();
  });
  document.querySelector('#cancel-label').addEventListener('click', function(event) {
    event.preventDefault();
  });
  document.querySelector('#cancel-reset-form').addEventListener('reset', function(event) {
    event.preventDefault();
  });
  document.querySelector('#submit-form').addEventListener('submit', function(event) {
    event.preventDefault();
  });
  document.querySelector('#disabled-submit-form').addEventListener('submit', function(event) {
    event.preventDefault();
  });
  document.querySelector('#fieldset-submit-form').addEventListener('submit', function(event) {
    event.preventDefault();
  });
  document.body.addEventListener('click', function(event) {
    if (event.target && (event.target.id === 'cancelled-checkbox' || event.target.id === 'cancel-label-text')) {
      cancelObservations.push({
        targetId: event.target.id,
        defaultPrevented: event.defaultPrevented,
        checked: event.target.checked === true
      });
    }
  });
  document.body.addEventListener('submit', function(event) {
    formObservations.push({
      targetId: event.target && event.target.id ? event.target.id : '',
      submitterId: event.submitter && event.submitter.id ? event.submitter.id : null,
      defaultPrevented: event.defaultPrevented
    });
  });
  document.body.addEventListener('reset', function(event) {
    formObservations.push({
      targetId: event.target && event.target.id ? event.target.id : '',
      defaultPrevented: event.defaultPrevented
    });
  });

  var recursiveRunning = false;
  var recursiveReentryAttempts = 0;
  document.querySelector('#recursive-checkbox').addEventListener('click', function() {
    if (recursiveRunning) return;
    recursiveRunning = true;
    recursiveReentryAttempts += 1;
    document.querySelector('#recursive-checkbox').click();
    recursiveRunning = false;
  });

  function eventsFor(control) {
    return eventLog.filter(function(item) { return item.control === control; });
  }

  function checked(id) {
    return document.querySelector('#' + id).checked;
  }

  function state(id) {
    var element = document.querySelector('#' + id);
    return { checked: element.checked, indeterminate: element.indeterminate };
  }

  function publishPhysicalActivationResult() {
    var result = {
      checkbox: {
        events: eventsFor('physicalCheckbox'),
        checked: checked('physical-checkbox')
      },
      reset: {
        events: eventsFor('physicalResetForm'),
        formObservation: formObservations.filter(function(item) {
          return item.targetId === 'physical-reset-form';
        }),
        value: document.querySelector('#physical-reset-value').value
      }
    };
    window.documentPhysicalActivationResult = result;
    physicalResultNode.textContent = JSON.stringify(result);
  }

  function schedulePhysicalActivationResult() {
    setTimeout(publishPhysicalActivationResult, 0);
  }

  document.querySelector('#physical-checkbox').addEventListener(
    'change', schedulePhysicalActivationResult
  );
  document.querySelector('#physical-reset-form').addEventListener(
    'reset', schedulePhysicalActivationResult
  );

  function runActivationChecks() {
    eventLog = [];
    cancelObservations = [];
    formObservations = [];

    var checkbox = document.querySelector('#checkbox');
    checkbox.checked = false;
    checkbox.indeterminate = true;
    checkbox.click();
    var checkboxCase = { events: eventsFor('checkbox'), after: state('checkbox') };

    var cancelledCheckbox = document.querySelector('#cancelled-checkbox');
    cancelledCheckbox.checked = false;
    cancelledCheckbox.indeterminate = true;
    cancelledCheckbox.click();
    var cancelledCheckboxCase = {
      events: eventsFor('cancelledCheckbox'),
      after: state('cancelled-checkbox'),
      documentObservation: cancelObservations.length ? cancelObservations[0] : null
    };

    document.querySelector('#radio-one').checked = true;
    document.querySelector('#radio-two').checked = false;
    document.querySelector('#radio-two').click();
    document.querySelector('#radio-two').click();
    var radioCase = {
      radioOneEvents: eventsFor('radioOne'),
      radioTwoEvents: eventsFor('radioTwo'),
      after: { radioOne: checked('radio-one'), radioTwo: checked('radio-two') }
    };

    document.querySelector('#disabled-checkbox').click();
    document.querySelector('#fieldset-checkbox').click();
    document.querySelector('#legend-checkbox').click();
    var disabledCase = {
      ownDisabledEvents: eventsFor('disabledCheckbox'),
      fieldsetDescendantEvents: eventsFor('fieldsetCheckbox'),
      firstLegendEvents: eventsFor('legendCheckbox'),
      after: {
        ownDisabled: checked('disabled-checkbox'),
        fieldsetDescendant: checked('fieldset-checkbox'),
        firstLegend: checked('legend-checkbox')
      }
    };

    document.querySelector('#submit-button-child').click();
    var submitFormCase = {
      childClickEvents: eventsFor('submitButtonChild'),
      buttonClickEvents: eventsFor('submitButton'),
      submitEvents: eventsFor('submitForm'),
      documentObservation: formObservations.length ? formObservations[0] : null
    };

    document.querySelector('#reset-value').value = 'changed';
    document.querySelector('#reset-button').click();
    var resetCase = {
      events: eventsFor('resetForm'),
      valueAfter: document.querySelector('#reset-value').value,
      documentObservation: formObservations.length > 1 ? formObservations[1] : null
    };

    document.querySelector('#cancel-reset-value').value = 'changed';
    document.querySelector('#cancel-reset-button').click();
    var cancelledResetCase = {
      events: eventsFor('cancelResetForm'),
      valueAfter: document.querySelector('#cancel-reset-value').value,
      documentObservation: formObservations.length > 2 ? formObservations[2] : null
    };

    document.querySelector('#explicit-label-text').click();
    document.querySelector('#implicit-label-text').click();
    document.querySelector('#cancel-label-text').click();
    document.querySelector('#interactive-label-child').click();
    document.querySelector('#disabled-label').click();
    var labelCase = {
      explicit: { events: eventsFor('explicitCheckbox'), checked: checked('explicit-checkbox') },
      implicit: { events: eventsFor('implicitCheckbox'), checked: checked('implicit-checkbox') },
      cancelled: {
        events: eventsFor('cancelLabelCheckbox'),
        checked: checked('cancel-label-checkbox'),
        documentObservation: cancelObservations.length > 1 ? cancelObservations[1] : null
      },
      interactiveDescendant: {
        labelControlEvents: eventsFor('interactiveLabelCheckbox'),
        childEvents: eventsFor('interactiveLabelChild'),
        checked: checked('interactive-label-checkbox')
      },
      disabledTarget: { events: eventsFor('disabledLabelCheckbox'), checked: checked('disabled-label-checkbox') }
    };

    document.querySelector('#recursive-checkbox').checked = false;
    recursiveReentryAttempts = 0;
    document.querySelector('#recursive-checkbox').click();
    var recursiveCase = {
      events: eventsFor('recursiveCheckbox'),
      reentryAttempts: recursiveReentryAttempts,
      after: checked('recursive-checkbox')
    };

    document.querySelector('#disabled-checkbox').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    var disabledMouseEventDispatchCase = {
      events: eventsFor('disabledCheckbox'),
      after: checked('disabled-checkbox')
    };

    document.querySelector('#dispatch-checkbox').checked = false;
    document.querySelector('#dispatch-checkbox').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    var mouseEventDispatchCase = {
      events: eventsFor('dispatchCheckbox'),
      after: checked('dispatch-checkbox')
    };

    document.querySelector('#plain-event-checkbox').checked = false;
    document.querySelector('#plain-event-checkbox').dispatchEvent(
      new Event('click', { bubbles: true, cancelable: true })
    );
    var plainEventDispatchCase = {
      events: eventsFor('plainEventCheckbox'),
      after: checked('plain-event-checkbox')
    };

    document.querySelector('#disabled-submit-button').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    var disabledSubmitMouseEventCase = {
      buttonEvents: eventsFor('disabledSubmitButton'),
      submitEvents: eventsFor('disabledSubmitForm'),
      documentObservation: formObservations.filter(function(item) { return item.targetId === 'disabled-submit-form'; })
    };

    document.querySelector('#disabled-reset-value').value = 'changed';
    document.querySelector('#disabled-reset-button').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    var disabledResetMouseEventCase = {
      buttonEvents: eventsFor('disabledResetButton'),
      resetEvents: eventsFor('disabledResetForm'),
      documentObservation: formObservations.filter(function(item) { return item.targetId === 'disabled-reset-form'; }),
      valueAfter: document.querySelector('#disabled-reset-value').value
    };

    document.querySelector('#fieldset-submit-child').click();
    var disabledFieldsetChildClickCase = {
      childEvents: eventsFor('fieldsetSubmitChild'),
      buttonEvents: eventsFor('fieldsetSubmitButton'),
      submitEvents: eventsFor('fieldsetSubmitForm'),
      documentObservation: formObservations.filter(function(item) { return item.targetId === 'fieldset-submit-form'; })
    };

    document.querySelector('#generic-div').click();
    document.querySelector('#generic-button').click();
    var eventShapesCase = {
      divClick: eventsFor('genericDiv'),
      buttonClick: eventsFor('genericButton')
    };

    var result = {
      status: 'DONE',
      cases: {
        checkbox: checkboxCase,
        cancelledCheckbox: cancelledCheckboxCase,
        radio: radioCase,
        disabled: disabledCase,
        submitButtonChildClick: submitFormCase,
        resetButton: resetCase,
        cancelledResetButton: cancelledResetCase,
        label: labelCase,
        recursiveClick: recursiveCase,
        disabledMouseEventDispatch: disabledMouseEventDispatchCase,
        mouseEventDispatch: mouseEventDispatchCase,
        plainEventDispatch: plainEventDispatchCase,
        disabledSubmitMouseEventDispatch: disabledSubmitMouseEventCase,
        disabledResetMouseEventDispatch: disabledResetMouseEventCase,
        disabledFieldsetChildClick: disabledFieldsetChildClickCase,
        eventShapes: eventShapesCase
      },
      networkSubmissionCount: 0
    };
    window.documentActivationResult = result;
    resultNode.textContent = JSON.stringify(result);
    completionNode.textContent = '原生控制啟用行為驗證完成。';
  }

  runButton.addEventListener('click', runActivationChecks);
  window.runDocumentActivationChecks = runActivationChecks;
  window.getDocumentActivationEventLog = function() { return eventLog.slice(); };
  window.getDocumentActivationCancelObservations = function() { return cancelObservations.slice(); };
  window.getDocumentActivationFormObservations = function() { return formObservations.slice(); };
})();
</script></body></html>''';
