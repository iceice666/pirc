import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const fixture = 'apps/android/integration_test/document_resource_cancellation_test.dart';
const fixtures = [...readFileSync(path.join(root, fixture), 'utf8').matchAll(/document\(server,\s*'''([\s\S]*?)'''\)/g)].map(m => m[1]);
assert.equal(fixtures.length, 2, 'Extract the actual two Android HTML fixtures');
const require = createRequire(import.meta.url);
const {chromium} = require(require.resolve('playwright-core', {paths:[path.join(root,'apps/gateway')]}));
const requests = [], closed = [], unexpected = [], pageErrors = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push(url.pathname);
  if (url.pathname.startsWith('/fixture-')) {
    const index = Number(url.pathname.slice('/fixture-'.length));
    res.writeHead(200, {'content-type':'text/html; charset=utf-8'});res.end(fixtures[index]);
  } else if (url.pathname.startsWith('/slow-')) {
    res.on('close', () => {if (!res.writableEnded) closed.push(url.pathname);});
  } else if (url.pathname.startsWith('/fast-')) {
    res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});res.end('ready');
  } else if (url.pathname === '/favicon.ico') {res.writeHead(204);res.end();}
  else {unexpected.push(url.pathname);res.writeHead(404);res.end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true, executablePath:requireTestBrowserExecutable(),args:['--disable-background-networking']});
const cases = [];
try {
  for (let index=0;index<fixtures.length;index++) {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('request', request => {if (new URL(request.url()).origin!==origin) unexpected.push(request.url());});
    await page.goto(`${origin}/fixture-${index}`,{waitUntil:'domcontentloaded'});
    const prefix = index===0 ? '/slow-fetch-' : '/slow-xhr-';
    for (let i=0;i<300 && requests.filter(p=>p.startsWith(prefix)).length<6;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(requests.filter(p=>p.startsWith(prefix)).length,6);
    const start = performance.now();
    await page.locator('#cancel').click();
    await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('ready'),null,{timeout:3000});
    for (let i=0;i<300 && closed.filter(p=>p.startsWith(prefix)).length<6;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(closed.filter(p=>p.startsWith(prefix)).length,6);
    const result = JSON.parse(await page.locator('#result').textContent());
    assert.deepEqual(result,index===0 ? {value:'ready',aborts:6,wrong:0}:{aborted:4,timedout:1,reopened:'ready',fast:'ready'});
    cases.push({kind:index===0?'fetch':'xhr',result,closed:closed.filter(p=>p.startsWith(prefix)),milliseconds:performance.now()-start});
    await page.close();
  }
  assert.deepEqual(unexpected,[]);assert.deepEqual(pageErrors,[]);
  const result = {browser:await browser.version(),fixture,origin,cases,requests,closed,unexpected,pageErrors,externalPush:'UNVERIFIED by user choice; no third-party relay request'};
  const output = path.join(root,'apps/android/build/parity-acceptance/document-resource-cancellation-20261016');
  await mkdir(output,{recursive:true});await writeFile(path.join(output,'browser-oracle.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
