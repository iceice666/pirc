// Synchronous text advances and ink bounds from the Skia implementation of the
// pinned Flutter engine. Font data comes from native font matching, never CSS
// widths, character-count estimates, or a replay of the authored script.
function createPircCanvasTextEngine(ck, resources, matches, buffers) {
  const bytesByName = new Map();
  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    if (!bytesByName.has(resource.dataName)) bytesByName.set(resource.dataName, buffers[i]);
  }
  const families = new Map();
  const familyByData = new Map();
  // Resolve names before retaining the manager: a temporary Typeface otherwise
  // duplicates the largest font while the manager already owns all font bytes.
  {
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
  }
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const cache = new Map();
  const basicCache = new Map();
  let cacheCharacters = 0;
  const scales = {px:1,pt:96/72,pc:16,in:96,cm:96/2.54,mm:96/25.4,q:96/101.6,em:16,rem:16};
  const inkPrecision = 1 / 65536;
  function unavailable(message) { const error = new Error(message); error.name='NotSupportedError'; return error; }

  function fontTables(bytes) {
    const view = new DataView(bytes);
    const tables = new Map();
    if (view.byteLength < 12) throw unavailable('Native font table directory is truncated.');
    const count = view.getUint16(4);
    if (12 + count * 16 > view.byteLength) throw unavailable('Native font table directory is truncated.');
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      const tag = String.fromCharCode(...new Uint8Array(bytes,at,4));
      const offset = view.getUint32(at + 8), length = view.getUint32(at + 12);
      if (offset + length > view.byteLength) throw unavailable('Native font table is truncated.');
      tables.set(tag,{offset,length});
    }
    const os2 = tables.get('OS/2');
    let typoAscent = null, typoDescent = null;
    if (os2 && os2.length >= 74) {
      const ascent = view.getInt16(os2.offset + 68), descent = view.getInt16(os2.offset + 70);
      if (ascent >= 0 && descent <= 0 && ascent - descent > 0) {
        typoAscent = ascent;
        typoDescent = -descent;
      }
    }
    return {typoAscent,typoDescent,hasBase:tables.has('BASE'),
      hasColor:['COLR','CBDT','sbix','SVG '].some(tag=>tables.has(tag))};
  }
  const tablesByData = new Map();
  for (const resource of resources) {
    if (!tablesByData.has(resource.dataName)) tablesByData.set(resource.dataName,fontTables(bytesByName.get(resource.dataName)));
  }

  const fontManager = ck.FontMgr.FromData(...bytesByName.values());
  if (!fontManager) throw new Error('Skia could not load the matched native fonts.');

  function fontSpec(source) {
    const match = /(?:(italic|oblique)\s+)?(?:(bold|bolder|lighter|[1-9]00)\s+)?([0-9]*\.?[0-9]+)(px|pt|pc|in|cm|mm|q|em|rem)(?:\/[^\s]+)?\s+(.+)$/i.exec(source.trim());
    if (!match) throw unavailable('Canvas text measurement cannot parse this font.');
    const rawWeight = (match[2] || '400').toLowerCase();
    const weight = rawWeight === 'bold' || rawWeight === 'bolder' ? 700 : rawWeight === 'lighter' ? 300 : Number(rawWeight);
    const italic = Boolean(match[1]);
    const size = Number(match[3]) * scales[match[4].toLowerCase()];
    const first = /^\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/.exec(match[5]);
    const family = (first?.[1] ?? first?.[2] ?? first?.[3] ?? '').trim();
    const selected = matches.find(item => item.family.toLowerCase() === family.toLowerCase() && item.weight === weight && item.italic === italic);
    if (!selected || !(size > 0 && size <= 4096)) throw unavailable('Canvas text font family or style was not prepared by the native matcher.');
    const fontFamilies = selected.resourceIds.map(id => families.get(id));
    if (!fontFamilies.length || fontFamilies.some(name => !name)) throw unavailable('Canvas text font match is incomplete.');
    return {selected,style:{fontFamilies,fontSize:size,fontStyle:{weight,slant:italic?ck.FontSlant.Italic:ck.FontSlant.Upright},
      fontVariations:byId.get(selected.resourceIds[0]).axes || []}};
  }

  function paragraphFor(spec, text, direction) {
    const builder = ck.ParagraphBuilder.Make(new ck.ParagraphStyle({
      disableHinting:true, applyRoundingHack:false, maxLines:1,
      textAlign:ck.TextAlign.Left,
      textDirection:direction === 'rtl' ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textStyle:spec.style,
    }),fontManager);
    try {
      builder.addText(text);
      const paragraph = builder.build();
      try {
        paragraph.layout(1e9);
        if (paragraph.unresolvedCodepoints().length)
          throw unavailable('Canvas text contains glyphs not available in the prepared native fonts.');
        return paragraph;
      } catch (error) { paragraph.delete(); throw error; }
    } finally { builder.delete(); }
  }

  function resourceFor(spec, typeface) {
    const family = typeface.getFamilyName();
    const candidates = spec.selected.resourceIds.map(id=>byId.get(id)).filter(item=>families.get(item.id) === family);
    const identities = new Set(candidates.map(item=>JSON.stringify([item.dataName,item.axes || [],Boolean(item.fakeBold),Boolean(item.fakeItalic)])));
    if (identities.size !== 1) throw unavailable('Canvas ink font ownership is unavailable or ambiguous.');
    return candidates[0];
  }

  function nativeFont(spec, run) {
    const resource = resourceFor(spec,run.typeface);
    const font = new ck.Font(run.typeface,run.size,run.scaleX === undefined ? 1 : run.scaleX,resource.fakeItalic ? -.25 : 0);
    font.setEmbolden(Boolean(resource.fakeBold));
    font.setHinting(ck.FontHinting.None);
    font.setSubpixel(true);
    font.setLinearMetrics(true);
    return {font,resource};
  }

  function releaseRuns(lines) {
    const typefaces = new Set();
    for (const line of lines) for (const run of line.runs) typefaces.add(run.typeface);
    for (const face of typefaces) face.delete();
  }

  function fontBasics(source) {
    if (basicCache.has(source)) return basicCache.get(source);
    const spec = fontSpec(source);
    // A real primary-font run supplies metrics even for an empty measured text.
    const paragraph = paragraphFor(spec,'H','ltr');
    let lines = [];
    try {
      lines = paragraph.getShapedLines();
      const run = lines[0]?.runs[0];
      if (!run) throw unavailable('Native primary font metrics are unavailable.');
      const {font,resource} = nativeFont(spec,run);
      try {
        const metrics = font.getMetrics(), tables = tablesByData.get(resource.dataName);
        const ascent = Math.round(-metrics.ascent), descent = Math.round(metrics.descent);
        const typoAscent = tables.typoAscent === null ? -metrics.ascent : tables.typoAscent;
        const typoDescent = tables.typoDescent === null ? metrics.descent : tables.typoDescent;
        const emAscent = Math.round(64 * spec.style.fontSize * typoAscent / (typoAscent + typoDescent)) / 64;
        const emDescent = Math.round(64 * spec.style.fontSize) / 64 - emAscent;
        const result = {ascent,descent,emAscent,emDescent,hasBase:tables.hasBase};
        if (![ascent,descent,emAscent,emDescent].every(Number.isFinite)) throw unavailable('Native primary font metrics are invalid.');
        if (basicCache.size >= 128) basicCache.clear();
        basicCache.set(source,result);
        return result;
      } finally { font.delete(); }
    } finally { releaseRuns(lines); paragraph.delete(); }
  }

  function baselineOffset(basic, baseline) {
    if (basic.hasBase && (baseline === 'hanging' || baseline === 'ideographic'))
      throw unavailable('Canvas OpenType BASE-table baseline selection is not implemented.');
    switch (baseline) {
      case 'top': return basic.emAscent;
      case 'hanging': return basic.ascent * .8;
      case 'middle': return (basic.emAscent - basic.emDescent) / 2;
      case 'ideographic': return -basic.descent;
      case 'bottom': return -basic.emDescent;
      default: return 0;
    }
  }

  function fontBaselineOffset(source, baseline) {
    try { return baselineOffset(fontBasics(source),baseline); }
    catch (error) {
      // Drawing still supports platform font fallback when synchronous metrics
      // for that family were not prepared. Preserve its existing native path.
      if (error?.name === 'NotSupportedError') return null;
      throw error;
    }
  }

  function measurement(source, text, direction) {
    if (text.length > 16384) throw new RangeError('Canvas text measurement is limited to 16384 UTF-16 units per call.');
    const normalized = text.replace(/[\t\n\v\f\r]/g,' ');
    const key = JSON.stringify([source,direction,normalized]);
    if (cache.has(key)) return {key,normalized,result:cache.get(key)};
    const paragraph = paragraphFor(fontSpec(source),normalized,direction);
    try {
      const width = paragraph.getMaxIntrinsicWidth();
      if (!Number.isFinite(width) || width < 0) throw new Error('Skia returned invalid Canvas text advances.');
      const result = {width};
      if (cache.size >= 512 || cacheCharacters + key.length > 262144) {cache.clear();cacheCharacters=0;}
      if (key.length <= 262144) {cache.set(key,result);cacheCharacters+=key.length;}
      return {key,normalized,result};
    } finally { paragraph.delete(); }
  }

  function runBounds(spec, line, run) {
    const {font,resource} = nativeFont(spec,run);
    try {
      const positions = new Float32Array(run.positions);
      for (let i = 1; i < positions.length; i += 2) positions[i] -= line.baseline;
      const boxes = font.getGlyphBounds(run.glyphs);
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for (let i=0;i<run.glyphs.length;i++) {
        const at=i*4;
        if (!(boxes[at+2]>boxes[at] && boxes[at+3]>boxes[at+1])) continue;
        left=Math.min(left,positions[i*2]+boxes[at]);
        top=Math.min(top,positions[i*2+1]+boxes[at+1]);
        right=Math.max(right,positions[i*2]+boxes[at+2]);
        bottom=Math.max(bottom,positions[i*2+1]+boxes[at+3]);
      }
      if (left === Infinity) return null;
      const padding = 1 + run.size / 64;
      const start=top-padding,end=bottom+padding;
      // getGlyphBounds is raster/canonical-strike rounded. Intercepts use the
      // actual Skia glyph paths and retain fractional outline extrema.
      const intersects=(a,b)=>font.getGlyphIntercepts(run.glyphs,positions,a,b);
      const intervals=intersects(start,end);
      if (!intervals.length) return {left,top,right,bottom}; // bitmap-only glyphs
      if (tablesByData.get(resource.dataName).hasColor)
        throw unavailable('Mixed color/outline Canvas ink bounds require per-glyph color geometry.');
      let inkLeft=Infinity,inkRight=-Infinity;
      for (let i=0;i<intervals.length;i++) {
        inkLeft=Math.min(inkLeft,intervals[i]);inkRight=Math.max(inkRight,intervals[i]);
      }
      function edge(upper) {
        let lo=start,hi=end;
        for (let i=0;i<40 && hi-lo>inkPrecision;i++) {
          const mid=Math.fround((lo+hi)/2);
          if (!(mid>lo && mid<hi)) break;
          const hit=upper ? intersects(start,mid).length>0 : intersects(mid,end).length>0;
          if (upper ? hit : !hit) hi=mid; else lo=mid;
        }
        return (lo+hi)/2;
      }
      return {left:inkLeft,top:edge(true),right:inkRight,bottom:edge(false)};
    } finally { font.delete(); }
  }

  function measureText(source,text,direction) { return measurement(source,text,direction).result.width; }

  function measureInk(source,text,direction,align,baseline) {
    const item=measurement(source,text,direction), result=item.result;
    if (!result.ink) {
      const spec=fontSpec(source), paragraph=paragraphFor(spec,item.normalized,direction);
      let lines=[];
      try {
        lines=paragraph.getShapedLines();
        let ink=null;
        for (const line of lines) for (const run of line.runs) {
          const box=runBounds(spec,line,run);
          if (!box) continue;
          ink=ink ? {left:Math.min(ink.left,box.left),top:Math.min(ink.top,box.top),
            right:Math.max(ink.right,box.right),bottom:Math.max(ink.bottom,box.bottom)} : box;
        }
        result.ink=ink || {left:0,top:0,right:0,bottom:0};
      } finally { releaseRuns(lines); paragraph.delete(); }
    }
    const basic=fontBasics(source), offset=baselineOffset(basic,baseline);
    const effective=align === 'start' ? (direction === 'rtl' ? 'right' : 'left') :
      align === 'end' ? (direction === 'rtl' ? 'left' : 'right') : align;
    const dx=effective === 'center' ? result.width/2 : effective === 'right' ? result.width : 0;
    const ink=result.ink;
    const metrics={width:result.width,actualBoundingBoxLeft:dx-ink.left,actualBoundingBoxRight:ink.right-dx,
      actualBoundingBoxAscent:-ink.top-offset,actualBoundingBoxDescent:ink.bottom+offset,
      fontBoundingBoxAscent:basic.ascent-offset,fontBoundingBoxDescent:basic.descent+offset,
      alphabeticBaseline:-offset};
    if (!basic.hasBase) {
      metrics.hangingBaseline=basic.ascent*.8-offset;
      metrics.ideographicBaseline=-basic.descent-offset;
    }
    return metrics;
  }
  return Object.freeze({measureText,measureInk,fontBaselineOffset,get heapBytes(){return ck.HEAPU8.buffer.byteLength;},fontCount:resources.length});
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
