import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext, runInContext} from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DOMParser, Event} from './vendor/linkedom-0.18.13/worker.js';

const sourcePath = fileURLToPath(new URL('./document_stylesheets_source.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');

function cachedSheet(element) {
  const symbol = Object.getOwnPropertySymbols(element).find(item => String(item) === 'Symbol(sheet)');
  return symbol ? element[symbol] : null;
}
function clearSheet(element) {
  const symbol = Object.getOwnPropertySymbols(element).find(item => String(item) === 'Symbol(sheet)');
  if (symbol) element[symbol] = null;
}
function harness(html, options = {}) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const context = createContext({URL, Event});
  runInContext(source + '\n;globalThis.__factory = createPircDocumentStylesheets;', context, {filename: sourcePath});
  let next = 0;
  const ids = new WeakMap();
  const diagnostics = [];
  const helper = context.__factory({
    document,
    URL,
    Event,
    getBaseURL: () => typeof options.baseURL === 'function' ? options.baseURL() : (options.baseURL || 'https://example.test/docs/page.html'),
    ensureElementId(element) {
      let id = ids.get(element);
      if (!id) {
        id = 'node-' + ++next;
        ids.set(element, id);
        element.setAttribute('data-pirc-script-id', id);
      }
      return id;
    },
    getCachedSheet: cachedSheet,
    clearCachedSheet: clearSheet,
    diagnostic: (...args) => diagnostics.push(args),
  });
  return {document, helper, diagnostics};
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('untouched modern CSS stays verbatim and is not parsed by the helper', () => {
  const css = '@layer reset { @supports (color: color(display-p3 1 0 0)) { .card { color: color(display-p3 1 0 0); } } }\n@container panel (width > 20rem) { .card { margin-inline: 1cqi; } }';
  const {document, helper} = harness('<head><style>' + css + '</style></head>');
  const style = document.querySelector('style');
  const first = helper.snapshot();
  assert.equal(first.sheets[0].cssText, css);
  assert.equal(cachedSheet(style), null);
  assert.equal(first.sheets[0].id, first.sheets[0].ownerId);
  assert.equal(helper.snapshot().sheets[0].id, first.sheets[0].id);
});

test('accessed inline CSSOM insert, delete, and declaration edits reach the snapshot with stable owner identity', () => {
  const {document, helper} = harness('<head><style id="theme">.card { color: red; }</style></head>');
  const style = document.querySelector('style');
  const initial = helper.snapshot();
  const identity = initial.sheets[0].id;
  assert.equal(initial.requests[0].notifyLoad, true);
  const sheet = style.sheet;
  assert.equal(style.sheet, sheet);
  sheet.insertRule('.title { margin-top: 2px; }', 1);
  sheet.cssRules[0].style.color = 'blue';
  let snapshot = helper.snapshot();
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].notifyLoad, false);
  assert.equal(snapshot.sheets[0].id, identity);
  assert.match(snapshot.sheets[0].cssText, /color: blue/);
  assert.match(snapshot.sheets[0].cssText, /margin-top: 2px/);
  sheet.deleteRule(1);
  snapshot = helper.snapshot();
  assert.equal(snapshot.requests[0].notifyLoad, false);
  assert.doesNotMatch(snapshot.sheets[0].cssText, /margin-top/);
});

