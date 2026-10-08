/**
 * Supplementary public-benchmark fixtures (docs/evaluations/ptc/ptc-m4-evaluation.md, "Public benchmark"):
 * the Python exercises of the Aider polyglot benchmark (Exercism), pinned to one commit and
 * file hashes, split into a development set (tuning) and a holdout set (judgement) before any
 * tuning. The workspace holds the solution stub and the tests, never the example solution.
 * Success means the pristine tests pass, run in an isolated sandbox without network.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Fixture } from './fixtures.js';
import manifest from './polyglot-manifest.json' with { type: 'json' };

export const POLYGLOT = {
  repository: manifest.repository,
  commit: manifest.commit,
  path: manifest.path,
  /** The split salt, fixed before any tuning: sha256(salt + name)[0] < 128 is development. */
  splitSalt: 'pirc-m4-polyglot:',
} as const;

export const POLYGLOT_NAMES: readonly string[] = Object.keys(manifest.exercises).sort();
export function polyglotSplit(name: string): 'dev' | 'holdout' {
  return createHash('sha256').update(`${POLYGLOT.splitSalt}${name}`).digest()[0]! < 128
    ? 'dev'
    : 'holdout';
}

export interface ExerciseFixture extends Fixture {
  exercise: { name: string; solution: string[]; tests: Record<string, string> };
}
export const isExercise = (fixture: Fixture): fixture is ExerciseFixture =>
  'exercise' in fixture && !!(fixture as ExerciseFixture).exercise;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The fixed prompt: the exercise instructions, then Aider's benchmark wording, then tests. */
function promptFor(
  instructions: string,
  solution: string[],
  tests: string[],
  modules: string[],
): string {
  return `${instructions.trim()}

Use the above instructions to modify the supplied files: ${solution.join(', ')}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard python libraries, don't suggest installing any packages.
The tests are in ${tests.join(', ')}; run them with \`python3 -m unittest -q ${modules.join(' ')}\` and fix the solution until they pass.`;
}

/** Loads one split from a checkout of the pinned commit; every used file must match its pin. */
export async function loadPolyglot(
  root: string,
  split: 'dev' | 'holdout',
): Promise<ExerciseFixture[]> {
  const out: ExerciseFixture[] = [];
  for (const name of POLYGLOT_NAMES) {
    if (polyglotSplit(name) !== split) continue;
    const spec = manifest.exercises[name as keyof typeof manifest.exercises];
    const dir = path.join(root, POLYGLOT.path, name);
    const read = async (file: string) => {
      const text = await readFile(path.join(dir, file), 'utf8');
      if (sha256(text) !== (spec.files as Record<string, string>)[file])
        throw new Error(`Polyglot file pin mismatch: ${name}/${file}`);
      return text;
    };
    const files: Record<string, string> = {};
    for (const file of spec.solution) files[file] = await read(file);
    const tests: Record<string, string> = {};
    for (const file of spec.test) tests[file] = files[file] = await read(file);
    let instructions = await read('.docs/instructions.md');
    if ('.docs/instructions.append.md' in spec.files)
      instructions += `\n\n${await read('.docs/instructions.append.md')}`;
    out.push({
      id: `poly-${name}`,
      kind: 'coding',
      weight: 1,
      prompt: promptFor(instructions, spec.solution, spec.test, spec.testModules),
      files,
      exercise: { name, solution: [...spec.solution], tests },
    });
  }
  return out;
}

/** A failure of the checking sandbox itself: an infrastructure error, never a trial result. */
export class PolyglotSandboxError extends Error {}

/** Runs pristine tests by module name, with /work last on the path (it cannot shadow modules). */
const RUNNER = `import sys, unittest
sys.path.append('/work')
names = sys.argv[1:]
result = unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.loadTestsFromNames(names))
print('POLYGLOT_RESULT', result.testsRun, len(result.failures) + len(result.errors) + len(result.unexpectedSuccesses))
sys.exit(0 if result.wasSuccessful() else 1)
`;

/** Names in a solution that could interfere with the test process; reported, never judged. */
const SUSPICIOUS =
  /\b(unittest|TestCase|_exit|sys\.exit|atexit|sys\.modules|builtins|__import__)\b/;

