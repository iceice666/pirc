/*
 * Synchronous constraint validation for the standalone document runtime.
 * This file is inserted into the runtime IIFE, so it deliberately has no
 * imports, exports, or global side effects.
 */
function createDocumentFormValidation(deps) {
  const options = deps || {};
  const invalidEvent = options.Event || Event;
  const prototypes = options.prototypes || [];
  const customMessages = new WeakMap();
  const diagnosedUnsupportedTypes = new Set();
  const flagNames = [
    'badInput',
    'customError',
    'patternMismatch',
    'rangeOverflow',
    'rangeUnderflow',
    'stepMismatch',
    'tooLong',
    'tooShort',
    'typeMismatch',
    'valueMissing'
  ];
  const barredInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'image']);
  const readOnlyInputTypes = new Set([
    'text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date',
    'month', 'week', 'time', 'datetime-local'
  ]);
  const unsupportedInputTypes = new Set([
    'month', 'week', 'time', 'datetime-local'
  ]);
  const supportedTextInputTypes = new Set(['text', 'search', 'tel', 'password']);
  const lengthInputTypes = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
  const patternInputTypes = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);

  function hasAttribute(element, name) {
    return typeof element.hasAttribute === 'function' && element.hasAttribute(name);
  }

  function attribute(element, name) {
    if (typeof element.getAttribute !== 'function') return null;
    const value = element.getAttribute(name);
    return value == null ? null : String(value);
  }

  function tagOf(control) {
    return String(control && control.localName || '').toLowerCase();
  }

  function typeOf(control) {
    return String(control && (control.type || attribute(control, 'type')) || 'text').toLowerCase();
  }

  function kindOf(control) {
    const tag = tagOf(control);
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag !== 'input') return null;
    const type = typeOf(control);
    if (barredInputTypes.has(type)) return 'barred';
    if (type === 'checkbox' || type === 'radio' || type === 'email' ||
        type === 'url' || type === 'number' || type === 'range' ||
        type === 'date' || type === 'file' || type === 'color') return type;
    if (unsupportedInputTypes.has(type)) return 'unsupported';
    if (supportedTextInputTypes.has(type)) return 'text';
    // Invalid type values are normalized to text by HTML. Runtime input.type
    // should already expose that normalized value.
    return 'text';
  }

  function isDisabled(control) {
    if (typeof options.isDisabled === 'function') {
      try {
        return Boolean(options.isDisabled(control));
      } catch (error) {
        if (typeof options.diagnostic === 'function') {
          options.diagnostic('validation.disabled_check_failed', 'warning', String(error));
        }
      }
    }
    if (Boolean(control.disabled) || hasAttribute(control, 'disabled')) return true;
    let ancestor = control.parentElement;
    while (ancestor) {
      if (tagOf(ancestor) === 'fieldset' && hasAttribute(ancestor, 'disabled')) {
        let firstLegend = null;
        for (const child of Array.from(ancestor.children || [])) {
          if (tagOf(child) === 'legend') {
            firstLegend = child;
            break;
          }
        }
        let current = control;
        while (current && current !== firstLegend) current = current.parentElement;
        if (current !== firstLegend) return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  function isInDatalist(control) {
    let ancestor = control.parentElement;
    while (ancestor) {
      if (tagOf(ancestor) === 'datalist') return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  function isReadOnly(control, kind) {
    if (!Boolean(control.readOnly) && !hasAttribute(control, 'readonly')) return false;
    if (kind === 'textarea') return true;
    return kind === 'text' || (kind === 'input' && readOnlyInputTypes.has(typeOf(control))) ||
      readOnlyInputTypes.has(typeOf(control));
  }

  function willValidate(control, kind) {
    if (!kind || kind === 'barred' || isDisabled(control) || isInDatalist(control)) return false;
    if (isReadOnly(control, kind)) return false;
    return true;
  }

  function liveValue(control) {
    const values = options.liveValues;
    if (values && typeof values.has === 'function' && values.has(control)) {
      return String(values.get(control) == null ? '' : values.get(control));
    }
    return String(control.value == null ? '' : control.value);
  }

  function fileCount(control) {
    const files = options.fileSelections;
    let selected;
    if (files && typeof files.get === 'function' && files.has(control)) {
      selected = files.get(control);
    } else if (typeof files === 'function') {
      selected = files(control);
    } else {
      selected = control.files;
    }
    return selected && Number.isFinite(Number(selected.length))
      ? Number(selected.length)
      : 0;
  }

  function selectedOptions(select) {
    if (typeof options.selectedOptions === 'function') {
      return Array.from(options.selectedOptions(select) || []);
    }
    if (select.selectedOptions) return Array.from(select.selectedOptions);
    return Array.from(select.options || []).filter(option => Boolean(option.selected));
  }

  function radioGroupMembers(control) {
    if (typeof options.radioGroupMembers === 'function') {
      return Array.from(options.radioGroupMembers(control) || [control]);
    }
    return [control];
  }

  function blankFlags() {
    const flags = {};
    for (const name of flagNames) flags[name] = false;
    flags.valid = true;
    return flags;
  }

  function finish(flags, control, willCheck) {
    const invalid = flagNames.some(name => flags[name]);
    flags.valid = !invalid;
    const custom = customMessages.get(control) || '';
    const message = !invalid ? '' : custom || defaultMessage(flags);
    return {
      valid: !invalid,
      willValidate: willCheck,
      flags: Object.freeze(flags),
      message,
      supported: true
    };
  }

  function unsupportedResult(control, type, shouldValidate) {
    if (!diagnosedUnsupportedTypes.has(type)) {
      diagnosedUnsupportedTypes.add(type);
      if (typeof options.diagnostic === 'function') {
        options.diagnostic(
          'validation.input_type_unsupported',
          'warning',
          'Constraint validation is not implemented for input type "' + type + '".',
          { inputType: type, id: String(control.id || '') }
        );
      }
    }
    // Keep validity flags neutral and let checkElement/checkForm block the
    // operation with an explicit host message. These types must not inherit
    // text constraints while their native semantics are unmodeled.
    return {
      valid: true,
      willValidate: shouldValidate,
      flags: Object.freeze(blankFlags()),
      message: '',
      supported: false,
      unsupportedType: type
    };
  }

  function defaultMessage(flags) {
    if (flags.valueMissing) return 'Please fill out this field.';
    if (flags.typeMismatch) return 'Please enter a value of the correct type.';
    if (flags.patternMismatch) return 'Please match the requested format.';
    if (flags.tooShort) return 'Please lengthen this text.';
    if (flags.tooLong) return 'Please shorten this text.';
    if (flags.rangeUnderflow) return 'Value is below the allowed minimum.';
    if (flags.rangeOverflow) return 'Value is above the allowed maximum.';
    if (flags.stepMismatch) return 'Please enter a valid value.';
    if (flags.badInput) return 'Please enter a valid value.';
    return '';
  }

  function stateForUserInput(control) {
    const state = options.userInputState;
    return state && typeof state.get === 'function' ? state.get(control) || {} : {};
  }

  function parseDecimal(input) {
    if (input == null) return null;
    const text = String(input).trim();
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) return null;
    const exponent = Number(match[5] || 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 308) return null;
    const integer = match[2] || '0';
    const fraction = match[3] !== undefined ? match[3] : (match[4] || '');
    let coefficient = BigInt((integer + fraction).replace(/^0+(?=\d)/, '') || '0');
    if (match[1] === '-') coefficient = -coefficient;
    let scale = fraction.length - exponent;
    if (scale < 0) {
      coefficient *= 10n ** BigInt(-scale);
      scale = 0;
    }
    if (scale > 308) return null;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale--;
    }
    return { coefficient, scale };
  }

  function power10(scale) {
    return 10n ** BigInt(scale);
  }

  function compareDecimal(left, right) {
    const scale = Math.max(left.scale, right.scale);
    const a = left.coefficient * power10(scale - left.scale);
    const b = right.coefficient * power10(scale - right.scale);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function stepAligned(value, base, step) {
    const scale = Math.max(value.scale, base.scale, step.scale);
    const v = value.coefficient * power10(scale - value.scale);
    const b = base.coefficient * power10(scale - base.scale);
    const s = step.coefficient * power10(scale - step.scale);
    return s !== 0n && (v - b) % s === 0n;
  }

  function validStep(raw) {
    if (raw != null && String(raw).toLowerCase() === 'any') return null;
    const step = parseDecimal(raw == null ? '1' : raw);
    return step && step.coefficient > 0n ? step : { coefficient: 1n, scale: 0 };
  }

  function parseDate(value) {
    const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return null;
    const year = BigInt(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year <= 0n || month < 1 || month > 12 || day < 1) return null;
    const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
    const monthDays = month === 2 ? (leap ? 29 : 28) :
      ([4, 6, 9, 11].includes(month) ? 30 : 31);
    if (day > monthDays) return null;
    const adjusted = year - (month <= 2 ? 1n : 0n);
    const era = adjusted / 400n;
    const yearOfEra = adjusted - era * 400n;
    const monthPrime = BigInt(month + (month > 2 ? -3 : 9));
    const dayOfYear = (153n * monthPrime + 2n) / 5n + BigInt(day - 1);
    const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
    return era * 146097n + dayOfEra - 719468n;
  }

  function decimalFromDay(day) {
    return { coefficient: day, scale: 0 };
  }

  function emailValid(value, multiple) {
    const values = multiple ? value.split(',').map(part => part.trim()) : [value];
    if (!values.length) return false;
    const local = "A-Za-z0-9.!#$%&'*+/=?^_`{|}~-";
    const label = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
    const address = new RegExp('^[' + local + ']+@' + label + '(?:\\.' + label + ')*$');
    return values.every(part => address.test(part));
  }

  function urlValid(value) {
    if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      if (!parsed.protocol) return false;
      if (/^(https?|ftp|wss?):$/.test(parsed.protocol) && !parsed.hostname) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function optionValue(option) {
    if (option.value != null) return String(option.value);
    return String(option.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function selectValueMissing(control) {
    const selected = selectedOptions(control);
    if (!selected.length) return true;
    const multiple = Boolean(control.multiple || hasAttribute(control, 'multiple'));
    const sizeAttribute = attribute(control, 'size');
    const size = sizeAttribute == null || sizeAttribute === '' ? 1 : Number(sizeAttribute) || 1;
    const optionsInOrder = Array.from(control.options || []);
    const first = optionsInOrder[0];
    return !multiple && size === 1 && first != null && first.parentElement === control &&
      optionValue(first) === '' && selected.includes(first);
  }

  function numericFlags(control, kind, flags, value) {
    const current = parseDecimal(value);
    if (!current) return;
    const min = parseDecimal(attribute(control, 'min'));
    const max = parseDecimal(attribute(control, 'max'));
    if (min && compareDecimal(current, min) < 0) flags.rangeUnderflow = true;
    if (max && compareDecimal(current, max) > 0) flags.rangeOverflow = true;
    const stepRaw = attribute(control, 'step');
    const step = validStep(stepRaw);
    if (!step) return;
    const valueAttribute = parseDecimal(attribute(control, 'value'));
    const base = min || valueAttribute || { coefficient: 0n, scale: 0 };
    if (!stepAligned(current, base, step)) flags.stepMismatch = true;
  }

  function dateFlags(control, flags, value, willCheck) {
    const current = parseDate(value);
    if (willCheck && hasAttribute(control, 'required') && current == null) {
      flags.valueMissing = true;
    }
    if (willCheck && stateForUserInput(control).badInput) flags.badInput = true;
    const min = parseDate(attribute(control, 'min'));
    const max = parseDate(attribute(control, 'max'));
    if (current != null && min != null && current < min) flags.rangeUnderflow = true;
    if (current != null && max != null && current > max) flags.rangeOverflow = true;
    if (current == null) return;
    const step = validStep(attribute(control, 'step'));
    if (step) {
      const valueAttribute = parseDate(attribute(control, 'value'));
      const base = decimalFromDay(min != null ? min : valueAttribute != null ? valueAttribute : 0n);
      if (!stepAligned(decimalFromDay(current), base, step)) flags.stepMismatch = true;
    }
  }

  function validate(control) {
    const flags = blankFlags();
    const kind = kindOf(control);
    const shouldValidate = willValidate(control, kind);
    if (!kind || kind === 'barred') return finish(flags, control, false);
    if (kind === 'unsupported') return unsupportedResult(control, typeOf(control), shouldValidate);
    if (!shouldValidate && kind !== 'select' && kind !== 'date' && kind !== 'file') {
      return finish(flags, control, false);
    }

    const value = liveValue(control);
    const userState = stateForUserInput(control);
    if (shouldValidate && userState.badInput) flags.badInput = true;
    if (customMessages.get(control)) flags.customError = true;

    if (kind === 'checkbox' && hasAttribute(control, 'required') && !Boolean(control.checked)) {
      flags.valueMissing = true;
    } else if (kind === 'radio') {
      const group = radioGroupMembers(control);
      if (group.some(member => hasAttribute(member, 'required')) &&
          !group.some(member => Boolean(member.checked))) {
        flags.valueMissing = true;
      }
    } else if (kind === 'select' && hasAttribute(control, 'required')) {
      if (selectValueMissing(control)) flags.valueMissing = true;
    } else if (kind === 'file') {
      if (hasAttribute(control, 'required') && fileCount(control) === 0) flags.valueMissing = true;
    } else if (kind !== 'date' && kind !== 'range' && kind !== 'color' &&
        hasAttribute(control, 'required') && value === '') {
      flags.valueMissing = true;
    }

    if (kind === 'date') {
      dateFlags(control, flags, value, shouldValidate);
    } else if ((kind === 'email' || (kind === 'text' && typeOf(control) === 'email')) && value !== '') {
      if (!emailValid(value, Boolean(control.multiple || hasAttribute(control, 'multiple')))) {
        flags.typeMismatch = true;
      }
    } else if (kind === 'url' && value !== '' && !urlValid(value)) {
      flags.typeMismatch = true;
    }

    const inputType = typeOf(control);
    const patternSupported = (kind === 'text' && patternInputTypes.has(inputType)) ||
      kind === 'email' || kind === 'url';
    const pattern = attribute(control, 'pattern');
    if (shouldValidate && patternSupported && pattern != null && pattern !== '' && value !== '') {
      let expression;
      try {
        expression = new RegExp('^(?:' + pattern + ')$', 'v');
      } catch (_) {
        try {
          expression = new RegExp('^(?:' + pattern + ')$', 'u');
        } catch (_) {
          expression = null;
        }
      }
      if (expression && !expression.test(value)) flags.patternMismatch = true;
    }

    const supportsLength = kind === 'textarea' ||
      (kind === 'text' && lengthInputTypes.has(inputType));
    if (shouldValidate && supportsLength && value !== '' && userState.userEdited === true) {
      const minLength = Number(attribute(control, 'minlength'));
      const maxLength = Number(attribute(control, 'maxlength'));
      if (attribute(control, 'minlength') != null && Number.isInteger(minLength) &&
          minLength >= 0 && value.length < minLength) flags.tooShort = true;
      if (attribute(control, 'maxlength') != null && Number.isInteger(maxLength) &&
          maxLength >= 0 && value.length > maxLength) flags.tooLong = true;
    }

    if ((kind === 'number' || kind === 'range') && value !== '') {
      numericFlags(control, kind, flags, value);
    }
    if (kind === 'file' && customMessages.get(control)) flags.customError = true;
    return finish(flags, control, shouldValidate);
  }

  function dispatchInvalid(control) {
    if (typeof control.dispatchEvent !== 'function' || typeof invalidEvent !== 'function') return true;
    const event = new invalidEvent('invalid', { bubbles: false, cancelable: true });
    return control.dispatchEvent(event);
  }

  function checkElement(control, report) {
    const result = validate(control);
    if (!result.willValidate) return true;
    if (!result.supported) {
      if (report && typeof options.reportInvalid === 'function') {
        options.reportInvalid(control, 'This form control is not yet supported.');
      }
      return false;
    }
    if (result.valid) return true;
    const unhandled = dispatchInvalid(control);
    if (report && unhandled && typeof options.reportInvalid === 'function') {
      options.reportInvalid(control, result.message);
    }
    return false;
  }

  function ownerOf(control) {
    if (typeof options.formOwner === 'function') return options.formOwner(control);
    return control.form || null;
  }

  function controlsInForm(form) {
    const document = form && form.ownerDocument;
    if (document && typeof document.querySelectorAll === 'function') {
      return Array.from(document.querySelectorAll('input,select,textarea'))
        .filter(control => ownerOf(control) === form);
    }
    return Array.from(form && form.elements || []).filter(control => ownerOf(control) === form);
  }

  function checkForm(form, report) {
    let valid = true;
    let firstReport = null;
    for (const control of controlsInForm(form)) {
      const result = validate(control);
      if (!result.willValidate) continue;
      if (!result.supported) {
        valid = false;
        if (firstReport == null) {
          firstReport = { control, message: 'This form control is not yet supported.' };
        }
        continue;
      }
      if (result.valid) continue;
      valid = false;
      const unhandled = dispatchInvalid(control);
      if (unhandled && firstReport == null) {
        firstReport = { control, message: result.message };
      }
    }
    if (report && firstReport && typeof options.reportInvalid === 'function') {
      options.reportInvalid(firstReport.control, firstReport.message);
    }
    return valid;
  }

  function install() {
    for (const prototype of prototypes) {
      if (!prototype) continue;
      Object.defineProperties(prototype, {
        validity: {
          configurable: true,
          get() { return validate(this).flags; }
        },
        willValidate: {
          configurable: true,
          get() { return validate(this).willValidate; }
        },
        validationMessage: {
          configurable: true,
          get() { return validate(this).message; }
        },
        checkValidity: {
          configurable: true,
          writable: true,
          value() { return checkElement(this, false); }
        },
        reportValidity: {
          configurable: true,
          writable: true,
          value() { return checkElement(this, true); }
        },
        setCustomValidity: {
          configurable: true,
          writable: true,
          value(message) { customMessages.set(this, String(message == null ? '' : message)); }
        }
      });
    }
    return api;
  }

  const api = { validate, checkForm, checkElement, install };
  return api;
}
