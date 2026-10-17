import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = fileURLToPath(
  new URL('./document_images_source.js', import.meta.url),
);
const source = readFileSync(sourcePath, 'utf8');

class FakeEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.target = null;
    this.currentTarget = null;
  }
}

class FakeDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

class FakeElement {
  constructor(ownerDocument, name) {
    this.ownerDocument = ownerDocument;
    this.localName = name;
    this.nodeType = 1;
    this.tagName = name.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.isConnected = false;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  toggleAttribute(name, force) {
    const key = String(name).toLowerCase();
    const next = arguments.length < 2 ? !this.attributes.has(key) : Boolean(force);
    if (next) this.setAttribute(key, '');
    else this.removeAttribute(key);
    return next;
  }

  addEventListener(type, listener) {
    const key = String(type);
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = [];
      this.listeners.set(key, listeners);
    }
    if (!listeners.includes(listener)) listeners.push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(String(type));
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    for (const listener of (this.listeners.get(event.type) || []).slice()) {
      listener.call(this, event);
    }
    return true;
  }
}

class FakeHTMLImageElement extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'img');
  }

  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get width() { return Number(this.getAttribute('width') || 0); }
  set width(value) { this.setAttribute('width', value); }
  get height() { return Number(this.getAttribute('height') || 0); }
  set height(value) { this.setAttribute('height', value); }
}

class FakeDocument {
  constructor() {
    this.images = [];
    this.defaultView = { Event: FakeEvent, DOMException: FakeDOMException };
  }

  createElement(name) {
    if (String(name).toLowerCase() !== 'img')
      throw new TypeError('This fixture only creates images.');
    const image = new FakeHTMLImageElement(this);
    this.images.push(image);
    return image;
  }

  addConnectedImage(attributes = {}) {
    const image = this.createElement('img');
    for (const [name, value] of Object.entries(attributes))
      image.setAttribute(name, value);
    image.isConnected = true;
    return image;
  }

  querySelectorAll(selector) {
    return selector === 'img'
      ? this.images.filter((image) => image.isConnected)
      : [];
  }
}

function createManager(existingDocument = null, overrides = {}) {
  const context = vm.createContext({});
  new vm.Script(source + '\nthis.__createDocumentImages = createDocumentImages;')
    .runInContext(context);
  const document = existingDocument || new FakeDocument();
  const requests = [];
  const diagnostics = [];
  const images = context.__createDocumentImages({
    document,
    HTMLElement: FakeElement,
    HTMLImageElement: FakeHTMLImageElement,
    Event: FakeEvent,
    URL,
    baseUrl: () => 'https://example.test/assets/page.html',
    enqueue(request) { requests.push(request); },
    diagnostic(...args) { diagnostics.push(args); },
    ...overrides,
  });
  images.install();
  return { document, images, requests, diagnostics };
}

function completion(request, values = {}) {
  return {
    id: request.id,
    ok: true,
    imageId: 'native-image-' + request.id,
    width: 24,
    height: 12,
    originClean: true,
    ...values,
  };
}

test('Image creates real document images and host completion updates metadata and Canvas source', async () => {
  const eventPropertySets = [];
  const { document, images, requests } = createManager(null, {
    onEventPropertySet(image, type) { eventPropertySets.push([image, type]); },
  });
  const image = new images.Image(10, 8);
  assert.ok(image instanceof FakeHTMLImageElement);
  assert.ok(image instanceof images.Image);
  assert.equal(image.ownerDocument, document);
  assert.equal(image.width, 10);
  assert.equal(image.height, 8);
  assert.equal(image.complete, true);
  assert.equal(image.naturalWidth, 0);
  await assert.rejects(image.decode(), { name: 'EncodingError' });
  assert.throws(() => images.Image(), { name: 'TypeError' });

  const oneDimension = new images.Image(20);
  assert.equal(oneDimension.width, 20);
  assert.equal(oneDimension.height, 0);
  assert.equal(oneDimension.getAttribute('width'), '20');
  assert.equal(oneDimension.getAttribute('height'), null);
  const noDimensions = new images.Image();
  assert.equal(noDimensions.width, 0);
  assert.equal(noDimensions.height, 0);
  assert.equal(noDimensions.getAttribute('width'), null);
  assert.equal(noDimensions.getAttribute('height'), null);

  const events = [];
  image.onload = (event) => events.push({ type: event.type, target: event.target });
  image.crossOrigin = 'use-credentials';
  image.referrerPolicy = 'origin';
  image.src = '../portrait.png';
  assert.equal(image.src, 'https://example.test/portrait.png');
  assert.equal(image.complete, false);
  assert.equal(image.naturalHeight, 0);
  assert.equal(images.canvasSource(image), null);

  const request = requests[0];
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    kind: 'image',
    id: request.id,
    url: 'https://example.test/portrait.png',
    crossOrigin: 'use-credentials',
    referrerPolicy: 'origin',
    version: request.version,
  });
  const decode = image.decode();
  assert.equal(images.complete(completion(request, {
    imageId: 'host-owned-image-1', width: 48, height: 30, originClean: false,
  })), true);
  assert.equal(events.length, 0);
  await decode;
  await Promise.resolve();

  assert.equal(image.complete, true);
  assert.equal(image.naturalWidth, 48);
  assert.equal(image.naturalHeight, 30);
  assert.equal(image.currentSrc, 'https://example.test/portrait.png');
  assert.deepEqual(JSON.parse(JSON.stringify(images.canvasSource(image))), {
    imageId: 'host-owned-image-1', width: 48, height: 30, originClean: false,
  });
  assert.deepEqual(Array.from(images.retainedImageIds()), ['host-owned-image-1']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'load');
  assert.equal(events[0].target, image);
  image.onload = null;
  assert.deepEqual(eventPropertySets.map(([, type]) => type), ['load', 'load']);
});

