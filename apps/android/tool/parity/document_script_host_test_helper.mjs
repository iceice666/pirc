// Node host adapter for the production native Script task protocol. Guest code
// runs as vm.Script in one persistent realm, never eval/Function. This adapter
// intentionally does not emulate Android IPC microtask checkpoints; those are
// verified separately on the actual native engine.
import assert from 'node:assert/strict';
const oneShot = ['resourceRequests','resourceCancellations','filePickerActions',
  'formActions','focusActions','navigationActions','cookieWrites'];
export function createDocumentScriptHostVm(nativeVm) {
  const lastStarted = new WeakMap();
  const raw = (source, context, options) =>
    new nativeVm.Script(source).runInContext(context, options);
  function drain(value, context, options) {
    if (typeof value !== 'string') return value;
    let result;
    try {result = JSON.parse(value);} catch {return value;}
    if (!result || typeof result.html !== 'string' || !Array.isArray(result.diagnostics) ||
        !result.classicScript) return value;
    for (let count=0; result.classicScript && count<128; count++) {
      const id=result.classicScript.id;
      assert.ok(Number.isSafeInteger(id) && id>0 && id>(lastStarted.get(context)||0));
      const task=JSON.parse(raw('__pircDocument.beginClassicScript('+JSON.stringify({id})+')',context,options));
      assert.equal(task.id,id);assert.equal(typeof task.source,'string');
      const source=task.source+'\n;__pircDocument.endClassicScriptTurn('+id+');void 0;';
      assert.ok(Buffer.byteLength(source,'utf8')<=4*1024*1024);
      lastStarted.set(context,id);
      let error;
      try {raw(source,context,options);}
      catch (failure) {
        if (failure?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT') throw failure;
        error=String(failure?.stack || failure);
        // A throwing vm Script skips its normal afterEvaluate checkpoint.
        raw('void 0;',context,options);
      }
      const next=JSON.parse(raw('__pircDocument.finishClassicScript('+JSON.stringify({id,...error?{error}:{}})+')',context,options));
      const merged={...result,...next};
      for(const key of oneShot) merged[key]=[...(result[key]||[]),...(next[key]||[])];
      result=merged;
    }
    return JSON.stringify(result);
  }
  class Script extends nativeVm.Script {
    runInContext(context,options) {return drain(super.runInContext(context,options),context,options);}
  }
  return {...nativeVm,Script,
    runInContext(source,context,options) {return drain(raw(source,context,options),context,options);}
  };
}
