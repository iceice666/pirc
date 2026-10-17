import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright-core',{paths:[new URL('../../../gateway/',import.meta.url).pathname]}));
const fixture=await readFile(new URL('../../integration_test/document_resource_fixture.dart',import.meta.url),'utf8');
function raw(name) { const match=fixture.match(new RegExp(String.raw`const ${name}\s*=\s*r\'\'\'([\s\S]*?)\'\'\';`)); if(!match) throw new Error(name); return match[1]; }
const resources=Object.fromEntries([['/library.js','libraryScript'],['/defer.js','deferScript'],['/async.js','asyncScript'],['/dynamic.js','dynamicScript']].map(([url,name])=>[url,raw(name)]));
const expected=(name)=>fixture.match(new RegExp(String.raw`const ${name}\s*=\s*'([^']+)';`))[1];
const requests=[];
let origin, crossOrigin;
async function serve(req,res,isCross) {
 requests.push(`${req.method} ${isCross?'cross':'same'}${req.url}`);
 if(req.url==='/index.html') { res.setHeader('Content-Type','text/html;charset=utf-8'); res.end(raw('resourceHtml').replaceAll('@ORIGIN@',origin).replaceAll('@CROSS@',crossOrigin)); }
 else if(req.url==='/cors') {
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','content-type, x-pirc-test');res.setHeader('Access-Control-Expose-Headers','x-result');res.setHeader('X-Result','visible');
  if(req.method==='OPTIONS') {res.statusCode=204;res.end();return;}
  let data='';for await(const part of req) data+=part;res.setHeader('Content-Type','application/json');res.end(data);
 } else if(req.url==='/empty') {res.statusCode=204;res.end();}
 else if(req.url==='/head') {res.end('HEAD must hide this');}
 else if(req.url==='/api') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:'原生資料'}));}
 else if(req.url==='/denied') {res.end('unreadable');}
 else if(resources[req.url]) {res.setHeader('Content-Type','application/javascript;charset=utf-8');res.end(resources[req.url]);}
 else {res.statusCode=404;res.end('not found');}
}
const primary=http.createServer((q,s)=>serve(q,s,false));const cross=http.createServer((q,s)=>serve(q,s,true));
for(const server of [primary,cross]) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${primary.address().port}`;crossOrigin=`http://127.0.0.1:${cross.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:requireTestBrowserExecutable()});
try {
 const page=await browser.newPage();await page.goto(origin+'/index.html');
 assert.equal(await page.locator('#lifecycle').textContent(),expected('expectedLifecycle'));
 await page.getByRole('button',{name:'Load live data'}).click();
 await page.waitForFunction(()=>document.querySelector('#result').textContent.includes(';dynamic:'));
 console.log('RESULT',await page.locator('#result').textContent());
 assert.equal(await page.locator('#result').textContent(),expected('expectedResult'));
 assert(requests.includes('OPTIONS cross/cors'));assert(requests.includes('POST cross/cors'));
 const result={browser:browser.version(),fixture:'integration_test/document_resource_fixture.dart',lifecycle:await page.locator('#lifecycle').textContent(),result:await page.locator('#result').textContent(),requests};
 const output=new URL('../../build/parity-acceptance/document-resources-20261015/browser-oracle.json',import.meta.url);await mkdir(new URL('.',output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {await browser.close();primary.closeAllConnections();cross.closeAllConnections();await Promise.all([primary,cross].map(s=>new Promise(resolve=>s.close(resolve))));}