test('reading inline CSSOM preserves raw CSS and its pending import request until rules change', () => {
  const css = '@import url(early.css);\n.card { color: red; }';
  const {document, helper} = harness('<head><style>' + css + '</style></head>');
  const style = document.querySelector('style');
  const first = helper.snapshot();
  const initialRequest = first.requests[0];
  assert.equal(first.pendingLoadCount, 1);

  const sheet = style.sheet;
  assert.equal(style.sheet, sheet);
  const readOnly = helper.snapshot();
  assert.equal(readOnly.requests.length, 0);
  assert.equal(readOnly.cancellations.length, 0);
  assert.equal(readOnly.pendingLoadCount, 1);
  assert.equal(readOnly.sheets[0].cssText, css);
  assert.equal(readOnly.sheets[0].transportId, initialRequest.id);
  assert.equal(readOnly.sheets[0].revision, initialRequest.revision);

  sheet.insertRule('.later { color: green; }', 2);
  const inserted = helper.snapshot();
  assert.equal(inserted.requests.length, 1);
  assert.equal(inserted.cancellations.length, 1);
  assert.equal(inserted.requests[0].notifyLoad, false);
  assert.match(inserted.sheets[0].cssText, /\.later/);
  assert.equal(helper.complete({id: inserted.requests[0].id, ok: true}), true);

  sheet.cssRules[2].style.setProperty('color', 'blue');
  const declarationChanged = helper.snapshot();
  assert.equal(declarationChanged.requests.length, 1);
  assert.equal(declarationChanged.requests[0].notifyLoad, false);
  assert.match(declarationChanged.sheets[0].cssText, /color: blue/);
});

test('rereading the same sheet after a CSSOM edit does not reset its pristine baseline', () => {
  const {document, helper} = harness('<head><style>.card { color: red; }</style></head>');
  const style = document.querySelector('style');
  const first = helper.snapshot();
  const sheet = style.sheet;

  sheet.cssRules[0].style.setProperty('color', 'blue');
  assert.equal(style.sheet, sheet);
  const changed = helper.snapshot();
  assert.equal(changed.requests.length, 1);
  assert.equal(changed.requests[0].notifyLoad, false);
  assert.match(changed.sheets[0].cssText, /color: blue/);
  assert.equal(changed.sheets[0].revision, first.sheets[0].revision + 1);
});

test('textContent replacement and empty sheets use current source and replace CSSStyleSheet identity', () => {
  const {document, helper} = harness('<style>.old { color: red; }</style>');
  const style = document.querySelector('style');
  const original = helper.snapshot().sheets[0].id;
  const sheetReference = style.sheet;
  style.textContent = '.new { color: teal; }';
  assert.notEqual(style.sheet, sheetReference);
  let snapshot = helper.snapshot();
  assert.equal(snapshot.sheets[0].id, original);
  assert.equal(snapshot.sheets[0].cssText, '.new { color: teal; }');
  assert.equal(cachedSheet(style), style.sheet);
  style.textContent = '';
  snapshot = helper.snapshot();
  assert.equal(snapshot.sheets[0].cssText, '');
  assert.equal(snapshot.sheets[0].id, original);
  assert.notEqual(style.sheet, sheetReference);
});

test('child text edits invalidate LinkeDOM cached rules without changing rendered DOM text', () => {
  const {document, helper} = harness('<style>.old { color: red; }</style>');
  const style = document.querySelector('style');
  void style.sheet;
  helper.snapshot();
  style.firstChild.data = '.changed { color: purple; }';
  const snapshot = helper.snapshot();
  assert.equal(snapshot.sheets[0].cssText, '.changed { color: purple; }');
  assert.equal(cachedSheet(style), null);
  assert.equal(style.textContent, '.changed { color: purple; }');
});

test('textContent replacement followed by same-turn CSSOM edits preserves the new cached sheet', () => {
  const {document, helper} = harness('<style>.old { color: red; }</style>');
  const style = document.querySelector('style');
  const oldSheet = style.sheet;
  helper.snapshot();

  style.textContent = '.new { color: teal; }';
  const newSheet = style.sheet;
  assert.notEqual(newSheet, oldSheet);
  newSheet.insertRule('.added { color: purple; }', 1);

  const snapshot = helper.snapshot();
  assert.match(snapshot.sheets[0].cssText, /\.new/);
  assert.match(snapshot.sheets[0].cssText, /\.added/);
  assert.equal(cachedSheet(style), newSheet);
});

