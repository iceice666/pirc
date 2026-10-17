import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = fileURLToPath(
  new URL('./document_canvas_source.js', import.meta.url),
);
const source = readFileSync(sourcePath, 'utf8');

class FakeCanvas {
  constructor(document, connected, attributes = {}) {
    this.ownerDocument = document;
    this.isConnected = connected;
    this.attributes = new Map(
      Object.entries(attributes).map(([name, value]) => [name.toLowerCase(), String(value)]),
    );
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
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
}

class FakeDocument {
  constructor() {
    this.canvases = [];
  }

  createElement(name) {
    assert.equal(String(name).toLowerCase(), 'canvas');
    const canvas = new FakeCanvas(this, false);
    this.canvases.push(canvas);
    return canvas;
  }

  addCanvas(attributes = {}) {
    const canvas = new FakeCanvas(this, true, attributes);
    this.canvases.push(canvas);
    return canvas;
  }

  querySelectorAll(selector) {
    return selector === 'canvas'
      ? this.canvases.filter((canvas) => canvas.isConnected)
      : [];
  }
}

function createRecorder(resolveImage) {
  const context = vm.createContext({});
  new vm.Script(source + '\nthis.__createDocumentCanvas = createDocumentCanvas;')
    .runInContext(context);
  const document = new FakeDocument();
  const recorder = context.__createDocumentCanvas({
    document,
    resolveImage,
    ensureElementId(canvas) {
      canvas.setAttribute('data-pirc-script-id', 'canvas-image-test');
      return 'canvas-image-test';
    },
  });
  recorder.install();
  const canvas = document.addCanvas({ width: 32, height: 24 });
  return { canvas, recorder, context2d: canvas.getContext('2d') };
}

function image(id = 'image-v1', width = 4, height = 3) {
  return {
    decoded: { imageId: id, width, height, originClean: true },
  };
}

function readCommands(recorder) {
  return JSON.parse(JSON.stringify(recorder.snapshots()[0].commands));
}

test('drawImage records the 3, 5, and 9 argument forms with normalized crops', () => {
  const { context2d, recorder } = createRecorder((source) => source.decoded);
  const source = image();

  context2d.drawImage(source, 10, 20);
  context2d.drawImage(source, 10, 20, 8, 6);
  context2d.drawImage(source, -1, 1, 4, 4, 0, 0, 8, 8);
  context2d.drawImage(source, 1, 0, -2, 2, 16, 0, -8, -8);
  context2d.drawImage(source, 0, 0, 4, 3, 0, 10, 8, 6, 'ignored');

  const commands = readCommands(recorder);
  assert.deepEqual(commands.map(({ args }) => args), [
    ['image-v1', 0, 0, 4, 3, 10, 20, 4, 3],
    ['image-v1', 0, 0, 4, 3, 10, 20, 8, 6],
    ['image-v1', 0, 1, 3, 2, 2, 0, 6, 4],
    ['image-v1', 0, 0, 1, 2, 12, -8, 4, 8],
    ['image-v1', 0, 0, 4, 3, 0, 10, 8, 6],
  ]);
  assert.equal(commands[0].op, 'drawImage');
});

test('pending images are no-ops, handles are captured, and invalid sources fail', () => {
  const { context2d, recorder } = createRecorder((source) => {
    if (source === 'pending') return null;
    if (source === 'broken') {
      const error = new Error('broken image');
      error.name = 'InvalidStateError';
      throw error;
    }
    if (!source || typeof source !== 'object' || !source.decoded)
      throw new TypeError('Expected an HTMLImageElement.');
    return source.decoded;
  });
  const changingImage = image('decode-a');
  context2d.drawImage('pending', 0, 0);
  context2d.drawImage(changingImage, 0, 0);
  changingImage.decoded = { ...changingImage.decoded, imageId: 'decode-b' };
  context2d.drawImage(changingImage, 1, 1);

  assert.deepEqual(readCommands(recorder).map(({ args }) => args[0]), [
    'decode-a', 'decode-b',
  ]);
  assert.throws(() => context2d.drawImage('broken', 0, 0), {
    name: 'InvalidStateError',
  });
  assert.throws(() => context2d.drawImage({}, 0, 0), {
    name: 'TypeError',
  });
  assert.throws(() => context2d.drawImage(null, 0, 0), {
    name: 'TypeError',
  });
  assert.throws(() => context2d.drawImage(changingImage), {
    name: 'TypeError',
  });
  assert.throws(() => context2d.drawImage(changingImage, 0, 0, 1), {
    name: 'TypeError',
  });
});

test('nonfinite drawImage arguments are no-ops', () => {
  const { context2d, recorder } = createRecorder((source) => source.decoded);
  const source = image();
  context2d.drawImage(source, Number.NaN, 0);
  context2d.drawImage(source, 0, 0, Number.POSITIVE_INFINITY, 2);
  context2d.drawImage(source, 0, 0);
  assert.equal(readCommands(recorder).length, 1);
});

test('image smoothing state defaults and save/restore are recorded', () => {
  const { context2d, recorder } = createRecorder((source) => source.decoded);
  const source = image();
  assert.equal(context2d.imageSmoothingEnabled, true);
  assert.equal(context2d.imageSmoothingQuality, 'low');
  context2d.save();
  context2d.imageSmoothingEnabled = false;
  context2d.imageSmoothingQuality = 'high';
  context2d.drawImage(source, 0, 0);
  context2d.restore();
  context2d.drawImage(source, 0, 0);

  const commands = readCommands(recorder);
  assert.equal(commands[0].state.imageSmoothingEnabled, false);
  assert.equal(commands[0].state.imageSmoothingQuality, 'high');
  assert.equal(commands[1].state.imageSmoothingEnabled, true);
  assert.equal(commands[1].state.imageSmoothingQuality, 'low');
});