/** One sandboxed python run: read-only system, no network, no environment, bounded resources. */
async function sandboxed(
  work: string,
  runner: string,
  pythonArgs: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  const args = [
    ...['--user', '--scope', '--quiet', '--collect'],
    ...['-p', 'MemoryMax=1G', '-p', 'TasksMax=128'],
    'bwrap',
    ...['--ro-bind', '/usr', '/usr'],
    ...['--symlink', 'usr/lib', '/lib'],
    ...['--symlink', 'usr/lib', '/lib64'],
    ...['--symlink', 'usr/bin', '/bin'],
    ...['--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp'],
    ...['--bind', work, '/work', '--ro-bind', runner, '/runner'],
    ...['--chdir', '/tmp'],
    ...['--unshare-all', '--die-with-parent', '--new-session', '--clearenv'],
    ...['--setenv', 'PATH', '/usr/bin', '--setenv', 'HOME', '/tmp'],
    ...['/usr/bin/python3', '-I', '-B', '--check-hash-based-pycs', 'always', ...pythonArgs],
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      // Keep the tail: the runner's result line comes last.
      stdout = (stdout + chunk).slice(-65_536);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new PolyglotSandboxError(`Checking sandbox unavailable: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

export interface PolyglotCheck {
  /** Every pinned test ran and passed. */
  passed: boolean;
  testsRun: number | null;
  /** The solution mentions something that could interfere with the tests (for review). */
  suspicious: boolean;
}

/**
 * Runs the exercise's pristine tests against the supplied solution files only, copied as
 * regular files into a fresh directory, in a bubblewrap sandbox inside a resource-limited
 * scope. A pass needs exactly the pinned number of tests to run without failures. A sandbox
 * that cannot run at all is an infrastructure error, not a failed trial.
 */
export async function checkPolyglot(
  workspace: string,
  fixture: ExerciseFixture,
  timeoutMs = 120_000,
): Promise<PolyglotCheck> {
  const spec = manifest.exercises[fixture.exercise.name as keyof typeof manifest.exercises];
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-poly-check-'));
  const work = path.join(root, 'work');
  const runner = path.join(root, 'runner');
  try {
    await mkdir(work);
    await mkdir(runner);
    await writeFile(path.join(runner, 'run.py'), RUNNER);
    // The canary: the sandbox itself must work before a result can mean anything.
    const canary = await sandboxed(work, runner, ['-c', 'print("POLYGLOT_OK")'], 30_000);
    if (canary.code !== 0 || !canary.stdout.includes('POLYGLOT_OK'))
      throw new PolyglotSandboxError('Checking sandbox does not run Python');
    let suspicious = false;
    for (const file of fixture.exercise.solution) {
      let text: Buffer;
      try {
        const handle = await open(
          path.join(workspace, file),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 1024 * 1024)
            return { passed: false, testsRun: null, suspicious };
          text = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch {
        // Missing, a symlink, a directory or a special file: the solution is not there.
        return { passed: false, testsRun: null, suspicious };
      }
      if (SUSPICIOUS.test(text.toString('utf8'))) suspicious = true;
      await writeFile(path.join(work, file), text);
    }
    for (const [file, text] of Object.entries(fixture.exercise.tests))
      await writeFile(path.join(work, file), text);
    const run = await sandboxed(work, runner, ['/runner/run.py', ...spec.testModules], timeoutMs);
    // Exactly one result line, the runner's own (a solution printing one is not a pass).
    const matches = [...run.stdout.matchAll(/POLYGLOT_RESULT (\d+) (\d+)/g)];
    const match = matches.length === 1 ? matches[0] : undefined;
    const testsRun = match ? Number(match[1]) : null;
    return {
      passed: run.code === 0 && !!match && testsRun === spec.testCount && match[2] === '0',
      testsRun,
      suspicious,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The pinned example solution of an exercise (for the preflight, never in a workspace). */
export async function examplePolyglot(root: string, fixture: ExerciseFixture): Promise<string> {
  const spec = manifest.exercises[fixture.exercise.name as keyof typeof manifest.exercises];
  const text = await readFile(
    path.join(root, POLYGLOT.path, fixture.exercise.name, '.meta/example.py'),
    'utf8',
  );
  if (sha256(text) !== (spec.files as Record<string, string>)['.meta/example.py'])
    throw new Error(`Polyglot example pin mismatch: ${fixture.exercise.name}`);
  return text;
}