test('replacement cancels stale decode results and broken images reject Canvas draws asynchronously', async () => {
  const { images, requests } = createManager();
  const image = new images.Image();
  const events = [];
  image.onload = () => events.push('load');
  image.onerror = (event) => events.push(event.type);

  image.src = 'first.png';
  const firstRequest = requests[0];
  const firstDecode = image.decode().then(
    () => 'resolved',
    (error) => error.name,
  );
  image.src = 'second.png';
  const secondRequest = requests[1];
  assert.equal(firstRequest.cancelled, true);
  assert.equal(await firstDecode, 'EncodingError');
  assert.equal(images.complete(completion(firstRequest)), false);
  assert.equal(images.complete(completion(secondRequest, {
    imageId: 'host-owned-image-2', width: 9, height: 7,
  })), true);
  await Promise.resolve();
  assert.deepEqual(events, ['load']);

  image.setAttribute('src', 'javascript:alert(1)');
  assert.equal(requests.length, 2);
  assert.equal(image.complete, true);
  assert.throws(() => images.canvasSource(image), { name: 'InvalidStateError' });
  assert.deepEqual(events, ['load']);
  await Promise.resolve();
  assert.deepEqual(events, ['load', 'error']);
  await assert.rejects(image.decode(), { name: 'EncodingError' });
  assert.throws(() => images.canvasSource({ localName: 'canvas' }), { name: 'TypeError' });
  assert.throws(() => images.canvasSource({
    ownerDocument: image.ownerDocument, nodeType: 1, localName: 'img',
  }), { name: 'TypeError' });
});

test('replacement briefly keeps old metadata, draws nothing while pending, then reports failure URL', async () => {
  const { images, requests } = createManager();
  const image = new images.Image();
  image.src = 'original.png';
  const original = requests[0];
  assert.equal(images.complete(completion(original, {
    imageId: 'native-original', width: 32, height: 18,
  })), true);
  assert.equal(image.currentSrc, 'https://example.test/assets/original.png');
  assert.equal(image.naturalWidth, 32);
  assert.equal(image.naturalHeight, 18);

  image.src = 'replacement.png';
  assert.equal(requests.length, 2);
  assert.equal(image.complete, false);
  assert.equal(image.currentSrc, 'https://example.test/assets/original.png');
  assert.equal(image.naturalWidth, 32);
  assert.equal(image.naturalHeight, 18);
  assert.equal(images.canvasSource(image), null);

  await Promise.resolve();
  assert.equal(image.complete, false);
  assert.equal(image.currentSrc, '');
  assert.equal(image.naturalWidth, 0);
  assert.equal(image.naturalHeight, 0);

  assert.equal(images.complete({
    id: requests[1].id,
    ok: false,
    error: 'network error',
  }), true);
  assert.equal(image.complete, true);
  assert.equal(image.currentSrc, 'https://example.test/assets/replacement.png');
  assert.equal(image.naturalWidth, 0);
  assert.equal(image.naturalHeight, 0);
  assert.throws(() => images.canvasSource(image), { name: 'InvalidStateError' });
});