test('inline sheets and links preserve shared document order and current style metadata', () => {
  const {document, helper} = harness('<head><style media="screen" title="inline">a{color:red}</style><link rel="stylesheet" href="theme.css" media="print" disabled crossorigin="anonymous" integrity="sha256-x" referrerpolicy="no-referrer" title="theme"><style disabled>.b{color:blue}</style></head>');
  const first = helper.snapshot();
  assert.deepEqual(Array.from(first.sheets, item => item.order), [0, 2]);
  assert.deepEqual(Array.from(first.links, item => item.order), [1]);
  const link = first.links[0];
  assert.equal(link.id, link.ownerId);
  assert.equal(link.href, 'https://example.test/docs/theme.css');
  assert.equal(link.hrefAttribute, 'theme.css');
  assert.equal(link.baseURL, 'https://example.test/docs/page.html');
  assert.equal(link.crossorigin, 'anonymous');
  assert.equal(link.integrity, 'sha256-x');
  assert.equal(link.referrerpolicy, 'no-referrer');
  assert.equal(link.disabled, true);
  assert.equal(first.sheets[0].media, 'screen');
  assert.equal(first.sheets[1].disabled, true);
  assert.equal(first.requests.filter(item => item.ownerType === 'link').length, 0);
  assert.equal(first.pendingLoadCount, 2);
  assert.deepEqual(Array.from(first.requests, item => item.id), ['stylesheet-1', 'stylesheet-2']);
  assert.equal(first.requests[0].transportId, first.sheets[0].transportId);

  const element = document.querySelector('link');
  element.media = 'screen';
  element.removeAttribute('disabled');
  const changed = helper.snapshot();
  assert.equal(changed.requests.length, 1);
  assert.equal(changed.requests[0].notifyLoad, true);
  assert.equal(changed.links[0].revision, link.revision + 1);
  assert.equal(changed.links[0].media, 'screen');
  assert.equal(changed.links[0].disabled, false);
});

test('stylesheet links emit load/error only for the current request revision', () => {
  const {document, helper} = harness('<head><link rel="stylesheet" href="first.css"></head>');
  const link = document.querySelector('link');
  const dispatched = [];
  link.addEventListener('load', () => dispatched.push('load'));
  link.addEventListener('error', () => dispatched.push('error'));
  const first = helper.snapshot();
  assert.equal(first.requests.length, 1);
  const original = first.requests[0];
  assert.match(original.id, /^stylesheet-\d+$/);
  assert.equal(original.id, original.transportId);

  link.href = 'second.css';
  const second = helper.snapshot();
  assert.equal(second.requests.length, 1);
  assert.equal(second.cancellations.length, 1);
  assert.equal(second.cancellations[0].id, original.id);
  assert.equal(second.cancellations[0].transportId, original.id);
  assert.equal(second.cancellations[0].requestId, original.requestId);
  assert.equal(second.requests[0].revision, original.revision + 1);
  assert.equal(helper.complete({id: original.id, revision: original.revision, ok: true}), false);
  assert.equal(helper.complete({id: original.id, ok: true}), false);
  assert.deepEqual(dispatched, []);
  assert.equal(helper.complete({id: second.requests[0].id, ok: true}), true);
  assert.deepEqual(dispatched, ['load']);
  assert.equal(helper.complete({id: second.requests[0].id, revision: second.requests[0].revision, ok: false}), false);

  link.media = 'print';
  const mediaOnly = helper.snapshot();
  assert.equal(mediaOnly.requests.length, 0);
  assert.equal(mediaOnly.links[0].revision, second.links[0].revision);

  link.crossOrigin = 'use-credentials';
  link.integrity = 'sha384-next';
  link.referrerPolicy = 'same-origin';
  const third = helper.snapshot();
  assert.equal(third.requests.length, 1);
  assert.equal(third.requests[0].crossorigin, 'use-credentials');
  assert.equal(third.requests[0].integrity, 'sha384-next');
  assert.equal(third.requests[0].referrerpolicy, 'same-origin');
  assert.equal(helper.complete({id: third.requests[0].ownerId, revision: third.requests[0].revision, ok: false, error: 'offline'}), true);
  assert.deepEqual(dispatched, ['load', 'error']);
});

