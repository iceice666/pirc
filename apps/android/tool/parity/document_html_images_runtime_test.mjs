import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import { createDocumentScriptHostVm } from './document_script_host_test_helper.mjs';
const vm = createDocumentScriptHostVm(nativeVm),
  bundle = readFileSync(
    new URL('../../assets/document-script-runtime.js', import.meta.url),
    'utf8',
  );
function start() {
  const c = vm.createContext({});
  vm.runInContext(bundle, c);
  return c;
}
function call(c, name, arg = {}) {
  return JSON.parse(vm.runInContext('__pircDocument.' + name + '(' + JSON.stringify(arg) + ')', c));
}
test('HTML managed image metadata is separate from authored attributes', async () => {
  const c = start(),
    initial = call(c, 'init', {
      url: 'https://assets.example/test',
      html: '<img id="photo" src="/photo.png" onload="window.loaded=true"><img id="fake" data-pirc-native-image-id="forged">',
    });
  const request = initial.resourceRequests.find((r) => r.kind === 'image');
  assert.ok(request);
  assert.equal(initial.htmlImages.length, 1);
  assert.equal(initial.htmlImages[0].status, 'pending');
  const result = call(c, 'completeResource', {
    id: request.id,
    ok: true,
    imageId: 'owned-1',
    width: 2,
    height: 2,
    originClean: true,
  });
  assert.equal(result.htmlImages.length, 1);
  assert.equal(result.htmlImages[0].status, 'loaded');
  assert.equal(result.htmlImages[0].imageId, 'owned-1');
  assert.ok(result.imageReferences.includes('owned-1'));
  assert.equal(
    vm.runInContext(
      'document.getElementById("photo").hasAttribute("data-pirc-native-image-id")',
      c,
    ),
    false,
  );
  assert.ok(result.html.includes('data-pirc-native-image-id="forged"'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('window.loaded', c), true);
});
test('replacement and failed image loads do not expose an old handle', () => {
  const c = start(),
    init = call(c, 'init', {
      url: 'https://assets.example/test',
      html: '<img id="photo" src="/first.png" onload="void 0">',
    });
  const id = init.resourceRequests[0].id;
  call(c, 'completeResource', {
    id,
    ok: true,
    imageId: 'old',
    width: 2,
    height: 2,
    originClean: true,
  });
  vm.runInContext('document.getElementById("photo").src="/new.png"', c);
  const next = call(c, 'snapshot');
  assert.equal(next.htmlImages[0].status, 'pending');
  assert.equal(next.htmlImages[0].imageId, undefined);
  const failed = call(c, 'completeResource', {
    id: next.resourceRequests[0].id,
    ok: false,
    error: 'synthetic error',
  });
  assert.equal(failed.htmlImages[0].status, 'error');
  assert.equal(failed.htmlImages[0].imageId, undefined);
});
test('detached HTML images keep Canvas resources without an HTML target', () => {
  const c = start(),
    init = call(c, 'init', {
      url: 'https://assets.example/test',
      html: '<img id="photo" src="/photo.png" onload="void 0">',
    });
  call(c, 'completeResource', {
    id: init.resourceRequests[0].id,
    ok: true,
    imageId: 'retained',
    width: 2,
    height: 2,
    originClean: true,
  });
  vm.runInContext('window.photo=document.getElementById("photo");photo.remove()', c);
  const result = call(c, 'snapshot');
  assert.deepEqual(result.htmlImages, []);
  assert.ok(result.imageReferences.includes('retained'));
  assert.equal(vm.runInContext('photo.naturalWidth', c), 2);
});
