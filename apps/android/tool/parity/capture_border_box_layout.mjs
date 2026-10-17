import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {requireTestBrowserExecutable} from './test_browser.mjs';
const require=createRequire(new URL('../../../../apps/gateway/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const colors=['#ef4444','#22c55e','#3b82f6'];
const cases=[];
function add(id,style,options={}) {
 const {width=390,inner='',parent='',css='',tag='div'}=options;
 const target=`<${tag} id="box" style="background:${colors[0]};${style}">${inner}</${tag}>`;
 const content=parent?`<div id="parent" style="background:${colors[2]};${parent}">${target}</div>`:target;
 cases.push({id,viewport:{width,height:900},authoredHTML:`<!doctype html><html><head><style>html,body{margin:0;padding:0;font:16px sans-serif}div,section,article,form{margin:0}*{border-color:#111} ${css}</style></head><body>${content}<div id="after" style="height:8px;background:${colors[1]}"></div></body></html>`});
}
const edges='padding:12px 20px;border:3px solid #111;';
add('fixed-border-box',`box-sizing:border-box;width:240px;height:100px;${edges}`);
add('fixed-content-box-control',`box-sizing:content-box;width:240px;height:100px;${edges}`);
add('border-box-max-width',`box-sizing:border-box;width:320px;max-width:240px;height:100px;${edges}`);
add('border-box-min-width',`box-sizing:border-box;width:120px;min-width:240px;height:100px;${edges}`);
add('border-box-min-wins-max',`box-sizing:border-box;width:160px;min-width:240px;max-width:180px;height:100px;${edges}`);
add('border-box-max-height',`box-sizing:border-box;width:240px;height:160px;max-height:100px;${edges}`);
add('border-box-min-height',`box-sizing:border-box;width:240px;height:60px;min-height:100px;${edges}`);
add('border-box-min-height-wins-max',`box-sizing:border-box;width:240px;height:60px;min-height:100px;max-height:70px;${edges}`);
add('border-box-edge-floor','box-sizing:border-box;width:10px;height:10px;padding:12px 20px;border:3px solid #111');
add('border-box-auto-width',`box-sizing:border-box;height:100px;${edges}`);
add('border-box-auto-max-width',`box-sizing:border-box;max-width:240px;height:100px;${edges}`);
add('border-box-percent-width',`box-sizing:border-box;width:50%;height:100px;${edges}`);
add('border-box-nested-percent',`box-sizing:border-box;width:50%;height:100px;${edges}`,{parent:'box-sizing:border-box;width:320px;padding:10px;border:5px solid #111;'});
add('border-box-percent-padding','box-sizing:border-box;width:80%;height:100px;padding:5%;border:3px solid #111');
add('border-box-auto-height',`box-sizing:border-box;width:240px;${edges}`,{inner:'<div style="height:40px"></div>'});
add('border-box-auto-min-height',`box-sizing:border-box;width:240px;min-height:100px;${edges}`,{inner:'<div style="height:40px"></div>'});
add('border-box-auto-max-height',`box-sizing:border-box;width:240px;max-height:60px;${edges}`,{inner:'<div style="height:100px"></div>'});
add('border-box-font-length',`box-sizing:border-box;width:15em;height:6.25em;${edges}`);
add('border-box-section',`box-sizing:border-box;width:240px;height:100px;${edges}`,{tag:'section'});
add('border-box-article',`box-sizing:border-box;width:240px;height:100px;${edges}`,{tag:'article'});
add('border-box-form',`box-sizing:border-box;width:240px;height:100px;${edges}`,{tag:'form'});
add('border-box-authored-reset',`width:240px;height:100px;${edges}`,{css:'*{box-sizing:border-box}'});
add('border-box-explicit-inherit',`box-sizing:inherit;width:240px;height:100px;${edges}`,{parent:'box-sizing:border-box;width:320px'});
add('border-box-responsive-phone',`box-sizing:border-box;width:100%;max-width:600px;height:100px;${edges}`,{width:390});
add('border-box-responsive-tablet',`box-sizing:border-box;width:100%;max-width:600px;height:100px;${edges}`,{width:768});
add('border-box-asymmetric',`box-sizing:border-box;width:240px;height:100px;padding:7px 19px 11px 13px;border-top:2px solid #111;border-right:4px solid #111;border-bottom:6px solid #111;border-left:8px solid #111`);
add('border-box-grid',`display:grid;grid-template-columns:1fr 1fr;box-sizing:border-box;width:240px;height:100px;${edges}`,{inner:'<div style="height:20px"></div><div style="height:20px"></div>'});
add('border-box-flex',`display:flex;box-sizing:border-box;width:240px;height:100px;${edges}`,{inner:'<div style="height:20px;flex:1"></div><div style="height:20px;flex:1"></div>'});
add('border-box-fixed-margins',`box-sizing:border-box;width:240px;height:100px;margin:0 12px;${edges}`);
add('border-box-auto-margins',`box-sizing:border-box;max-width:240px;height:100px;margin:0 auto;${edges}`);
add('border-box-percent-max',`box-sizing:border-box;width:80%;max-width:60%;height:100px;${edges}`);
add('border-box-wide-overflow',`box-sizing:border-box;width:520px;height:100px;${edges}`);
add('border-box-wide-minimum',`box-sizing:border-box;width:100%;min-width:520px;height:100px;${edges}`);
add('border-box-default-border-floor','box-sizing:border-box;width:1px;height:1px;border:solid #111');
add('border-box-thin-border-floor','box-sizing:border-box;width:1px;height:1px;border:thin solid #111');
add('border-box-thick-border-floor','box-sizing:border-box;width:1px;height:1px;border:thick solid #111');
for(const align of ['flex-start','center','stretch']) {
 add('border-box-column-auto-'+align,`box-sizing:border-box;height:60px;${edges}`,{parent:`display:flex;flex-direction:column;align-items:${align};width:300px`,inner:'<div style="width:80px;height:20px"></div>'});
}
add('border-box-inline-flex-item',`display:inline;box-sizing:border-box;width:100px;height:50px;padding:10px;border:2px solid #111`,{parent:'display:flex;width:300px',tag:'span'});
for(const sizing of ['border-box','content-box']) {
 add('flex-grown-box-'+sizing,`box-sizing:${sizing};width:100px;height:60px;flex:1;${edges}`,{parent:'display:flex;width:300px'});
 add('flex-shrunk-box-'+sizing,`box-sizing:${sizing};width:240px;height:60px;min-width:0;flex:1 1 auto;${edges}`,{parent:'display:flex;width:90px'});
}
const browser=await chromium.launch({executablePath:requireTestBrowserExecutable(),headless:true});
let result;
try {
 const page=await browser.newPage({deviceScaleFactor:1});
 await page.route('**/*',route=>route.abort());
 for(const row of cases) {
  await page.setViewportSize(row.viewport);
  await page.setContent(row.authoredHTML);
  row.result=await page.evaluate(()=>Object.fromEntries(['box','parent','after'].flatMap(id=>{
   const el=document.getElementById(id);if(!el)return [];
   const r=el.getBoundingClientRect(),s=getComputedStyle(el);
   return [[id,{x:r.x,y:r.y,width:r.width,height:r.height,background:s.backgroundColor,boxSizing:s.boxSizing}]];
  })));
 }
 result={schemaVersion:1,webRevision:'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',oracle:'Supplementary font-independent document box geometry; dedicated Headless Shell, all page requests blocked. Frozen Web and prior observations unchanged.',browserVersion:browser.version(),browserExecutable:requireTestBrowserExecutable(),generatedAt:new Date().toISOString(),cases};
} finally {await browser.close();}
await writeFile(new URL('../../../../fixtures/mobile-parity/html-border-box-layout.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,browser:result.browserVersion}));
