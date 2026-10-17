// Synchronous text advances from the same Skia paragraph implementation as the
// pinned Flutter engine. Font data comes from native font matching, never CSS
// widths, character-count estimates, or a replay of the authored script.
function createPircCanvasTextEngine(ck, resources, matches, buffers) {
  const bytesByName = new Map();
  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    if (!bytesByName.has(resource.dataName)) bytesByName.set(resource.dataName, buffers[i]);
  }
  const fontManager = ck.FontMgr.FromData(...bytesByName.values());
  if (!fontManager) throw new Error('Skia could not load the matched native fonts.');
  const families = new Map();
  const familyByData = new Map();
  try {
    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i];
      if (familyByData.has(resource.dataName)) {
        families.set(resource.id,familyByData.get(resource.dataName));
        continue;
      }
      const bytes = new Uint8Array(buffers[i]);
      if (resource.ttcIndex !== 0) throw new Error('Native font collection face was not extracted.');
      const face = ck.Typeface.MakeFreeTypeFaceFromData(bytes);
      if (!face) throw new Error('Skia could not select a matched native font face.');
      try {
        const family = face.getFamilyName();
        families.set(resource.id, family);
        familyByData.set(resource.dataName, family);
      } finally { face.delete(); }
    }
  } catch (error) {
    fontManager.delete();
    throw error;
  }
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const cache = new Map();
  let cacheCharacters = 0;
  const scales = {px:1,pt:96/72,pc:16,in:96,cm:96/2.54,mm:96/25.4,q:96/101.6,em:16,rem:16};
  function unavailable(message) { const error = new Error(message); error.name='NotSupportedError'; return error; }
  function fontSpec(source) {
    const match = /(?:(italic|oblique)\s+)?(?:(bold|bolder|lighter|[1-9]00)\s+)?([0-9]*\.?[0-9]+)(px|pt|pc|in|cm|mm|q|em|rem)(?:\/[^\s]+)?\s+(.+)$/i.exec(source.trim());
    if (!match) throw unavailable('Canvas text measurement cannot parse this font.');
    const rawWeight = (match[2] || '400').toLowerCase();
    const weight = rawWeight === 'bold' || rawWeight === 'bolder' ? 700 : rawWeight === 'lighter' ? 300 : Number(rawWeight);
    const italic = Boolean(match[1]);
    const size = Number(match[3]) * scales[match[4].toLowerCase()];
    // Match the painter's first-family policy. Unprepared named families fail
    // explicitly instead of claiming another font's advances are the same.
    const first = /^\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/.exec(match[5]);
    const family = (first?.[1] ?? first?.[2] ?? first?.[3] ?? '').trim();
    const selected = matches.find(item => item.family.toLowerCase() === family.toLowerCase() && item.weight === weight && item.italic === italic);
    if (!selected || !(size > 0 && size <= 4096)) throw unavailable('Canvas text font family or style was not prepared by the native matcher.');
    const fontFamilies = selected.resourceIds.map(id => families.get(id));
    if (!fontFamilies.length || fontFamilies.some(name => !name)) throw unavailable('Canvas text font match is incomplete.');
    return {fontFamilies, fontSize:size, fontStyle:{weight,slant:italic?ck.FontSlant.Italic:ck.FontSlant.Upright},
      fontVariations:byId.get(selected.resourceIds[0]).axes || []};
  }
  function measureText(source, text, direction) {
    if (text.length > 16384) throw new RangeError('Canvas text measurement is limited to 16384 UTF-16 units per call.');
    // Canvas replaces each ASCII whitespace character with a space; raw Skia
    // paragraphs would otherwise use tab stops and split at newline characters.
    const normalized = text.replace(/[\t\n\v\f\r]/g,' ');
    const key = JSON.stringify([source,direction,normalized]);
    if (cache.has(key)) return cache.get(key);
    const style = fontSpec(source);
    const builder = ck.ParagraphBuilder.Make(new ck.ParagraphStyle({
      disableHinting:true, applyRoundingHack:false, maxLines:1,
      textDirection:direction === 'rtl' ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textStyle:style,
    }),fontManager);
    let paragraph;
    try {
      builder.addText(normalized);
      paragraph = builder.build();
      paragraph.layout(1e9);
      if (paragraph.unresolvedCodepoints().length)
        throw unavailable('Canvas text contains glyphs not available in the prepared native fonts.');
      const width = paragraph.getMaxIntrinsicWidth();
      if (!Number.isFinite(width) || width < 0) throw new Error('Skia returned invalid Canvas text advances.');
      if (cache.size >= 512 || cacheCharacters + key.length > 262144) {cache.clear();cacheCharacters=0;}
      if (key.length <= 262144) {cache.set(key,width);cacheCharacters+=key.length;}
      return width;
    } finally {
      paragraph?.delete();
      builder.delete();
    }
  }
  return Object.freeze({measureText,heapBytes:ck.HEAPU8.buffer.byteLength,fontCount:resources.length});
}

async function initializePircCanvasText(input) {
  const names = [input.wasmName, ...new Set(input.resources.map(item => item.dataName))];
  const loaded = await Promise.all(names.map(name => android.consumeNamedDataAsArrayBuffer(name)));
  const data = new Map(names.map((name,index)=>[name,loaded[index]]));
  const wasm = data.get(input.wasmName);
  const ck = await CanvasKitInit({instantiateWasm(imports, receive) {
    const module = new WebAssembly.Module(wasm);
    const instance = new WebAssembly.Instance(module, imports);
    receive(instance,module);
    return instance.exports;
  }});
  const engine = createPircCanvasTextEngine(ck,input.resources,input.matches,input.resources.map(item=>data.get(item.dataName)));
  Object.defineProperty(globalThis,'__pircNativeCanvasText',{value:engine,configurable:true});
  return JSON.stringify({ok:true,heapBytes:engine.heapBytes,fontCount:engine.fontCount});
}
Object.defineProperty(globalThis,'__pircInitializeCanvasText',{value:initializePircCanvasText,configurable:true});
