import { requireTestBrowserExecutable } from './test_browser.mjs';
/** Companion to integration_test/native_management_test.dart, isolated helper only.
 * Reads opaque request IDs (no grant/verifier); clicks real consent UI in Chrome.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const observation = path.join(root, '.pirc/flutter-parity-integration/management-observation.json');
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
const seen = new Set();
try {
  const deadline = Date.now() + 180_000;
  while (seen.size < 3 && Date.now() < deadline) {
    const requests = JSON.parse(readFileSync(observation, 'utf8')).requests;
    for (const request of requests) {
      if (seen.has(request.id)) continue;
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await page.goto(`http://127.0.0.1:18894/?nativeManagement=${encodeURIComponent(request.id)}`);
      const dialog = page.getByRole('dialog', { name: 'Review management request' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Approve for 15 minutes' }).click();
      await dialog
        .getByText('Approved. The device can claim temporary access.', { exact: false })
        .waitFor();
      seen.add(request.id);
      if (seen.size === 3) {
        await dialog
          .getByText('has claimed temporary access.', { exact: false })
          .waitFor({ timeout: 30_000 });
        await page.waitForTimeout(1500);
        await dialog.getByRole('button', { name: 'Revoke access' }).click();
        await dialog.getByText('Temporary access was revoked.', { exact: true }).waitFor();
      }
      console.log(
        `Native management browser consent ${seen.size}: passed (${request.capabilities.join(',')})`,
      );
      await page.screenshot({ path: `/private/tmp/pirc-management-browser-${seen.size}.png` });
      await page.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (seen.size !== 3) throw new Error('Timed out waiting for three native consent requests');
} finally {
  await browser.close();
}
