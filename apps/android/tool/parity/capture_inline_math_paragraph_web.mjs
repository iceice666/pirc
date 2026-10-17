import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture actual pinned Markdown + KaTeX inline paragraph layout in Chrome.
// Run from the repository root with:
//   node apps/android/tool/parity/capture_inline_math_paragraph_web.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/inline-math-paragraph.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned Web source');
assert.equal(fixture.cases.length, 17, 'unexpected inline-math paragraph case count');
assert.deepEqual(fixture.capture.widths, [390, 650, 651, 768, 860, 861, 1024]);
assert.deepEqual(fixture.capture.themes, ['light', 'dark']);
assert.deepEqual(fixture.capture.textScales, [1, 2]);
execFileSync(
  'git',
  ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root },
);

const katexPackage = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/katex/package.json'), 'utf8'),
);
assert.equal(katexPackage.version, '0.16.47', 'unexpected local KaTeX version');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/inline-math-paragraph-web');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const configFilter = process.env.PIRC_INLINE_MATH_CAPTURE_CONFIG;
const caseFilter = process.env.PIRC_INLINE_MATH_CAPTURE_CASE;
const casesToCapture = caseFilter
  ? fixture.cases.filter(item => item.id === caseFilter)
  : fixture.cases;
assert.notEqual(casesToCapture.length, 0, `unknown case filter: ${caseFilter}`);
const selectedConfigurations = [];
for (const width of fixture.capture.widths) {
  for (const theme of fixture.capture.themes) {
    for (const textScale of fixture.capture.textScales) {
      const id = `${width}-${theme}-${textScale}`;
      if (!configFilter || configFilter === id) selectedConfigurations.push({ id, width, theme, textScale });
    }
  }
}
assert.notEqual(selectedConfigurations.length, 0, `unknown configuration filter: ${configFilter}`);
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18944,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'inline-math-paragraph-oracle',
      configureServer(vite) {
        vite.middlewares.use('/inline-math-paragraph.html', async (_, res, next) => {
          try {
            const html = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>Inline math paragraph oracle</title>
<style>
html,body{margin:0;min-height:100%;}
body{overflow:auto!important;}
#fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;}
#gallery{box-sizing:border-box;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;}
.gallery-case{padding:12px 0 16px;border-bottom:1px dashed var(--line-dark);}
.gallery-case h2{margin:0 0 8px;font:600 12px/1.4 ui-monospace,monospace;color:var(--text-2);}
.gallery-case .source{margin:0 0 6px;padding:4px 6px;border-radius:4px;background:var(--bg-subtle);font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;}
#gallery[hidden],#fixture[hidden]{display:none!important;}
</style></head><body>
<main id="fixture" class="markdown"></main><main id="gallery" hidden></main>
<script type="module">
import '/src/app.css';
import '/src/markdown.css';
import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';
const fixture = ${fixtureSource};
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const rectValue = rect => rect ? ({x:round(rect.x),y:round(rect.y),width:round(rect.width),height:round(rect.height),top:round(rect.top),right:round(rect.right),bottom:round(rect.bottom),left:round(rect.left)}) : null;
const rectOf = element => element ? rectValue(element.getBoundingClientRect()) : null;
const rangeRects = range => [...range.getClientRects()].map(rectValue);
const rangeOf = element => {
  if (!element) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  return {bounds:rectValue(range.getBoundingClientRect()),clientRects:rangeRects(range)};
};
const styleOf = element => {
  if (!element) return null;
  const style = getComputedStyle(element);
  return {fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,fontStyle:style.fontStyle,lineHeight:style.lineHeight,color:style.color,backgroundColor:style.backgroundColor,display:style.display,verticalAlign:style.verticalAlign,whiteSpace:style.whiteSpace,overflowWrap:style.overflowWrap,margin:style.margin,padding:style.padding,textAlign:style.textAlign};
};
const labelOf = element => (element?.innerText || element?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,1600);
const textOf = element => element?.textContent ?? '';
const tagOf = element => ({tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',id:element.id||null});
const ancestorsOf = (element,root) => {
  const result=[];
  for(let current=element;current&&current!==root;current=current.parentElement) result.push(tagOf(current));
  return result;
};
const baselineProbe = element => {
  if (!element || element.closest('.katex-display')) return null;
  const marker=document.createElement('span');
  marker.setAttribute('data-inline-math-baseline-probe','');
  marker.style.cssText='display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;padding:0;margin:0;border:0;';
  element.after(marker);
  const markerRect=rectOf(marker);
  const owner=element.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote')||element.parentElement;
  const ownerRect=rectOf(owner);
  marker.remove();
  return {markerRect,offsetFromOwnerTop:markerRect&&ownerRect?round(markerRect.top-ownerRect.top):null,method:'zero-size inline-block inserted immediately after the rendered math node'};
};
const wordRanges = block => {
  if(!block) return [];
  const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
  const words=[];
  let textNode;
  while((textNode=walker.nextNode())) {
    const parent=textNode.parentElement;
    if(!parent||parent.closest('.katex,.katex-error,.katex-mathml,script,style,annotation')) continue;
    const source=textNode.nodeValue||'';
    const pattern=/\S+/gu;
    for(const match of source.matchAll(pattern)) {
      const start=match.index??0;
      const range=document.createRange();
      range.setStart(textNode,start);
      range.setEnd(textNode,start+match[0].length);
      words.push({text:match[0],start,end:start+match[0].length,rects:rangeRects(range)});
    }
  }
  return words;
};
const mathKind = (node,redText) => node.classList.contains('katex-error')?'whole-expression-error':redText.length?'rendered-with-unsupported-command':'rendered';
const redRunsOf = node => {
  const candidates=[node,...node.querySelectorAll('*')];
  const seen=new Set();
  const runs=[];
  for(const element of candidates) {
    if(getComputedStyle(element).color!=='rgb(204, 0, 0)') continue;
    const text=(element.innerText||element.textContent||'').replace(/\s+/g,' ').trim();
    if(!text||seen.has(text)) continue;
    seen.add(text);
    runs.push({text,tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',rect:rectOf(element),style:styleOf(element)});
  }
  return runs;
};
const captureMathNode = (node,index,root) => {
  const error=node.classList.contains('katex-error');
  const htmlNode=error?node:node.querySelector('.katex-html');
  const displayNode=node.closest('.katex-display');
  const baseSpans=htmlNode?[...htmlNode.children].filter(child=>typeof child.className==='string'&&child.classList.contains('base')).map((base,baseIndex)=>({index:baseIndex,text:labelOf(base),rect:rectOf(base),rangeBounds:rangeOf(base)?.bounds??null})):[];
  const tags=htmlNode?[...htmlNode.children].filter(child=>typeof child.className==='string'&&child.classList.contains('tag')).map((tag,tagIndex)=>({index:tagIndex,text:labelOf(tag),rect:rectOf(tag),rangeBounds:rangeOf(tag)?.bounds??null,style:styleOf(tag),numberNodes:[...tag.querySelectorAll('.eqn-num,.mml-eqn-num')].map(number=>({text:labelOf(number),rect:rectOf(number),style:styleOf(number)}))})):[];
  const redRuns=redRunsOf(node);
  const annotation=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent??null;
  const owner=node.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote')||node.parentElement;
  const htmlRangeBounds=htmlNode?rangeOf(htmlNode)?.bounds??null:null;
  return {
    index,kind:mathKind(node,redRuns),className:node.className,annotation,visibleText:labelOf(htmlNode),
    isDisplay:!!displayNode,rect:rectOf(node),style:styleOf(node),
    displayWrapper:displayNode?{tag:tagOf(displayNode),rect:rectOf(displayNode),style:styleOf(displayNode)}:null,
    htmlRect:rectOf(htmlNode),htmlStyle:styleOf(htmlNode),htmlRangeBounds,baseSpans,tags,redRuns,baseline:baselineProbe(node),
    owner:owner?tagOf(owner):null,
    contextAncestors:ancestorsOf(node,root),
  };
};
const captureTextBlock = (block,index) => {
  const range=rangeOf(block);
  const inlineElements=[...block.querySelectorAll('strong,b,em,i,a,code,span')]
    .filter(element=>!element.matches('.katex,.katex-error,.katex-mathml')&&!element.closest('.katex,.katex-error,.katex-mathml'))
    .map(element=>({tag:tagOf(element),text:labelOf(element),rect:rectOf(element),style:styleOf(element)}));
  return {
    index,tag:tagOf(block),innerText:block.innerText||'',rect:rectOf(block),style:styleOf(block),
    lineRects:range?.clientRects??[],rangeBounds:range?.bounds??null,wordRanges:wordRanges(block),inlineElements,
    contextAncestors:ancestorsOf(block,document.querySelector('#fixture')),
  };
};
window.captureInlineMathCase=async(id,scale)=>{
  const item=fixture.cases.find(candidate=>candidate.id===id);
  if(!item) throw new Error('Unknown inline math fixture case: '+id);
  const target=document.querySelector('#fixture');
  target.hidden=false;
  document.querySelector('#gallery').hidden=true;
  target.style.setProperty('--fixture-scale',String(scale));
  target.innerHTML=renderMarkdown(item.source);
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const nodeList=[...target.querySelectorAll('.katex,.katex-error')];
  const mathNodes=nodeList.map((node,index)=>captureMathNode(node,index,target));
  const kinds=mathNodes.map(node=>node.kind);
  assertMathCount(item,mathNodes,kinds);
  const candidateSelector='p,h1,h2,h3,h4,h5,h6,li,td,th';
  const candidates=[...target.querySelectorAll(candidateSelector)].filter(element=>(element.innerText||'').trim());
  const candidateSet=new Set(candidates);
  const containers=candidates.filter(element=>![...element.querySelectorAll(candidateSelector)].some(child=>candidateSet.has(child)));
  if(containers.length===0&&(target.innerText||'').trim())containers.push(target);
  const textBlocks=containers.map(captureTextBlock);
  const actualAncestorTags=new Set(mathNodes.flatMap(math=>math.contextAncestors.map(ancestor=>ancestor.tag)));
  if(item.expectedAncestor&&!actualAncestorTags.has(item.expectedAncestor)) throw new Error(item.id+': expected ancestor '+item.expectedAncestor+', got '+JSON.stringify([...actualAncestorTags]));
  if(item.expectedDisplay&&!sameArray(mathNodes.map(math=>math.isDisplay),item.expectedDisplay)) throw new Error(item.id+': display flags differ '+JSON.stringify(mathNodes.map(math=>math.isDisplay)));
  const annotations=mathNodes.map(math=>math.annotation);
  if(item.expectedAnnotations&&!sameArray(annotations,item.expectedAnnotations)) throw new Error(item.id+': annotations differ '+JSON.stringify(annotations));
  const tagTexts=mathNodes.flatMap(math=>math.tags.map(tag=>tag.text));
  if(item.expectedTagText&&!sameArray(tagTexts,item.expectedTagText)) throw new Error(item.id+': tag text differs '+JSON.stringify(tagTexts));
  const redText=mathNodes.flatMap(math=>math.redRuns.map(run=>run.text));
  for(const expected of item.expectedRedTextIncludes||[])if(!redText.some(text=>text.includes(expected)))throw new Error(item.id+': expected red text '+JSON.stringify(expected)+' in '+JSON.stringify(redText));
  const selection=window.getSelection();
  selection.removeAllRanges();
  const selectRange=document.createRange();
  selectRange.selectNodeContents(target);
  selection.addRange(selectRange);
  const copySelectionText=selection.toString();
  selection.removeAllRanges();
  const rootInnerText=target.innerText||'';
  for(const expected of item.expectedTextIncludes||[])if(!rootInnerText.includes(expected))throw new Error(item.id+': expected rendered text '+JSON.stringify(expected)+' in '+JSON.stringify(rootInnerText));
  const topLevelBlocks=[...target.children].map((element,index)=>({index,...tagOf(element),rect:rectOf(element)}));
  return {
    id:item.id,source:item.source,expectedMathCount:item.expectedMathCount,expectedKinds:item.expectedKinds,
    viewport:{width:innerWidth,height:innerHeight},rootRect:rectOf(target),rootStyle:styleOf(target),
    rootInnerText,copySelectionText,
    topLevelBlocks,textBlocks,mathNodes,
    validation:{actualKinds:kinds,actualAnnotations:annotations,actualTags:tagTexts,actualAncestorTags:[...actualAncestorTags]},
    renderedHtml:target.innerHTML,
  };
};
function sameArray(actual,expected){return JSON.stringify(actual)===JSON.stringify(expected);}
function assertMathCount(item,nodes,kinds){
  if(nodes.length!==item.expectedMathCount)throw new Error(item.id+': expected '+item.expectedMathCount+' math nodes, got '+nodes.length);
  if(!sameArray(kinds,item.expectedKinds))throw new Error(item.id+': expected kinds '+JSON.stringify(item.expectedKinds)+', got '+JSON.stringify(kinds));
}
window.renderInlineMathGallery=async(scale,caseIds)=>{
  const target=document.querySelector('#fixture');
  const gallery=document.querySelector('#gallery');
  target.hidden=true;
  gallery.hidden=false;
  gallery.style.setProperty('--fixture-scale',String(scale));
  gallery.replaceChildren();
  for(const item of fixture.cases.filter(candidate=>caseIds.includes(candidate.id))){
    const section=document.createElement('section');
    section.className='gallery-case';
    const heading=document.createElement('h2');
    heading.textContent=item.id;
    const source=document.createElement('pre');
    source.className='source';
    source.textContent=item.source;
    const body=document.createElement('div');
    body.className='markdown';
    body.innerHTML=renderMarkdown(item.source);
    section.append(heading,source,body);
    gallery.append(section);
  }
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
};
await preloadRenderers();
await document.fonts.ready;
window.inlineMathParagraphPageReady=true;
</script></body></html>`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await vite.transformIndexHtml('/inline-math-paragraph.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
const configurations = [];
const renderedMarkupByCase = Object.create(null);
const errors = [];
try {
  await server.listen();
  for (const { id: configurationId, width, theme, textScale } of selectedConfigurations) {
        const context = await browser.newContext({
          viewport: { width, height: fixture.capture.height },
          deviceScaleFactor: fixture.capture.deviceScaleFactor,
          colorScheme: theme,
          locale: 'en-US',
        });
        const page = await context.newPage();
        const contextName = `${width}/${theme}/${textScale}`;
        page.on('pageerror', error => errors.push(`${contextName}: ${error.stack || error.message}`));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(`${contextName}: ${message.text()}`);
        });
        await page.goto('http://127.0.0.1:18944/inline-math-paragraph.html', { waitUntil: 'load' });
        await page.waitForFunction(() => window.inlineMathParagraphPageReady === true);
        const cases = [];
        let configRootRect = null;
        let configRootStyle = null;
        for (const item of casesToCapture) {
          const measured = await page.evaluate(
            ({ id, scale }) => window.captureInlineMathCase(id, scale),
            { id: item.id, scale: textScale },
          );
          assert.equal(measured.id, item.id);
          if (renderedMarkupByCase[item.id] === undefined) {
            renderedMarkupByCase[item.id] = measured.renderedHtml;
          } else {
            assert.equal(
              renderedMarkupByCase[item.id],
              measured.renderedHtml,
              `${item.id}: renderMarkdown HTML changed across theme/scale/width`,
            );
          }
          delete measured.renderedHtml;
          if (configRootRect === null) {
            configRootRect = measured.rootRect;
            configRootStyle = measured.rootStyle;
          }
          delete measured.source;
          delete measured.expectedMathCount;
          delete measured.expectedKinds;
          delete measured.viewport;
          delete measured.rootRect;
          delete measured.rootStyle;
          cases.push(measured);
        }
        await page.evaluate(
          ({ scale, caseIds }) => window.renderInlineMathGallery(scale, caseIds),
          { scale: textScale, caseIds: casesToCapture.map(item => item.id) },
        );
        const screenshot = `inline-math-paragraph-${width}-${theme}-scale${textScale}.png`;
        await page.screenshot({ path: resolve(outputDir, screenshot), fullPage: true });
        configurations.push({
          id: configurationId,
          viewport: { width, height: fixture.capture.height },
          theme,
          textScale,
          deviceScaleFactor: fixture.capture.deviceScaleFactor,
          paragraphFont: {
            family: fixture.capture.paragraphFontFamily,
            size: fixture.capture.paragraphFontSize * textScale,
            lineHeightMultiplier: fixture.capture.paragraphLineHeight,
          },
          rootRect: configRootRect,
          rootStyle: configRootStyle,
          cases,
          galleryScreenshot: `apps/android/build/parity/inline-math-paragraph-web/${screenshot}`,
        });
        await context.close();
  }
  assert.deepEqual(errors, [], 'unexpected browser errors');
  if (!configFilter && !caseFilter) assert.equal(configurations.length, 28);
  assert.equal(
    configurations.reduce((count, configuration) => count + configuration.cases.length, 0),
    selectedConfigurations.length * casesToCapture.length,
  );
  const expected = {
    fixture: 'fixtures/mobile-parity/inline-math-paragraph.json',
    webRevision: revision,
    capturedAt: new Date().toISOString(),
    browser: {
      name: 'Google Chrome',
      version: browser.version(),
      executable: requireTestBrowserExecutable(),
      deviceScaleFactor: fixture.capture.deviceScaleFactor,
      viewportWidths: fixture.capture.widths,
      height: fixture.capture.height,
      themes: fixture.capture.themes,
      textScales: fixture.capture.textScales,
      selection: { configuration: configFilter ?? 'all', case: caseFilter ?? 'all' },
    },
    renderer: {
      ...fixture.rendererOptions,
      katexVersion: katexPackage.version,
      sourceModule: 'apps/web/src/lib/markdown.ts renderMarkdown()',
    },
    sourceBehavior: {
      paragraphLayout: 'The actual sanitized renderMarkdown HTML is laid out under apps/web/src/app.css and apps/web/src/markdown.css in Chromium.',
      inlineFormulaWrap: 'Each .katex-html > .base has its actual DOMRect and Range client rects. KaTeX bases are unbreakable units; positions across successive bases reveal browser line wrapping.',
      textGeometry: 'Non-math text word ranges and each containing prose block Range report browser client rectangles.',
      baseline: 'Inline formula baseline is probed with a zero-size inline-block immediately after the rendered formula; display formulas have no inline baseline probe.',
      copyText: 'copySelectionText is the actual DOM Selection.toString() over the rendered message, separate from textContent and innerText.',
      screenshots: 'One gallery screenshot per configuration shows all source cases; gallery headings and separators are capture-only scaffolding and are excluded from measured case geometry.',
    },
    schemaNotes: {
      rectangles: '[x, y, width, height] in CSS pixels; rounded to 0.001px. Parent-block lineRects and wordRanges are actual Range.getClientRects() results.',
      markup: 'renderedMarkupByCase stores renderMarkdown innerHTML exactly once per source case; source text and expected assertions live in the input fixture.',
      repeatedStyles: 'Page-root style is stored once per configuration; text-block style once per block; inline style snapshots cover emphasis, links, code, and raw spans; individual word ranges omit repeated parent styles.',
    },
    renderedMarkupByCase,
    configurations,
  };
  const outputPath = configFilter || caseFilter
    ? resolve(outputDir, `smoke-${configFilter ?? 'all'}-${caseFilter ?? 'all'}.json`)
    : resolve(root, 'fixtures/mobile-parity/inline-math-paragraph-expected.json');
  const compactRectangles = value => {
    if (Array.isArray(value)) return value.map(compactRectangles);
    if (!value || typeof value !== 'object') return value;
    const rectKeys = ['x','y','width','height','top','right','bottom','left'];
    if (rectKeys.every(key => typeof value[key] === 'number') && Object.keys(value).length === rectKeys.length) {
      return [value.x,value.y,value.width,value.height];
    }
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,compactRectangles(child)]));
  };
  const compactExpected = compactRectangles(expected);
  await writeFile(outputPath, JSON.stringify(compactExpected) + '\n');
  const baselineConfiguration =
    configurations.find(configuration => configuration.id === '390-light-2') ?? configurations[0];
  console.log(
    JSON.stringify(
      {
        revision,
        browser: expected.browser.version,
        configurations: configurations.length,
        casesPerConfiguration: casesToCapture.length,
        totalCaptures: configurations.reduce((count, configuration) => count + configuration.cases.length, 0),
        outputPath,
        screenshots: outputDir,
        baselineConfiguration: baselineConfiguration.id,
        baselineCases: baselineConfiguration.cases.map(item => ({
            id: item.id,
            rootText: item.rootInnerText.slice(0, 120),
            blocks: item.textBlocks.map(block => ({ tag: block.tag.tag, rect: block.rect, lineRangeRects: block.lineRects.length })),
            math: item.mathNodes.map(node => ({ kind: node.kind, display: node.isDisplay, rect: node.rect, baseline: node.baseline?.markerRect, bases: node.baseSpans.map(base => base.rect), tags: node.tags.map(tag => tag.text) })),
          })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
