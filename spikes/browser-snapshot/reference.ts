/**
 * Writes target/expected/<page>.yaml: what Playwright itself returns for
 * page.ariaSnapshot({ mode: 'ai' }) (as node/browser.ts calls it), and for the
 * form after filling and submitting it through aria-ref locators.
 * Usage: bun reference.ts <chromium executable>
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '../../apps/gateway/node_modules/playwright-core';

const executablePath = process.argv[2];
if (!executablePath) throw new Error('usage: bun reference.ts <chromium>');
const out = path.join(import.meta.dir, 'target/expected');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
for (const file of readdirSync(path.join(import.meta.dir, 'pages'))) {
  await page.goto(`file://${path.join(import.meta.dir, 'pages', file)}`);
  const snapshot = await page.ariaSnapshot({ mode: 'ai' });
  writeFileSync(path.join(out, file.replace('.html', '.yaml')), snapshot + '\n');
  if (file === 'form.html') {
    const ref = (label: string) => new RegExp(`${label}.*\\[ref=(e\\d+)\\]`).exec(snapshot)![1];
    await page.locator(`aria-ref=${ref('textbox "Name"')}`).fill('Ada');
    await page.locator(`aria-ref=${ref('button "Submit"')}`).click();
    const after = await page.ariaSnapshot({ mode: 'ai' });
    writeFileSync(path.join(out, 'form-submitted.yaml'), after + '\n');
  }
}
await browser.close();
console.log(`wrote ${out}`);
