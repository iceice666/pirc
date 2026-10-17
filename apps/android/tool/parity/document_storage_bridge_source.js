/* Chunk transport keeps full Web Storage values outside ordinary 4 MiB DOM messages. */
function createPircDocumentStorageBridge(options) {
  'use strict';
  const stringify = JSON.stringify.bind(JSON), integer = Number.isSafeInteger;
  const apply = Reflect.apply, pushMethod = Array.prototype.push,
    includesMethod = Array.prototype.includes, sliceMethod = String.prototype.slice;
  const has = (array, value) => apply(includesMethod, array, [value]);
  const push = (array, value) => apply(pushMethod, array, [value]);
  const slice = (text, start, end) => apply(sliceMethod, text, [start, end]);
  const keys = ['key', 'value', 'url'];
  const chunkLimit = 65536;
  let transfer = null, entry = null, initial = null, event = null, outgoing = [];
  const ok = () => '{"ok":true}';
  function size(value, maximum) {
    if (!integer(value) || value < 0 || value > maximum) throw new RangeError('Invalid Storage transfer size.');
    return value;
  }
  function current() { return options.getStorage(); }
  function syncBegin(meta) {
    if (!meta || !integer(meta.generation) || !integer(meta.revision)) throw new TypeError('Invalid Storage state metadata.');
    const quota = size(meta.quotaCodeUnits == null ? meta.quotaBytes / 2 : meta.quotaCodeUnits, 5 * 1024 * 1024);
    if (current() && current().hasWrites()) throw new Error('Storage writes must be flushed before refreshing.');
    transfer = { ...meta, quotaCodeUnits: quota, local: [], session: [] };
    transfer._units = {local: 0, session: 0};
    entry = null;
    return ok();
  }
  function entryBegin(input) {
    if (!transfer || entry || !has(['local', 'session'], input.area)) throw new Error('Invalid Storage entry transfer.');
    const keyLength = size(input.keyLength, transfer.quotaCodeUnits);
    const valueLength = size(input.valueLength, transfer.quotaCodeUnits);
    if (transfer._units[input.area] + keyLength + valueLength > transfer.quotaCodeUnits) throw new RangeError('Storage area exceeds its quota.');
    if (transfer[input.area].length >= (transfer.quotaEntries || 50000)) throw new RangeError('Too many Storage entries.');
    entry = {area: input.area, key: '', value: '', keyLength, valueLength};
    return ok();
  }
  function entryPart(input) {
    if (!entry || !has(['key', 'value'], input.part) || typeof input.text !== 'string' || input.text.length > chunkLimit) throw new Error('Invalid Storage entry chunk.');
    if (entry[input.part].length + input.text.length > entry[input.part + 'Length']) throw new RangeError('Storage entry chunk exceeds its declared size.');
    entry[input.part] += input.text;
    return ok();
  }
  function entryEnd() {
    if (!entry || entry.key.length !== entry.keyLength || entry.value.length !== entry.valueLength) throw new Error('Incomplete Storage entry.');
    push(transfer[entry.area], [entry.key, entry.value]);
    transfer._units[entry.area] += entry.keyLength + entry.valueLength;
    entry = null;
    return ok();
  }
  function syncFinish() {
    if (!transfer || entry) throw new Error('Incomplete Storage state.');
    const state = transfer;
    transfer = null;
    delete state._units;
    if (current()) current().sync(state);
    else initial = state;
    return ok();
  }
  function writesBegin() {
    if (outgoing.length) throw new Error('Previous Storage writes were not acknowledged.');
    outgoing = current() ? current().takeWrites() : [];
    return stringify({count: outgoing.length});
  }
  function writeInfo(input) {
    const index = size(input.index, outgoing.length - 1), operation = outgoing[index];
    if (!operation) throw new RangeError('Unknown Storage operation.');
    const info = {area: operation.area, type: operation.type, generation: operation.generation};
    for (const part of keys) info[part + 'Length'] = operation[part] == null ? null : operation[part].length;
    return stringify(info);
  }
  function writePart(input) {
    const index = size(input.index, outgoing.length - 1), operation = outgoing[index];
    if (!operation || !has(keys, input.part) || typeof operation[input.part] !== 'string') throw new Error('Invalid Storage operation chunk.');
    const offset = size(input.offset, operation[input.part].length);
    return stringify({text: slice(operation[input.part], offset, offset + chunkLimit)});
  }
  function writesEnd() { outgoing = []; return ok(); }
  function eventBegin(meta) {
    if (!meta || !has(['local', 'session'], meta.area)) throw new Error('Invalid Storage event.');
    event = {...meta};
    for (const part of ['key', 'oldValue', 'newValue', 'url']) {
      const length = meta[part + 'Length'];
      if (length !== null) size(length, 5 * 1024 * 1024);
      event[part] = length === null ? null : '';
    }
    return ok();
  }
  function eventPart(input) {
    if (!event || !has(['key', 'oldValue', 'newValue', 'url'], input.part) ||
        event[input.part] == null || typeof input.text !== 'string' || input.text.length > chunkLimit) throw new Error('Invalid Storage event chunk.');
    if (event[input.part].length + input.text.length > event[input.part + 'Length']) throw new RangeError('Storage event exceeds declared size.');
    event[input.part] += input.text;
    return ok();
  }
  function eventFinish() {
    if (!event || !current()) throw new Error('Storage event document is unavailable.');
    const payload = event;
    for (const part of ['key', 'oldValue', 'newValue', 'url']) {
      if (payload[part] != null && payload[part].length !== payload[part + 'Length']) throw new Error('Incomplete Storage event.');
      delete payload[part + 'Length'];
    }
    event = null;
    current().dispatchEvent(payload);
    return options.response();
  }
  return Object.freeze({syncBegin, entryBegin, entryPart, entryEnd, syncFinish,
    writesBegin, writeInfo, writePart, writesEnd, eventBegin, eventPart, eventFinish,
    takeInitialState() { const state = initial; initial = null; return state; }});
}
