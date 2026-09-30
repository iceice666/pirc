import { statSync } from 'node:fs';

export function findBrowserExecutable(
  explicit: string | undefined,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string | undefined {
  if (explicit) return explicit;
  for (const name of [
    'chromium',
    'chromium-browser',
    'google-chrome-stable',
    'google-chrome',
    'microsoft-edge',
  ]) {
    const found = which(name);
    if (found) return found;
  }
  for (const candidate of [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ])
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not installed */
    }
  return undefined;
}
