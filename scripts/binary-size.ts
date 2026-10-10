/**
 * Release sizes of the Rust executables against their budget
 * (crates/size-budget.json; plans/rust-rewrite.md). Shipped bytes are the
 * point of the rewrite, so a binary over budget fails `bun run size:check`.
 *
 *   bun scripts/binary-size.ts          build, report, fail when over budget
 *   bun scripts/binary-size.ts --no-build   report the existing target/release
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const budgetFile = path.join(root, 'crates/size-budget.json');

export interface Budget {
  /** Maximum size in bytes per executable in target/release. */
  binaries: Record<string, number>;
}

export function overBudget(budget: Budget, sizes: Record<string, number>): string[] {
  return Object.entries(budget.binaries).flatMap(([name, limit]) => {
    const size = sizes[name];
    if (size === undefined) return [`${name}: not built`];
    return size > limit ? [`${name}: ${mib(size)} exceeds its budget of ${mib(limit)}`] : [];
  });
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

if (import.meta.main) {
  const budget = JSON.parse(readFileSync(budgetFile, 'utf8')) as Budget;
  const names = Object.keys(budget.binaries);
  if (!process.argv.includes('--no-build')) {
    const build = Bun.spawnSync(
      ['cargo', 'build', '--release', '--locked', ...names.flatMap((name) => ['--bin', name])],
      { cwd: root, stdout: 'inherit', stderr: 'inherit' },
    );
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  }
  const sizes: Record<string, number> = {};
  for (const name of names) {
    try {
      sizes[name] = statSync(path.join(root, 'target/release', name)).size;
    } catch {
      /* reported as not built */
    }
  }
  for (const name of names)
    console.log(
      `${name.padEnd(16)} ${sizes[name] === undefined ? 'missing' : mib(sizes[name]!)} (budget ${mib(budget.binaries[name]!)})`,
    );
  const failures = overBudget(budget, sizes);
  for (const failure of failures) console.error(failure);
  process.exit(failures.length ? 1 : 0);
}
