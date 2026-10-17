/* FileReader over bounded in-memory/native-picker Blob bytes. All work runs on
 * the document's host-pumped task queue; no filesystem or network API is added. */
function createDocumentFileReader(deps) {
  const binary = deps.binary;
  const readers = new WeakMap();
  const internalEventToken = {};
  const eventNames = ['loadstart', 'progress', 'load', 'abort', 'error', 'loadend'];
  const errorCodes = {IndexSizeError:1,HierarchyRequestError:3,WrongDocumentError:4,InvalidCharacterError:5,
    NoModificationAllowedError:7,NotFoundError:8,NotSupportedError:9,InUseAttributeError:10,
    InvalidStateError:11,SyntaxError:12,InvalidModificationError:13,NamespaceError:14,
    InvalidAccessError:15,TypeMismatchError:17,SecurityError:18,NetworkError:19,AbortError:20,
    URLMismatchError:21,QuotaExceededError:22,TimeoutError:23,InvalidNodeTypeError:24,DataCloneError:25};
  class DOMException extends Error {
    constructor(message, name) {
      super(message === undefined ? '' : String(message));
      Object.defineProperty(this, 'name', {value:name === undefined ? 'Error' : String(name), configurable:true});
    }
    get code() { return errorCodes[this.name] || 0; }
    get [Symbol.toStringTag]() { return 'DOMException'; }
  }
  class ProgressEvent extends deps.Event {
    constructor(type, init, token) {
      if (!arguments.length) throw new TypeError('An event type is required.');
      const options = init == null ? {} : Object(init);
      super(String(type), options);
      for (const [name, value] of Object.entries({
        lengthComputable:Boolean(options.lengthComputable),
        loaded:unsigned(options.loaded),total:unsigned(options.total),
        composed:Boolean(options.composed),isTrusted:token === internalEventToken
      })) Object.defineProperty(this,name,{value,enumerable:true});
    }
    preventDefault() { if (this.cancelable) super.preventDefault(); }
    get [Symbol.toStringTag]() { return 'ProgressEvent'; }
  }
  function unsigned(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }
  function state(reader) {
    const value = readers.get(reader);
    if (!value) throw new TypeError('Illegal invocation.');
    return value;
  }
  function report(error) { if (deps.reportError) deps.reportError(error); }
  function remove(reader, record) {
    const s = state(reader);
    const index = s.listeners.indexOf(record);
    if (index < 0) return;
    s.listeners.splice(index,1);
    deps.EventTarget.prototype.removeEventListener.call(reader,record.type,record.wrapper);
    if (record.signal && record.abort) record.signal.removeEventListener('abort',record.abort);
  }
  function add(reader, type, callback, options) {
    const s = state(reader);
    if (callback == null) return;
    if (typeof callback !== 'function' && typeof callback !== 'object')
      throw new TypeError('Event listener must be a function or object.');
    const name = String(type);
    const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
    if (s.listeners.some(r=>r.type===name && r.callback===callback && r.capture===capture)) return;
    const signal = options && typeof options === 'object' ? options.signal : null;
    if (signal && signal.aborted) return;
    const record = {type:name,callback,capture,signal,once:Boolean(options && options.once),wrapper:null,abort:null};
    record.wrapper = function(event) {
      if (record.once) remove(reader, record);
      try {
        if (typeof callback === 'function') callback.call(reader,event);
        else if (typeof callback.handleEvent === 'function') callback.handleEvent(event);
      } catch (error) { report(error); }
    };
    s.listeners.push(record);
    deps.EventTarget.prototype.addEventListener.call(reader,name,record.wrapper);
    if (signal && typeof signal.addEventListener === 'function') {
      record.abort = function() { remove(reader,record); };
      signal.addEventListener('abort',record.abort,{once:true});
    }
  }
  function emit(reader, type, loaded, total, computable) {
    reader.dispatchEvent(new ProgressEvent(type,{
      lengthComputable: computable !== false, loaded: loaded, total: total,
      bubbles:false, cancelable:false
    },internalEventToken));
  }
  function current(reader, operation) {
    const s = state(reader);
    return s.operation === operation && s.readyState === 1;
  }
  function queue(reader, operation, callback) {
    const id = deps.schedule(function() {
      if (!current(reader,operation)) return;
      operation.task = null;
      callback();
    });
    if (!id) throw new DOMException('The document task limit has been reached.','QuotaExceededError');
    operation.task = id;
  }
  function fail(reader, operation, error) {
    if (!current(reader,operation)) return;
    const s = state(reader);
    s.readyState = 2;
    s.result = null;
    s.error = new DOMException(String(error && error.message || error),
      error && error.name === 'NotSupportedError' ? 'NotSupportedError' : 'NotReadableError');
    emit(reader,'error',0,0,false);
    Promise.resolve().then(function() {
      if (s.readyState !== 1) emit(reader,'loadend',0,0,false);
    });
  }
  function binaryString(bytes) {
    const chunks=[];
    for(let offset=0;offset<bytes.length;offset+=8192)
      chunks.push(String.fromCharCode.apply(null,bytes.subarray(offset,offset+8192)));
    return chunks.join('');
  }
  function finish(reader, operation) {
    let bytes;
    try { bytes = binary.getBytes(operation.blob); }
    catch (error) { fail(reader,operation,error); return; }
    if (!current(reader,operation)) return;
    operation.loaded = bytes.length;
    // Chrome's final progress notification arrives after its underlying read
    // has completed: abort() from that notification does not cancel the result.
    operation.complete = true;
    if (bytes.length) emit(reader,'progress',bytes.length,bytes.length);
    if (!current(reader,operation)) return;
    let result;
    try {
      switch(operation.kind) {
        case 'buffer': result = bytes.buffer; break;
        case 'binary': result = binaryString(bytes); break;
        case 'url': result = 'data:' + (operation.type || 'application/octet-stream') + ';base64,' + binary.bytesToBase64(bytes); break;
        default: result = deps.decodeText(bytes,operation.encoding,operation.type);
      }
    } catch (error) { fail(reader,operation,error); return; }
    const s = state(reader);
    s.readyState = 2;
    s.result = result;
    s.error = null;
    emit(reader,'load',bytes.length,bytes.length);
    // A new read started from load/error suppresses the prior loadend.
    Promise.resolve().then(function() {
      if (s.readyState !== 1) emit(reader,'loadend',bytes.length,bytes.length);
    });
  }
  function read(reader, blob, kind, encoding) {
    const metadata = binary.blobMetadata(blob); // Validate the Blob brand first.
    const label = encoding === undefined ? undefined : String(encoding);
    const s = state(reader);
    if (s.readyState === 1) throw new DOMException('A read is already in progress.','InvalidStateError');
    const operation = {blob,kind,encoding:label,type:metadata.type,size:metadata.size,loaded:0,task:null,complete:false};
    s.result = null; s.error = null; s.readyState = 1; s.operation = operation;
    try {
      queue(reader,operation,function() {
        emit(reader,'loadstart',0,operation.size);
        if (current(reader,operation)) {
          try { queue(reader,operation,function() { finish(reader,operation); }); }
          catch(error) { fail(reader,operation,error); }
        }
      });
    } catch(error) { s.readyState=2; s.error=error; throw error; }
  }
  class FileReader extends deps.EventTarget {
    constructor() {
      super();
      readers.set(this,{readyState:0,result:null,error:null,operation:null,listeners:[],handlers:new Map()});
    }
    get readyState() { return state(this).readyState; }
    get result() { return state(this).result; }
    get error() { return state(this).error; }
    readAsArrayBuffer(blob) { if(!arguments.length) throw new TypeError('A Blob is required.'); read(this,blob,'buffer'); }
    readAsBinaryString(blob) { if(!arguments.length) throw new TypeError('A Blob is required.'); read(this,blob,'binary'); }
    readAsDataURL(blob) { if(!arguments.length) throw new TypeError('A Blob is required.'); read(this,blob,'url'); }
    readAsText(blob,encoding) { if(!arguments.length) throw new TypeError('A Blob is required.'); read(this,blob,'text',encoding); }
    abort() {
      const s = state(this);
      const op = s.operation;
      if (s.readyState !== 1 || op && op.complete) return;
      s.result = null;
      if (op && op.task != null) deps.cancel(op.task);
      s.operation = null;
      s.readyState = 2;
      s.error = new DOMException('The read was aborted.','AbortError');
      emit(this,'abort',0,0,false);
      if (s.readyState !== 1) emit(this,'loadend',0,0,false);
    }
    addEventListener(type,callback,options) { add(this,type,callback,options); }
    removeEventListener(type,callback,options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
      const record=state(this).listeners.find(r=>r.type===String(type) && r.callback===callback && r.capture===capture);
      if(record) remove(this,record);
    }
    get [Symbol.toStringTag]() { return 'FileReader'; }
  }
  for(const [name,value] of [['EMPTY',0],['LOADING',1],['DONE',2]]) {
    Object.defineProperty(FileReader,name,{value,enumerable:true});
    Object.defineProperty(FileReader.prototype,name,{value,enumerable:true});
  }
  for(const type of eventNames) {
    Object.defineProperty(FileReader.prototype,'on'+type,{
      enumerable:true, configurable:true,
      get:function() { const record=state(this).handlers.get(type); return record ? record.callback : null; },
      set:function(callback) {
        const s=state(this); const old=s.handlers.get(type);
        if(typeof callback!=='function') {
          if(old) this.removeEventListener(type,old.listener);
          s.handlers.delete(type); return;
        }
        if(old) {old.callback=callback; return;}
        const record={callback,listener:null};
        record.listener=function(event) {record.callback.call(this,event);};
        s.handlers.set(type,record); this.addEventListener(type,record.listener);
      }
    });
  }
  return {FileReader,ProgressEvent,DOMException,
    createProgressEvent: function(type, init) {
      return new ProgressEvent(type, init, internalEventToken);
    }
  };
}
