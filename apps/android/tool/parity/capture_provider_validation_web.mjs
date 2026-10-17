import { requireTestBrowserExecutable } from './test_browser.mjs';
// Native form constraint oracle from the pinned ProviderEditor input attributes.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/provider-validation.json'), 'utf8'),
);
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web'], { cwd: root });
const source = await readFile(
  resolve(root, 'apps/web/src/lib/components/ProviderEditor.svelte'),
  'utf8',
);
assert.match(source, /type="url"\s+bind:value=\{baseUrl\}/);
assert.match(source, /type="number"\s+min="1"\s+step="1"/);
assert.match(source, /event\.preventDefault\(\);\s+addManual\(\)/);
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(`<form id="form"><input id="url" type="url" required><input id="count" type="number" min="1" step="1"><input id="manual"><button id="save" type="submit">Save</button></form><script>
  window.events=[];window.manualAdds=0;
  form.addEventListener('submit',e=>{e.preventDefault();events.push('submit')});
  form.addEventListener('invalid',e=>events.push('invalid:'+e.target.id),true);
  save.addEventListener('click',()=>events.push('click'));
  manual.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();manualAdds++}});
  </script>`);
  const validity = await page.evaluate(
    (cases) =>
      cases.map(({ name, raw }) => {
        const input = document.querySelector('#url');
        input.value = raw;
        return {
          name,
          raw,
          value: input.value,
          valid: input.validity.valid,
          typeMismatch: input.validity.typeMismatch,
          valueMissing: input.validity.valueMissing,
        };
      }),
    fixture.cases,
  );
  for (let i = 0; i < validity.length; i++)
    assert.equal(validity[i].valid, fixture.cases[i].validity.valid, validity[i].name);
  const numbers = [];
  for (const raw of fixture.typedNumbers) {
    await page.locator('#count').fill('');
    await page.locator('#count').pressSequentially(raw);
    numbers.push(
      await page.locator('#count').evaluate(
        (input, raw) => ({
          raw,
          value: input.value,
          number: Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null,
          valid: input.validity.valid,
          badInput: input.validity.badInput,
          rangeUnderflow: input.validity.rangeUnderflow,
          stepMismatch: input.validity.stepMismatch,
        }),
        raw,
      ),
    );
  }
  assert.deepEqual(numbers, fixture.numberCases);
  const enter = [];
  for (const scenario of [
    { id: 'valid-url', target: 'url', url: 'http://localhost:11434/v1', count: '' },
    { id: 'invalid-url', target: 'url', url: 'http://', count: '' },
    { id: 'fraction', target: 'count', url: 'http://localhost', count: '1.5' },
    { id: 'exponent', target: 'count', url: 'http://localhost', count: '1e3' },
    { id: 'manual', target: 'manual', url: 'http://localhost', count: '' },
    { id: 'disabled', target: 'url', url: 'http://localhost', count: '', disabled: true },
  ]) {
    await page.evaluate((s) => {
      url.value = s.url;
      count.value = s.count;
      save.disabled = !!s.disabled;
      events = [];
      manualAdds = 0;
    }, scenario);
    await page.locator('#' + scenario.target).press('Enter');
    enter.push(await page.evaluate((s) => ({ ...s, events, manualAdds }), scenario));
  }
  assert.deepEqual(
    enter.map((s) => s.events.includes('submit')),
    [true, false, false, true, false, false],
  );
  assert.equal(enter[4].manualAdds, 1);
  const out = resolve(root, 'apps/android/build/parity');
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, 'provider-validation-web.json'),
    JSON.stringify(
      { webRevision: fixture.webRevision, browser: browser.version(), validity, numbers, enter },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${validity.length} URL observations, ${numbers.length} numeric edits, ${enter.length} Enter scenarios`,
  );
} finally {
  await browser.close();
}
