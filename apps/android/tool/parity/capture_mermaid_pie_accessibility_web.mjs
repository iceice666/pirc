import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/mermaid-pie-accessibility.json'), 'utf8'),
);
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
assert.equal(fixture.webRevision, revision);
const mermaidPackage = JSON.parse(
  await readFile(resolve(root, 'apps/web/node_modules/mermaid/package.json'), 'utf8'),
);
assert.equal(mermaidPackage.version, fixture.mermaidVersion);
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web'], { cwd: root });
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const output = resolve(root, 'apps/android/build/parity/mermaid-pie-accessibility');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(output, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18919,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'pie-accessibility-oracle',
      configureServer(vite) {
        vite.middlewares.use('/pie.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><body><main id="figure"></main><script type="module">
      import mermaid from 'mermaid';
      mermaid.initialize({startOnLoad:false,securityLevel:'strict'});
      let index=0;
      window.renderPie=async(source)=>{
        document.querySelector('#figure').innerHTML='';
        try {
          const result=await mermaid.render('pie-'+(++index),source);
          document.querySelector('#figure').innerHTML=result.svg;
          const svg=document.querySelector('#figure svg');
          return {status:'ok',description:svg.querySelector('desc')?.textContent??'',title:svg.querySelector('title')?.textContent??'',labelledBy:svg.getAttribute('aria-labelledby'),describedBy:svg.getAttribute('aria-describedby')};
        } catch(error) {return {status:'error',error:String(error?.message??error)};}
      };
    </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/pie.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:18919/pie.html');
  await page.waitForFunction(() => typeof window.renderPie === 'function');
  const cases = [];
  for (const row of fixture.cases) {
    const result = await page.evaluate((source) => window.renderPie(source), row.source);
    cases.push({ id: row.id, source: row.source, ...result });
    assert.equal(result.status, row.error ? 'error' : 'ok', row.id);
    if (!row.error) assert.equal(result.description, row.description, row.id);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(
    resolve(output, 'web.json'),
    JSON.stringify({ revision, browser: browser.version(), cases }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      cases.map(({ id, status, description }) => ({ id, status, description })),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