test('removing or changing rel cancels pending loads and stale completions stay silent', () => {
  const {document, helper} = harness('<head><link rel="stylesheet" href="theme.css"></head>');
  const link = document.querySelector('link');
  let events = 0;
  link.addEventListener('load', () => events++);
  const first = helper.snapshot().requests[0];
  link.rel = 'icon';
  const changed = helper.snapshot();
  assert.equal(changed.requests.length, 0);
  assert.equal(changed.cancellations.length, 1);
  assert.equal(changed.cancellations[0].reason, 'link-no-longer-loadable');
  assert.equal(changed.pendingLoadCount, 0);
  assert.equal(helper.complete({id: first.id, revision: first.revision, ok: true}), false);
  assert.equal(events, 0);

  link.rel = 'stylesheet';
  const restarted = helper.snapshot().requests[0];
  link.remove();
  const removed = helper.snapshot();
  assert.equal(removed.cancellations.length, 1);
  assert.equal(removed.cancellations[0].reason, 'removed');
  assert.equal(helper.complete({id: restarted.id, revision: restarted.revision, ok: true}), false);
});


test('inline styles join the load barrier and CSSOM changes do not emit another load/error event', () => {
  const {document, helper} = harness('<head><style>@import url(early.css); .card{color:red}</style></head>');
  const style = document.querySelector('style');
  const events = [];
  style.addEventListener('load', () => events.push('load'));
  style.addEventListener('error', () => events.push('error'));
  const first = helper.snapshot();
  assert.equal(first.sheets.length, 1);
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].kind, 'stylesheet');
  assert.equal(first.requests[0].ownerType, 'style');
  assert.equal(first.requests[0].cssText, undefined);
  assert.equal(first.requests[0].id, first.sheets[0].transportId);
  assert.equal(first.requests[0].ownerId, first.sheets[0].ownerId);
  assert.equal(first.pendingLoadCount, 1);
  assert.equal(helper.complete({id: first.requests[0].id, revision: first.requests[0].revision, ok: true}), true);
  assert.deepEqual(events, ['load']);

  style.sheet.insertRule('.new { color: blue; }', 2);
  const changed = helper.snapshot();
  assert.equal(changed.requests.length, 1);
  assert.equal(changed.requests[0].notifyLoad, false);
  assert.equal(changed.requests[0].revision, first.requests[0].revision + 1);
  assert.match(changed.sheets[0].cssText, /\.new/);
  assert.equal(changed.pendingLoadCount, 1);
  assert.equal(helper.complete({id: first.requests[0].id, revision: first.requests[0].revision, ok: false}), false);
  assert.deepEqual(events, ['load']);
  assert.equal(helper.complete({id: changed.requests[0].id, revision: changed.requests[0].revision, ok: false}), true);
  assert.deepEqual(events, ['load']);
});

test('inline media and disabled changes update descriptors without restarting the load', () => {
  const {document, helper} = harness('<style media="screen">@import "theme.css";</style>');
  const style = document.querySelector('style');
  const first = helper.snapshot();
  style.media = 'print';
  style.setAttribute('disabled', '');
  const second = helper.snapshot();
  assert.equal(second.requests.length, 0);
  assert.equal(second.sheets[0].revision, first.sheets[0].revision);
  assert.equal(second.sheets[0].media, 'print');
  assert.equal(second.sheets[0].disabled, true);
});

