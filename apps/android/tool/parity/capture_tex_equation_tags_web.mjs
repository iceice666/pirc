import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture actual pinned Markdown + KaTeX equation tags, counters, errors, and row geometry.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/tex-equation-tags.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned Web source');
assert.equal(fixture.cases.length, 22, 'unexpected equation-tag case count');
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/tex-equation-tags');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18929,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'tex-equation-tags-oracle',
    configureServer(vite) {
      vite.middlewares.use('/tex-equation-tags.html', async (_, res, next) => {
        try {
          const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>TeX equation tags oracle</title><style>
            html,body{margin:0;min-height:100%;}
            body{overflow:auto!important;}
            #fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;}
          </style></head><body><main id="fixture" class="markdown"></main><script type="module">
            import '/src/app.css';
            import '/src/markdown.css';
            import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';
            const fixture = ${fixtureSource};
            const round = value => Math.round(value * 1000) / 1000;
            const rectOf = element => {
              if (!element) return null;
              const r = element.getBoundingClientRect();
              return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),top:round(r.top),right:round(r.right),bottom:round(r.bottom),left:round(r.left)};
            };
            const labelOf = element => (element?.innerText || element?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,1000);
            const textContentOf = element => (element?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,1000);
            const textRangeRectOf = element => {
              if (!element) return null;
              const range=document.createRange();
              range.selectNodeContents(element);
              return rectOf(range);
            };
            const styleOf = element => {
              if (!element) return null;
              const s = getComputedStyle(element);
              return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,backgroundColor:s.backgroundColor,display:s.display,position:s.position,textAlign:s.textAlign,verticalAlign:s.verticalAlign,margin:s.margin,padding:s.padding,overflowX:s.overflowX,boxSizing:s.boxSizing,counterReset:s.counterReset,counterIncrement:s.counterIncrement};
            };
            const pseudoOf = (element, pseudo='::before') => {
              if (!element) return null;
              const s = getComputedStyle(element,pseudo);
              const content = s.content;
              return {content:content==='none'||content==='normal'?'':content,color:s.color,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,display:s.display,counterIncrement:s.counterIncrement};
            };
            const positiveUnion = boxes => {
              const valid=boxes.filter(box=>box.rect&&box.rect.width>0&&box.rect.height>0);
              if (!valid.length) return null;
              const x=Math.min(...valid.map(box=>box.rect.x)), y=Math.min(...valid.map(box=>box.rect.y));
              const right=Math.max(...valid.map(box=>box.rect.right)), bottom=Math.max(...valid.map(box=>box.rect.bottom));
              return {x:round(x),y:round(y),left:round(x),top:round(y),right:round(right),bottom:round(bottom),width:round(right-x),height:round(bottom-y)};
            };
            const getBaseGeometry = htmlNode => {
              if (!htmlNode) return {baseBoxes:[],baseUnionRect:null};
              const baseBoxes=[...htmlNode.children].filter(element=>element.classList.contains('base')).map((element,index)=>({index,text:labelOf(element),rect:rectOf(element)}));
              return {baseBoxes,baseUnionRect:positiveUnion(baseBoxes)};
            };
            const getNumberNode = element => ({
              domNumberIndex:element.dataset.parityNumberIndex===undefined?null:Number(element.dataset.parityNumberIndex),
              className:element.className,
              textContent:textContentOf(element),
              innerText:labelOf(element),
              rect:rectOf(element),
              style:styleOf(element),
              before:pseudoOf(element,'::before'),
              after:pseudoOf(element,'::after'),
            });
            const getTagNode = element => ({
              className:element.className,
              textContent:textContentOf(element),
              innerText:labelOf(element),
              rect:rectOf(element),
              style:styleOf(element),
              before:pseudoOf(element,'::before'),
              after:pseudoOf(element,'::after'),
              descendants:[...element.querySelectorAll('.eqn-num,.mml-eqn-num')].map(getNumberNode),
              visibleGeneratedContent:[...element.querySelectorAll('.eqn-num,.mml-eqn-num')].map(child=>({domNumberIndex:child.dataset.parityNumberIndex===undefined?null:Number(child.dataset.parityNumberIndex),cssContent:pseudoOf(child,'::before').content})).filter(child=>child.cssContent),
            });
            const getMtableRows = node => [...node.querySelectorAll('.katex-html .mtable')].map((table,tableIndex)=>{
              const columns=[...table.children].filter(element=>typeof element.className==='string'&&element.className.split(' ').some(name=>name.startsWith('col-align-')));
              const anchors=[];
              columns.forEach((column,columnIndex)=>{
                const vlist=column.querySelector(':scope > .vlist-t > .vlist-r > .vlist');
                if (!vlist) return;
                for (const rowAnchor of [...vlist.children]) {
                  if (!rowAnchor.style.top) continue;
                  const rect=rectOf(rowAnchor);
                  const textRect=textRangeRectOf(rowAnchor);
                  const contentBoxes=[...rowAnchor.children].filter(child=>!child.classList.contains('pstrut')).map((child,index)=>({index,className:child.className,text:labelOf(child),rect:rectOf(child)}));
                  anchors.push({columnIndex,topStyle:rowAnchor.style.top,computedTop:getComputedStyle(rowAnchor).top,text:labelOf(rowAnchor),rect,textRect,contentBoxes});
                }
              });
              const groups=new Map();
              for (const anchor of anchors) {
                const key=anchor.topStyle;
                if (!groups.has(key)) groups.set(key,[]);
                groups.get(key).push(anchor);
              }
              const rows=[...groups.entries()].map(([topStyle,items])=>({topStyle,anchors:items,unionRect:positiveUnion(items.map(item=>({rect:item.textRect}))),contentBoxUnionRect:positiveUnion(items.flatMap(item=>item.contentBoxes))})).sort((a,b)=>(a.unionRect?.top??a.anchors[0]?.computedTop??0)-(b.unionRect?.top??b.anchors[0]?.computedTop??0)).map((row,rowIndex)=>({...row,rowIndex}));
              return {tableIndex,rect:rectOf(table),style:styleOf(table),columnCount:columns.length,anchors,rows};
            });
            const getDisplayRowGeometry = display => {
              const htmlNode=display.querySelector('.katex-html');
              const baseGeometry=getBaseGeometry(htmlNode);
              const tableRows=getMtableRows(display);
              const tagRows=[...display.querySelectorAll('.katex-html > .tag')].map((tag,tagIndex)=>({tagIndex,rect:rectOf(tag),style:styleOf(tag),anchors:[...tag.querySelectorAll('.vlist > span[style*="top:"]')].map((element,index)=>{
                const numberNodes=[...element.querySelectorAll('.eqn-num,.mml-eqn-num')].map(getNumberNode);
                const textRect=textRangeRectOf(element);
                const visibleRects=[{rect:textRect},...numberNodes.map(number=>({rect:number.rect}))];
                return {index,topStyle:element.style.top,computedTop:getComputedStyle(element).top,text:labelOf(element),rect:rectOf(element),textRect,visibleContentUnionRect:positiveUnion(visibleRects),numberNodes};
              })}));
              return {baseGeometry,tableRows,tagRows};
            };
            const captureFormula = (node,index) => {
              const isError=node.classList.contains('katex-error');
              const display=node.closest('.katex-display');
              const displayBlock=node.closest('.math-block');
              const paragraph=node.closest('p');
              const htmlNode=isError?node:node.querySelector('.katex-html');
              const annotation=node.querySelector('annotation[encoding="application/x-tex"]')?.textContent??null;
              const redCandidates=htmlNode?[htmlNode,...htmlNode.querySelectorAll('[style]')]:[];
              const redRuns=redCandidates.filter(element=>getComputedStyle(element).color==='rgb(204, 0, 0)').map(element=>({tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',text:labelOf(element),color:getComputedStyle(element).color,style:element.getAttribute('style')}));
              const mathmlRedRuns=[...node.querySelectorAll('mstyle[mathcolor]')].filter(element=>element.getAttribute('mathcolor')?.toLowerCase()==='#cc0000').map(element=>({text:labelOf(element),mathcolor:element.getAttribute('mathcolor')}));
              const tags=[...node.querySelectorAll('.katex-html > .tag')].map(getTagNode);
              const numberNodes=[...node.querySelectorAll('.eqn-num,.mml-eqn-num')].map(getNumberNode);
              const rowGeometry=isError?{baseGeometry:{baseBoxes:[],baseUnionRect:null},tableRows:[],tagRows:[]}:getDisplayRowGeometry(node);
              const baseline=(!display&&!isError&&node.parentElement)?(()=>{
                const marker=document.createElement('span');
                marker.style.cssText='display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;padding:0;margin:0;border:0;';
                node.after(marker);const y=marker.getBoundingClientRect().y;marker.remove();return round(y);
              })():null;
              return {
                index,className:node.className,kind:isError?'whole-expression-parse-error':'rendered',title:node.getAttribute('title'),
                text:labelOf(htmlNode||node),textContent:textContentOf(htmlNode||node),annotation,
                display:!!display,hasMathBlock:!!displayBlock,
                rect:rectOf(node),wrapperRect:rectOf(display||node),displayRect:rectOf(display),katexHtmlRect:rectOf(isError?null:htmlNode),
                paragraphRect:rectOf(paragraph),mathBlockRect:rectOf(displayBlock),style:styleOf(node),displayStyle:styleOf(display),mathBlockStyle:styleOf(displayBlock),baselineY:baseline,
                ...rowGeometry,tags,numberNodes,redRuns,mathmlRedRuns,
                htmlMathMarkup:node.outerHTML,
              };
            };
            const captureStage = async (caseId, stageId, source, scale) => {
              const target=document.querySelector('#fixture');
              target.style.setProperty('--fixture-scale',String(scale));
              target.innerHTML=renderMarkdown(source);
              const rawMarkdownHtml=target.innerHTML;
              await document.fonts.ready;
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              const nodes=[...target.querySelectorAll('.katex,.katex-error')];
              const rawFormulaMarkup=nodes.map(node=>node.outerHTML);
              const numberElements=[...target.querySelectorAll('.eqn-num,.mml-eqn-num')];
              numberElements.forEach((element,index)=>element.dataset.parityNumberIndex=String(index));
              const formulas=nodes.map(captureFormula);
              formulas.forEach((formula,index)=>formula.htmlMathMarkup=rawFormulaMarkup[index]);
              const blocks=[...target.children].map((element,index)=>({index,tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',text:labelOf(element),textContent:textContentOf(element),rect:rectOf(element),style:styleOf(element),children:[...element.children].map(child=>({tag:child.tagName.toLowerCase(),className:typeof child.className==='string'?child.className:'',text:labelOf(child),textContent:textContentOf(child),rect:rectOf(child),style:styleOf(child)}))}));
              const counters=[...target.querySelectorAll('.eqn-num,.mml-eqn-num')].map((element,index)=>({...getNumberNode(element),index,kind:element.classList.contains('eqn-num')?'html-equation-number':'mathml-equation-number',formulaIndex:nodes.findIndex(node=>node.contains(element)),parentTagRect:rectOf(element.closest('.tag'))}));
              return {
                caseId,stageId,source,
                rootRect:rectOf(target),rootStyle:styleOf(target),bodyRect:rectOf(document.body),bodyStyle:styleOf(document.body),bodyCounterReset:getComputedStyle(document.body).counterReset,
                text:labelOf(target),blocks,formulas,counterNodes:counters,
                rawMarkdownHtml,
              };
            };
            window.captureTexTagStage = async (id, stageId, source, scale) => {
              if (!fixture.cases.some(candidate=>candidate.id===id)) throw new Error('Unknown TeX equation-tag fixture case: '+id);
              return captureStage(id,stageId,source,scale);
            };
            await preloadRenderers();
            await document.fonts.ready;
            window.texEquationTagsPageReady=true;
          </script></body></html>`;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/tex-equation-tags.html', html));
        } catch (error) { next(error); }
      });
    },
  }],
});

async function attachRenderedCounterText(cdp, stage) {
  const {root:documentNode}=await cdp.send('DOM.getDocument',{depth:-1});
  const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:documentNode.nodeId,selector:'#fixture .eqn-num, #fixture .mml-eqn-num'});
  const descriptors=await Promise.all(nodeIds.map(nodeId=>cdp.send('DOM.describeNode',{nodeId})));
  await cdp.send('Runtime.evaluate',{expression:`window.__parityKatexAriaStates=[...document.querySelectorAll('#fixture .katex-html')].map(element=>[element,element.hasAttribute('aria-hidden'),element.getAttribute('aria-hidden')]);document.querySelectorAll('#fixture .katex-html').forEach(element=>element.removeAttribute('aria-hidden'));`});
  let accessibility;
  try {
    accessibility=await cdp.send('Accessibility.getFullAXTree');
  } finally {
    await cdp.send('Runtime.evaluate',{expression:`for (const [element,had,value] of window.__parityKatexAriaStates||[]) { if (had) element.setAttribute('aria-hidden',value); else element.removeAttribute('aria-hidden'); } delete window.__parityKatexAriaStates;`});
  }
  const axByNodeId=new Map(accessibility.nodes.map(node=>[String(node.nodeId),node]));
  const renderedByIndex=[];
  for (let index=0;index<descriptors.length;index++) {
    const pseudo=descriptors[index].node.pseudoElements?.find(element=>element.pseudoType==='before');
    if (!pseudo) {
      renderedByIndex[index]={generatedText:'',generatedTextSource:'Chrome Accessibility pseudo node unavailable',pseudoAccessibilityNodeFound:false};
      continue;
    }
    const axPseudo=axByNodeId.get(String(pseudo.backendNodeId)) ?? axByNodeId.get(String(pseudo.nodeId));
    const text=(axPseudo?.childIds??[]).map(childId=>axByNodeId.get(String(childId))).filter(child=>child?.role?.value==='StaticText').map(child=>child.name?.value??'').join('');
    renderedByIndex[index]={generatedText:text,generatedTextSource:'Chrome Accessibility ::before StaticText children after temporarily exposing the actual .katex-html subtree; original aria-hidden restored before screenshot',pseudoAccessibilityNodeFound:!!axPseudo,pseudoBackendNodeId:pseudo.backendNodeId};
  }
  const byIndex=new Map(renderedByIndex.map((value,index)=>[index,value]));
  const visit=value=>{
    if (!value||typeof value!=='object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (Number.isInteger(value.domNumberIndex)&&byIndex.has(value.domNumberIndex)) Object.assign(value,byIndex.get(value.domNumberIndex));
    for (const child of Object.values(value)) visit(child);
  };
  visit(stage);
}

const browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
const configurations=[];
const markupByCaseStage=Object.create(null);
const errors=[];
try {
  await server.listen();
  for (const width of fixture.capture.widths) {
    for (const theme of fixture.capture.themes) {
      for (const textScale of fixture.capture.textScales) {
        const context=await browser.newContext({viewport:{width,height:fixture.capture.height},deviceScaleFactor:fixture.capture.deviceScaleFactor,colorScheme:theme,locale:'en-US'});
        const page=await context.newPage();
        const cdp=await context.newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('Accessibility.enable');
        page.on('pageerror',error=>errors.push(`${width}/${theme}/${textScale}: ${error.stack||error.message}`));
        page.on('console',message=>{if(message.type()==='error') errors.push(`${width}/${theme}/${textScale}: ${message.text()}`)});
        await page.goto('http://127.0.0.1:18929/tex-equation-tags.html',{waitUntil:'load'});
        await page.waitForFunction(()=>window.texEquationTagsPageReady===true);
        const cases=[];
        for (const item of fixture.cases) {
          const sourceStages=[{stageId:'initial',source:item.source},...(item.rerenderSources||[]).map((source,index)=>({stageId:'rerender-'+(index+1),source}))];
          const measured={id:item.id,description:item.description,stages:[]};
          for (const sourceStage of sourceStages) {
            const stage=await page.evaluate(({id,stageId,source,scale})=>window.captureTexTagStage(id,stageId,source,scale),{id:item.id,stageId:sourceStage.stageId,source:sourceStage.source,scale:textScale});
            await attachRenderedCounterText(cdp,stage);
            measured.stages.push(stage);
            const key=`${item.id}/${stage.stageId}`;
            if (markupByCaseStage[key]===undefined) markupByCaseStage[key]={rawMarkdownHtml:stage.rawMarkdownHtml,formulaMarkup:stage.formulas.map(formula=>formula.htmlMathMarkup)};
            else {
              assert.equal(markupByCaseStage[key].rawMarkdownHtml,stage.rawMarkdownHtml,`${key}: raw Markdown output changed across theme/scale/width`);
              assert.deepEqual(markupByCaseStage[key].formulaMarkup,stage.formulas.map(formula=>formula.htmlMathMarkup),`${key}: KaTeX markup changed across theme/scale/width`);
            }
            delete stage.rawMarkdownHtml;
            for (const formula of stage.formulas) delete formula.htmlMathMarkup;
            const screenshot=`tex-equation-tags-${item.id}-${stage.stageId}-${width}-${theme}-scale${textScale}.png`;
            await page.screenshot({path:resolve(outputDir,screenshot),fullPage:true});
            stage.screenshot=`apps/android/build/parity/tex-equation-tags/${screenshot}`;
          }
          cases.push(measured);
        }
        await cdp.detach();
        configurations.push({viewport:{width,height:fixture.capture.height},theme,textScale,deviceScaleFactor:fixture.capture.deviceScaleFactor,font:{family:fixture.capture.paragraphFontFamily,size:fixture.capture.paragraphFontSize,lineHeight:fixture.capture.paragraphLineHeight,katexScale:fixture.capture.katexScale},cases});
        await context.close();
      }
    }
  }
  assert.deepEqual(errors,[],'browser errors');
  assert.equal(configurations.length,8);
  const expected={
    fixture:'fixtures/mobile-parity/tex-equation-tags.json',webRevision:revision,capturedAt:new Date().toISOString(),
    browser:{name:'Google Chrome',version:browser.version(),executable:requireTestBrowserExecutable(),deviceScaleFactor:1,viewportWidths:fixture.capture.widths,height:fixture.capture.height,themes:fixture.capture.themes,textScales:fixture.capture.textScales},
    renderer:fixture.rendererOptions,
    sourceBehavior:{
      markdownRenderer:'All formulas are produced by pinned apps/web/src/lib/markdown.ts renderMarkdown() and pass through its normal DOMPurify flow.',
      htmlEquationNumbers:'KaTeX CSS .katex .eqn-num::before increments katexEqnNo and emits the generated counter string.',
      mathmlEquationNumbers:'KaTeX CSS .katex .mml-eqn-num::before increments mmlEqnNo; the capture records it separately from visible HTML tags.',
      counterReset:'Pinned KaTeX CSS body rule resets katexEqnNo and mmlEqnNo.',
      geometry:'Display wrappers, .katex spans, .katex-html bases, tag boxes, generated counter pseudos, and equation row anchors are captured separately; an empty textContent does not imply no visible CSS-generated number.',
      generatedText:'Chrome Accessibility pseudo-element StaticText children resolve the actual displayed counter number (for example (1)); the harness temporarily removes .katex-html aria-hidden only while reading AX, restores it before screenshot, and retains getComputedStyle(::before).content as the authored counter expression.',
      redErrors:'Computed #cc0000 HTML runs and MathML mathcolor runs are recorded separately from whole-expression .katex-error nodes.',
    },
    caseMarkup:markupByCaseStage,configurations,
  };
  const outputPath=resolve(root,'fixtures/mobile-parity/tex-equation-tags-expected.json');
  await writeFile(outputPath,JSON.stringify(expected,null,2)+'\n');
  const baseline=configurations.find(c=>c.viewport.width===390&&c.theme==='light'&&c.textScale===1);
  const baselineSummary=baseline.cases.map(item=>({
    id:item.id,
    stages:item.stages.map(stage=>({
      stageId:stage.stageId,
      formulaCount:stage.formulas.length,
      formulas:stage.formulas.map(formula=>({
        kind:formula.kind,
        annotation:formula.annotation,
        display:formula.display,
        tags:formula.tags.map(tag=>({textContent:tag.textContent,innerText:tag.innerText,rect:tag.rect,style:tag.style,generated:tag.visibleGeneratedContent})),
        numbers:formula.numberNodes.map(number=>({className:number.className,textContent:number.textContent,innerText:number.innerText,before:number.before,rect:number.rect})),
        rows:formula.tableRows.map(table=>table.rows.map(row=>({rowIndex:row.rowIndex,topStyle:row.topStyle,unionRect:row.unionRect}))),
        rect:formula.rect,
        title:formula.title,
      })),
    })),
  }));
  console.log(JSON.stringify({revision,browser:expected.browser.version,configurations:configurations.length,casesPerConfiguration:fixture.cases.length,totalSnapshots:configurations.reduce((n,c)=>n+c.cases.reduce((sum,item)=>sum+item.stages.length,0),0),outputPath,screenshots:outputDir,baseline390LightScale1:baselineSummary},null,2));
} finally {
  await browser.close();
  await server.close();
}
