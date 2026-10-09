import { expect, test } from 'bun:test';
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import wasmPath from '@jitl/quickjs-wasmfile-release-asyncify/wasm' with { type: 'file' };
import { newQuickJSAsyncWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import { PTC_GUEST_PRELUDE } from '../src/agent/ptc/guest.js';
import { nativeGuestSdk } from '../src/gateway-runtime/native-guest-sdk.js';
import { fixedMemoryAdapter } from '../../../scripts/build-native-ptc-worker.js';

test('native fixed-memory adapter validates and exposes only expected imports and memory', () => {
  const module = new WebAssembly.Module(fixedMemoryAdapter());
  expect(WebAssembly.Module.imports(module)).toHaveLength(19);
  expect(
    WebAssembly.Module.imports(module).every(
      (entry) => entry.module === 'pirc' && entry.kind === 'function',
    ),
  ).toBe(true);
  expect(WebAssembly.Module.exports(module).filter((entry) => entry.kind === 'memory')).toEqual([
    { name: 'a', kind: 'memory' },
  ]);
});

test('native SDK shares PTC semantics for dependency batches, stores, attachments and load provenance', async () => {
  const module = await newQuickJSAsyncWASMModuleFromVariant(
    newVariant(variant, { wasmBinary: () => Bun.file(wasmPath).arrayBuffer() }),
  );
  const vm = module.newContext();
  const messages: any[] = [];
  let loaded = false;
  const emit = vm.newFunction('emit', (value) => {
    messages.push(JSON.parse(vm.getString(value)));
  });
  const load = vm.newFunction('loaded', () => {
    loaded = true;
  });
  vm.setProp(vm.global, '__pirc_emit', emit);
  vm.setProp(vm.global, '__pirc_loaded', load);
  emit.dispose();
  load.dispose();
  const bridge = vm.unwrapResult(vm.evalCode(nativeGuestSdk(PTC_GUEST_PRELUDE)));
  const receive = vm.getProp(bridge, 0),
    idle = vm.getProp(bridge, 1);
  const send = (value: unknown) => {
    const json = vm.newString(JSON.stringify(value));
    vm.unwrapResult(vm.callFunction(receive, vm.undefined, json)).dispose();
    json.dispose();
    vm.runtime.executePendingJobs().unwrap();
    vm.unwrapResult(vm.callFunction(idle, vm.undefined)).dispose();
  };
  try {
    send({
      type: 'start',
      code: 'async function __ptc_main(){let n=load("n");for(let i=0;i<10;i++)n=(await tools.read({n})).n;store("n",n);await attachments.add("image");return n;}',
      manifest: ['read'],
      store: '{"n":2}',
    });
    let count = 0;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.type === 'call') {
        count++;
        const n = JSON.parse(message.argsJson).n;
        send({
          type: 'result',
          id: message.id,
          json: JSON.stringify({ ok: true, data: { n: n + 1 } }),
        });
      } else if (message.type === 'attach')
        send({
          type: 'result',
          id: message.id,
          json: JSON.stringify({ ok: true, data: { queued: 1 } }),
        });
    }
    expect(count).toBe(10);
    expect(loaded).toBe(true);
    expect(messages.find((message) => message.type === 'done').outcome).toEqual({
      ok: true,
      value: '12',
      store: '{"n":12}',
    });
    expect(messages.filter((message) => message.type === 'attach')).toHaveLength(1);
  } finally {
    receive.dispose();
    idle.dispose();
    bridge.dispose();
    vm.dispose();
  }
});