test('CSSStyleSheet.disabled changes inline snapshot disabled state without restarting the request', () => {
  const {document, helper} = harness('<style>.sheet-state { color: green; }</style>');
  const style = document.querySelector('style');
  const sheet = style.sheet;
  const first = helper.snapshot();
  assert.equal(first.sheets[0].disabled, false);

  sheet.disabled = true;
  const disabled = helper.snapshot();
  assert.equal(disabled.sheets[0].disabled, true);
  assert.equal(disabled.requests.length, 0);
  assert.equal(disabled.sheets[0].revision, first.sheets[0].revision);

  sheet.disabled = false;
  const enabled = helper.snapshot();
  assert.equal(enabled.sheets[0].disabled, false);
  assert.equal(enabled.requests.length, 0);
  assert.equal(enabled.sheets[0].revision, first.sheets[0].revision);
});

test('changing base href updates link.href without refetching its frozen selected resource', () => {
  let activeBase = 'https://example.test/first/page.html';
  const {document, helper} = harness('<link rel="stylesheet" href="theme.css">', {baseURL: () => activeBase});
  const first = helper.snapshot();
  const link = document.querySelector('link');
  assert.equal(first.requests[0].href, 'https://example.test/first/theme.css');
  activeBase = 'https://example.test/second/page.html';
  const second = helper.snapshot();
  assert.equal(second.links[0].href, 'https://example.test/second/theme.css');
  assert.equal(second.links[0].fetchHref, 'https://example.test/first/theme.css');
  assert.equal(second.requests.length, 0);
  assert.equal(second.links[0].revision, first.links[0].revision);
  assert.equal(helper.complete({id: first.links[0].id, revision: first.links[0].revision, ok: true}), true);
  assert.equal(link.href, 'theme.css');
});

test('disabled links do not fetch, cancel pending work, and refetch when enabled again', () => {
  const {document, helper} = harness('<head><link rel="stylesheet" href="theme.css" disabled></head>');
  const link = document.querySelector('link');
  const initial = helper.snapshot();
  assert.equal(initial.requests.length, 0);
  assert.equal(initial.pendingLoadCount, 0);
  assert.equal(initial.links[0].disabled, true);

  link.removeAttribute('disabled');
  const enabled = helper.snapshot();
  assert.equal(enabled.requests.length, 1);
  const firstRequest = enabled.requests[0];
  link.setAttribute('disabled', '');
  const disabledWhilePending = helper.snapshot();
  assert.equal(disabledWhilePending.requests.length, 0);
  assert.equal(disabledWhilePending.cancellations.length, 1);
  assert.equal(disabledWhilePending.cancellations[0].requestId, firstRequest.requestId);
  assert.equal(helper.complete({id: firstRequest.id, revision: firstRequest.revision, ok: true}), false);

  link.removeAttribute('disabled');
  const reenabledPending = helper.snapshot();
  assert.equal(reenabledPending.requests.length, 1);
  assert.equal(reenabledPending.requests[0].revision, firstRequest.revision + 2);
  assert.equal(helper.complete({id: reenabledPending.requests[0].id, revision: reenabledPending.requests[0].revision, ok: true}), true);

  link.setAttribute('disabled', '');
  helper.snapshot();
  link.removeAttribute('disabled');
  const reenabledLoaded = helper.snapshot();
  assert.equal(reenabledLoaded.requests.length, 1);
  assert.equal(reenabledLoaded.requests[0].revision, reenabledPending.requests[0].revision + 2);
});

test('alternate stylesheet links are withheld until the alternate rel token is removed', () => {
  const {document, helper} = harness('<head><link rel="alternate stylesheet" href="alternate.css" title="contrast"></head>');
  const link = document.querySelector('link');
  const initial = helper.snapshot();
  assert.equal(initial.links[0].isStylesheet, true);
  assert.equal(initial.links[0].alternate, true);
  assert.equal(initial.links[0].requestable, false);
  assert.equal(initial.requests.length, 0);
  assert.equal(initial.pendingLoadCount, 0);

  link.rel = 'stylesheet';
  const selected = helper.snapshot();
  assert.equal(selected.links[0].alternate, false);
  assert.equal(selected.links[0].requestable, true);
  assert.equal(selected.requests.length, 1);
});
