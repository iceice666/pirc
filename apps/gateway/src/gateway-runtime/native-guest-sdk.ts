import { BUDGETS } from '../agent/ptc/contracts.js';
import { GUEST_LIMITS, ROOT_SCOPE } from '../agent/ptc/protocol.js';

/** Shipped realm adapter for the native WASM host. Native callbacks have no ambient authority.
 * Supervisor treats all emitted messages as untrusted and owns manifest/policy/journal quotas.
 * Store reads are additionally latched outside the realm by the native loaded callback.
 */
export function nativeGuestSdk(prelude: string): string {
  return `(() => {
    const emitNative = globalThis.__pirc_emit;
    const loadedNative = globalThis.__pirc_loaded;
    delete globalThis.__pirc_emit; delete globalThis.__pirc_loaded;
    const stringify = JSON.stringify, parse = JSON.parse;
    const create = Object.create, keys = Object.keys, descriptor = Object.getOwnPropertyDescriptor;
    const setPrototypeOf = Object.setPrototypeOf, isArray = Array.isArray;
    const apply = Reflect.apply, stringSlice = String.prototype.slice, StringValue = String;
    const slice = (value, start, end) => apply(stringSlice, StringValue(value), [start, end]);
    const resolvePromise = Promise.resolve.bind(Promise), thenPromise = Function.call.bind(Promise.prototype.then);
    const PromiseValue = Promise;
    // Wire envelopes never consult realm-modifiable prototypes, accessors or toJSON.
    const clean = (value, depth = 0) => {
      if (depth > 64) throw new Error('Wire depth exceeded');
      if (value === null || typeof value !== 'object') return value;
      const out = isArray(value) ? setPrototypeOf([], null) : create(null);
      const names = keys(value);
      for (let index = 0; index < names.length; index++) {
        const key = names[index];
        const entry = descriptor(value, key);
        if (!entry || !('value' in entry)) throw new Error('Wire accessor');
        out[key] = clean(entry.value, depth + 1);
      }
      return out;
    };
    const emit = value => emitNative(stringify(clean(value)));
    let started = false, finished = false, received = 0, nextId = 0;
    let current = ${JSON.stringify(ROOT_SCOPE)}, scopeCount = 0, consoleBytes = 0;
    const pending = create(null), scopes = create(null);
    const has = (object, key) => descriptor(object,key) !== undefined;
    const root = ${JSON.stringify(ROOT_SCOPE)};
    const effective = scope => {
      for (let n = 0; scope !== root && n <= ${BUDGETS.parScopes}; n++) {
        const info = scopes[scope]; if (!info) return root;
        if (info.open) return scope; scope = info.parent;
      }
      return root;
    };
    const call = (type, fields) => new PromiseValue(resolve => {
      const id = ++nextId, scope = effective(current);
      pending[id] = {resolve, scope}; emit({type, id, ...fields, ...(type === 'call' ? {scope} : {})});
    });
    const fail = error => {
      if (finished) return; finished = true;
      emit({type:'done',received,outcome:{ok:false,error:{code:'ScriptError',message:slice(error,0,8192)}}});
    };
    const receive = json => {
      const message = parse(json);
      if (!started) {
        if (message.type !== 'start') throw new Error('Expected start'); started = true;
        const host = {
          manifest: stringify(message.manifest), store: message.store || '{}',
          loaded: () => loadedNative(),
          call: (name, argsJson) => {
            const oversize = argsJson.length > ${GUEST_LIMITS.argsChars};
            return call('call', {name:slice(name,0,${GUEST_LIMITS.nameChars}),argsJson:oversize?'':argsJson,...(oversize?{oversize:true}:{})});
          },
          attach: handle => call('attach',{handle:slice(handle,0,100)}),
          log: (level,text) => { if(consoleBytes>${BUDGETS.consoleBytes})return;
            text=slice(text,0,${BUDGETS.consoleBytes + 1});consoleBytes+=text.length+1;
            emit({type:'log',level:slice(level,0,8),text}); },
          scopeOpen: () => { if(scopeCount>=${BUDGETS.parScopes})return '';
            const scope='par'+(++scopeCount),parent=effective(current);scopes[scope]={parent,open:true};emit({type:'scope_open',scope,parent});return scope; },
          enter: scope => {const previous=current;if(has(scopes,scope))current=scope;return previous;},
          leave: scope => {current=scope===root||has(scopes,scope)?scope:root;},
          scopeCancel: scope => {if(has(scopes,scope))emit({type:'scope_cancel',scope});},
          scopeClose: (scope,status) => {const info=scopes[scope];if(!info?.open)return;info.open=false;emit({type:'scope_close',scope,status:status==='completed'?'completed':'failed'});}
        };
        globalThis.__ptc=host;
        (0,eval)(${JSON.stringify(prelude)});
        const finish=globalThis.__ptc_finish;
        delete globalThis.__ptc_finish;
        const promise=(0,eval)(message.code+'\\n;__ptc_main();');
        thenPromise(resolvePromise(finish(promise)),value=>{
          if(finished)return;finished=true;const outcome=parse(value);
          if(outcome.ok&&typeof outcome.value==='string')outcome.value=slice(outcome.value,0,${GUEST_LIMITS.valueChars});
          if(outcome.ok&&outcome.store!==undefined&&(typeof outcome.store!=='string'||outcome.store.length>${BUDGETS.storeTotalChars + 2}))delete outcome.store;
          if(!outcome.ok)outcome.error.message=slice(outcome.error.message,0,8192);
          emit({type:'done',received,outcome});
        },fail);
      } else {
        if(message.type!=='result'||finished)return;
        const item=pending[message.id];if(!item)return;
        delete pending[message.id];received++;current=item.scope;item.resolve(message.json);
      }
    };
    // Native host calls idle only after draining all pending jobs, preserving scope attribution.
    return [receive, () => {current=root;if(!finished)emit({type:'idle',received});}];
  })()`;
}
