/**
 * The model catalog the Rust gateway embeds (crates/pirc-providers/catalog.json),
 * generated from the pinned pi-ai package's catalog (docs/development/historical-records.md).
 *
 * Only providers whose every model uses a wire API the gateway implements are
 * kept (the others could be neither presets nor OAuth catalogs), and `cost`
 * is dropped (the gateway reports zero cost). Base URLs a provider has moved
 * since the pinned release are rewritten through BASE_URL_MOVES.
 *
 *   bun scripts/model-catalog.ts          write the snapshot
 *   bun scripts/model-catalog.ts --check  fail when the snapshot is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const piAi = path.join(root, 'node_modules/@mariozechner/pi-ai');
const output = path.join(root, 'crates/pirc-providers/catalog.json');

export const SUPPORTED_APIS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
]);

type CatalogModel = Record<string, unknown> & { api: string };

/** `provider -> api -> [old, new]` base URL moves applied to the snapshot. */
export const BASE_URL_MOVES: Readonly<
  Record<string, Readonly<Record<string, readonly [string, string]>>>
> = {
  // OpenCode moved Zen/Go from `/zen/...` to per-API `/inference/...` paths.
  'opencode-go': {
    'openai-completions': [
      'https://opencode.ai/zen/go/v1',
      'https://opencode.ai/inference/go/openai/v1',
    ],
    'anthropic-messages': [
      'https://opencode.ai/zen/go',
      'https://opencode.ai/inference/go/anthropic',
    ],
  },
};

function moveBaseUrl(provider: string, model: Record<string, unknown>): Record<string, unknown> {
  const move = BASE_URL_MOVES[provider]?.[String(model.api)];
  return move && model.baseUrl === move[0] ? { ...model, baseUrl: move[1] } : model;
}

export function snapshot(
  version: string,
  providers: readonly string[],
  models: (provider: string) => CatalogModel[],
): string {
  const kept: Record<string, Record<string, unknown>[]> = {};
  for (const provider of providers) {
    const entries = models(provider);
    if (!entries.length || !entries.every((model) => SUPPORTED_APIS.has(model.api))) continue;
    kept[provider] = entries.map(({ cost: _cost, ...model }) => moveBaseUrl(provider, model));
  }
  return `${JSON.stringify({ piAi: version, providers: kept })}\n`;
}

if (import.meta.main) {
  const { version } = JSON.parse(readFileSync(path.join(piAi, 'package.json'), 'utf8')) as {
    version: string;
  };
  const { getModels, getProviders } = (await import(path.join(piAi, 'dist/models.js'))) as {
    getProviders(): string[];
    getModels(provider: string): CatalogModel[];
  };
  const text = snapshot(version, getProviders(), getModels);
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(output, 'utf8');
    } catch {
      /* reported below */
    }
    if (current !== text) {
      console.error(
        `${path.relative(root, output)} is stale; run bun scripts/model-catalog.ts (pi-ai ${version})`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(output, text);
    console.log(`${path.relative(root, output)}: pi-ai ${version}, ${text.length} bytes`);
  }
}
