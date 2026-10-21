/**
 * The rooms page and the engine keep their own state (plans/rewrite/11-web.md):
 * the rooms never load the engine's sessions, streams and panels, and the
 * engine reaches the rooms only through links. Walks the static imports.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolve(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.ts`, `${base}/index.ts`].find((candidate) =>
    statSync(candidate, { throwIfNoEntry: false })?.isFile(),
  );
}

/** Every module `entry` loads, itself included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [path.resolve(SRC, entry)];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const found = resolve(file, match[1] ?? match[2]!);
      if (found && /\.(ts|svelte)$/.test(found)) todo.push(found);
    }
  }
  return new Set([...seen].map((file) => path.relative(SRC, file)));
}

describe('state boundaries', () => {
  it('finds the modules it walks', () => {
    const rooms = reachable('lib/components/rooms/Rooms.svelte');
    expect(rooms).toContain('lib/rooms.svelte.ts');
    expect(rooms).toContain('lib/room-events.ts');
    // The host's page shows the preferences, as Settings does.
    expect(rooms).toContain('lib/components/MemorySettings.svelte');
    expect(reachable('Engine.svelte')).toContain('lib/engine.svelte.ts');
  });

  it('keeps the engine state out of the rooms page', () => {
    const rooms = reachable('lib/components/rooms/Rooms.svelte');
    expect(
      [...rooms].filter((file) => /engine\.svelte|panel-state|lib\/state\.ts/.test(file)),
    ).toEqual([]);
  });

  it('keeps the rooms state out of the engine', () => {
    const engine = reachable('lib/engine.svelte.ts');
    expect([...engine].filter((file) => /rooms\.svelte|room-events/.test(file))).toEqual([]);
  });
});
