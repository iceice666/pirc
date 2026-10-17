import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const { chromium } = require(
  require.resolve('playwright-core', { paths: [gatewayDirectory] }),
);
const browserExecutable = [
  requireTestBrowserExecutable(),
  chromium.executablePath(),
].find(existsSync);
if (browserExecutable == null) {
  throw new Error('No local Chromium or Chrome executable is available.');
}

const html = `<!doctype html><html><body>
<h1>Native script test</h1><div id="items"></div>
<input id="name" value="初始"><button id="increment" type="button">Add item</button>
<p id="result">Count 0</p><button type="button" onclick="document.querySelector('#name').value='Script reset'">Reset field</button>
<script>
let count = 0;
const items = document.querySelector('#items');
['Alpha','Beta','Gamma'].forEach(name => {const p=document.createElement('p');p.textContent=name;items.appendChild(p);});
document.querySelector('#increment').addEventListener('click', () => {
  document.querySelector('#result').textContent = 'Count ' + (++count) + ': ' + document.querySelector('#name').value;
});
</script></body></html>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const initialRows = await page.locator('#items > p').allTextContents();
  assert.deepEqual(initialRows, ['Alpha', 'Beta', 'Gamma']);
  const initialInput = await page.locator('#name').inputValue();
  assert.equal(initialInput, '初始');

  await page.fill('#name', 'Flutter 原生');
  const editedInput = await page.locator('#name').inputValue();
  assert.equal(editedInput, 'Flutter 原生');
  await page.click('#increment');
  const countOne = await page.locator('#result').textContent();
  assert.equal(countOne, 'Count 1: Flutter 原生');
  await page.click('#increment');
  const countTwo = await page.locator('#result').textContent();
  assert.equal(countTwo, 'Count 2: Flutter 原生');
  await page.getByRole('button', { name: 'Reset field' }).click();
  const scriptResetInput = await page.locator('#name').inputValue();
  assert.equal(scriptResetInput, 'Script reset');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_scripts_test.dart',
    assertions: {
      generatedRows: initialRows,
      initialInput,
      editedInput,
      firstClickResult: countOne,
      secondClickResult: countTwo,
      scriptResetInput,
      clickMethod: 'Playwright page.click on #increment',
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-scripts-20261014/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
