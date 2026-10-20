import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { requireTestBrowserExecutable } from './test_browser.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
try {
  if (browser.version() !== '153.0.8010.12') throw Error('Expected pinned Chromium');
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="host"></div>');
  const html = await page.evaluate(() => {
    const host = document.querySelector('#host');
    const range = document.createRange();
    range.selectNodeContents(host);
    window.fragmentRuns = 0;
    const fragment = range.createContextualFragment(
      '<script>window.fragmentRuns += 1<\/script>' +
      '<button id="fragment-button" onclick="window.fragmentRuns += 10">Go</button>',
    );
    const beforeConnect = window.fragmentRuns;
    host.appendChild(fragment);
    const afterConnect = window.fragmentRuns;
    document.querySelector('#fragment-button').click();
    const afterClick = window.fragmentRuns;
    const script = host.querySelector('script');
    script.remove();
    host.appendChild(script);
    return {
      beforeConnect,
      afterConnect,
      afterClick,
      afterMove: window.fragmentRuns,
      rangeContextTag: range.commonAncestorContainer.localName,
      fragmentEmptied: fragment.childNodes.length === 0,
    };
  });
  await page.setContent('<table><tbody id="host"></tbody></table>');
  const table = await page.evaluate(() => {
    const host = document.querySelector('#host');
    const range = document.createRange();
    range.selectNodeContents(host);
    const child = range.createContextualFragment('<tr><td>Cell</td></tr>').firstChild;
    return { tag: child.localName, namespace: child.namespaceURI, text: child.textContent };
  });
  await page.setContent('<svg id="host" xmlns="http://www.w3.org/2000/svg"></svg>');
  const svg = await page.evaluate(() => {
    const host = document.querySelector('#host');
    const range = document.createRange();
    range.selectNodeContents(host);
    const child = range.createContextualFragment('<circle cx="10" cy="10" r="5"/>').firstChild;
    return { tag: child.localName, namespace: child.namespaceURI };
  });
  const fixture = { schemaVersion: 1, browserVersion: browser.version(), html, table, svg };
  await writeFile(
    new URL('./fixtures/document-contextual-fragment-chromium153.json', import.meta.url),
    JSON.stringify(fixture) + '\n',
  );
  console.log(JSON.stringify(fixture));
} finally {
  await browser.close();
}