test('width and height use decoded intrinsic dimensions until explicit attributes are set', () => {
  const { images, requests } = createManager();
  const image = new images.Image();
  image.src = 'intrinsic.png';
  assert.equal(images.complete(completion(requests[0], {
    imageId: 'intrinsic-image', width: 24, height: 12,
  })), true);

  assert.equal(image.getAttribute('width'), null);
  assert.equal(image.getAttribute('height'), null);
  assert.equal(image.width, 24);
  assert.equal(image.height, 12);

  image.width = 18;
  image.height = 9;
  assert.equal(image.getAttribute('width'), '18');
  assert.equal(image.getAttribute('height'), '9');
  assert.equal(image.width, 18);
  assert.equal(image.height, 9);

  image.removeAttribute('width');
  image.removeAttribute('height');
  assert.equal(image.width, 24);
  assert.equal(image.height, 12);
});

test('prepareTree ignores ordinary src and srcset markup but observes event-bearing images', async () => {
  const document = new FakeDocument();
  document.addConnectedImage({ src: 'ordinary.png', srcset: 'large.png 2x' });
  document.addConnectedImage({ src: 'lazy.png', loading: 'lazy' });
  const parsed = document.addConnectedImage({
    src: 'thumbnail.png',
    crossorigin: '',
    referrerpolicy: 'strict-origin',
    onload: 'window.loaded = true',
  });
  const { images, requests } = createManager(document);
  images.prepareTree(document);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.test/assets/thumbnail.png');
  assert.equal(requests[0].crossOrigin, 'anonymous');
  assert.equal(requests[0].referrerPolicy, 'strict-origin');
  assert.equal(parsed.complete, false);

  const listenerDocument = new FakeDocument();
  const listenerImage = listenerDocument.addConnectedImage({ src: 'listener.png' });
  const listenerManager = createManager(listenerDocument);
  let loads = 0;
  listenerImage.addEventListener('load', () => loads++);
  assert.equal(listenerManager.requests.length, 1);
  assert.equal(listenerManager.requests[0].url,
    'https://example.test/assets/listener.png');
  listenerManager.images.complete(completion(listenerManager.requests[0]));
  await Promise.resolve();
  assert.equal(loads, 1);
});

test('request limits stay bounded', () => {
  const manager = createManager();
  const pendingImages = [];
  for (let index = 0; index < 65; index++) {
    const image = new manager.images.Image();
    image.src = 'pending-' + index + '.png';
    pendingImages.push(image);
  }
  assert.equal(manager.requests.length, 64);
  assert.equal(pendingImages[63].complete, false);
  assert.equal(pendingImages[64].complete, true);
  assert.ok(manager.diagnostics.some(([code]) => code === 'image.pending_limit'));

  const lifetime = createManager();
  const image = new lifetime.images.Image();
  for (let index = 0; index < 256; index++) {
    image.src = 'request-' + index + '.png';
    const request = lifetime.requests[index];
    assert.equal(lifetime.images.complete({ id: request.id, ok: false, error: 'decode failed' }), true);
  }
  image.src = 'over-limit.png';
  assert.equal(lifetime.requests.length, 256);
  assert.equal(image.complete, true);
  assert.ok(lifetime.diagnostics.some(([code]) => code === 'image.request_limit'));
});

test('clone-time attribute copies do not enqueue until the real tree is prepared', () => {
  let cloningSnapshot = true;
  const { document, images, requests } = createManager(null, {
    suppressMutations: () => cloningSnapshot,
  });
  const clone = document.createElement('img');
  clone.setAttribute('src', 'clone-copy.png');
  assert.equal(requests.length, 0);

  cloningSnapshot = false;
  images.prepareTree(clone);
  assert.equal(requests.length, 0);
  clone.onload = () => {};
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.test/assets/clone-copy.png');
});


test('nullable crossOrigin removes the attribute and returns to no-CORS mode', () => {
 const {images,requests}=createManager();const image=new images.Image();
 image.crossOrigin='anonymous';image.src='photo.png';
 assert.equal(requests.at(-1).crossOrigin,'anonymous');
 const previous=requests.at(-1);image.crossOrigin=null;
 assert.equal(image.crossOrigin,null);assert.equal(image.hasAttribute('crossorigin'),false);
 assert.equal(requests.at(-1).crossOrigin,null);assert.equal(previous.cancelled,true);
 image.crossOrigin='use-credentials';image.crossOrigin=undefined;
 assert.equal(image.crossOrigin,null);assert.equal(requests.at(-1).crossOrigin,null);
});
