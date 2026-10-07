/**
 * Static shell-command classifier for auto mode. It decides, without a model,
 * whether a command only reads, writes inside the workspace, is dangerous, or
 * cannot be judged statically (`unknown`, handed to the model classifier).
 *
 * The rules err on the side of `unknown`: anything the lexer does not fully
 * understand (command substitution, heredocs, interpreters, unresolvable
 * paths) is never declared `read`.
 */
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realResolve } from '../sandbox.js';

export type Verdict = 'read' | 'write' | 'danger' | 'unknown';

export interface Classification {
  verdict: Verdict;
  reason: string;
  /** Danger because of the user's deny-list (holds even with auto mode disabled). */
  denied?: true;
  /**
   * With verdict `write`: every path the command writes, when the rules know
   * all of them (`mkdir /tmp/x`, `cmd > out.txt`). Absent when any write has
   * no known target (`git commit`, `npm install`), so the write lease falls
   * back to the whole workspace.
   */
  writes?: string[];
}

export interface RuleContext {
  /** Directory the command starts in. */
  cwd: string;
  /** Canonical roots the agent may write (workspace and allowed paths). */
  roots: readonly string[];
  /** Paths the agent may never write (its own configuration). */
  protectedPaths?: readonly string[];
  home?: string;
  /**
   * The user's deny-list ({@link compileDeny}): a command (or a package
   * script, make/just recipe or shell script it runs) matching any pattern is
   * `danger`, whatever else the rules say.
   */
  deny?: readonly RegExp[];
}

const RANK: Record<Verdict, number> = { read: 0, write: 1, unknown: 2, danger: 3 };

function worst(a: Classification, b: Classification): Classification {
  // Two writes: their targets are known only if both are.
  if (a.verdict === 'write' && b.verdict === 'write') {
    if (a.writes && b.writes) return { ...a, writes: [...a.writes, ...b.writes] };
    return a.writes ? b : a;
  }
  return RANK[b.verdict] > RANK[a.verdict] ? b : a;
}

const read = (reason = 'read-only command'): Classification => ({ verdict: 'read', reason });
const write = (reason: string): Classification => ({ verdict: 'write', reason });
const danger = (reason: string): Classification => ({ verdict: 'danger', reason });
const unknown = (reason: string): Classification => ({ verdict: 'unknown', reason });

// ---------------------------------------------------------------------------
// Lexer

interface Word {
  text: string;
  quoted: boolean;
  /** Contains an unresolved expansion (`$VAR`, globs, braces); its value is not known statically. */
  dynamic: boolean;
  /** Starts with an unquoted `~` (tilde expansion applies). */
  tilde?: boolean;
}

interface Redirect {
  op: string;
  target: Word | undefined;
}

interface Command {
  words: Word[];
  redirects: Redirect[];
}

/** Commands joined by `|`; pipelines are joined by `;`, `&&`, `||`, `&` or newlines. */
type Pipeline = Command[];

type Lexed = { pipelines: Pipeline[] } | { complex: string };

export function lex(source: string): Lexed {
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let command: Command = { words: [], redirects: [] };
  let word: Word | null = null;
  let pending: string | null = null;

  const current = (): Word => (word ??= { text: '', quoted: false, dynamic: false });
  const pushWord = () => {
    if (!word) return;
    if (pending) {
      command.redirects.push({ op: pending, target: word });
      pending = null;
    } else command.words.push(word);
    word = null;
  };
  const endCommand = () => {
    pushWord();
    if (pending) {
      command.redirects.push({ op: pending, target: undefined });
      pending = null;
    }
    if (command.words.length || command.redirects.length) pipeline.push(command);
    command = { words: [], redirects: [] };
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '\\') {
      if (next === '\n') i += 2;
      else {
        current().text += next ?? '';
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return { complex: 'unterminated quote' };
      const target = current();
      target.text += source.slice(i + 1, end);
      target.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const target = current();
      target.quoted = true;
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        const ch = source[j]!;
        if (ch === '\\' && j + 1 < source.length) {
          target.text += source[j + 1];
          j += 2;
          continue;
        }
        if (ch === '`' || (ch === '$' && source[j + 1] === '('))
          return { complex: 'command substitution' };
        if (ch === '$') target.dynamic = true;
        target.text += ch;
        j++;
      }
      if (j >= source.length) return { complex: 'unterminated quote' };
      i = j + 1;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) return { complex: 'command substitution' };
    if ((c === '<' || c === '>') && next === '(') return { complex: 'process substitution' };
    if (c === '#' && !word) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      endPipeline();
      i++;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        endPipeline();
        i += 2;
        continue;
      }
      if (next === '>') {
        pushWord();
        pending = source[i + 2] === '>' ? '&>>' : '&>';
        i += pending.length;
        continue;
      }
      endPipeline();
      i++;
      continue;
    }
    if (c === '|') {
      if (next === '|') {
        endPipeline();
        i += 2;
        continue;
      }
      endCommand();
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<') {
      let fd = '';
      // TS narrows `word` to null here; closures above reassign it.
      const last = word as Word | null;
      if (last && !last.quoted && /^\d+$/.test(last.text)) {
        fd = last.text;
        word = null;
      } else pushWord();
      if (c === '<' && next === '<') return { complex: 'heredoc' };
      let op: string = c;
      i++;
      if (c === '>' && (source[i] === '>' || source[i] === '|')) op += source[i++];
      if (source[i] === '&') {
        i++;
        let dup = '';
        while (i < source.length && /[0-9-]/.test(source[i]!)) dup += source[i++];
        if (dup) continue; // `2>&1`, `>&2`: fd duplication, no file involved
        op = '&>';
      }
      pending = fd + op;
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      i++;
      continue;
    }
    if (c === '~' && !word) current().tilde = true;
    if (c === '$' || c === '*' || c === '?' || c === '[' || c === '{') current().dynamic = true;
    current().text += c;
    i++;
  }
  endPipeline();
  return { pipelines };
}

// ---------------------------------------------------------------------------
// Paths

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const SCRATCH = [...new Set(['/tmp', '/private/tmp', '/var/tmp', os.tmpdir()])].map((item) =>
  realResolve(item),
);
const HARMLESS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** Credential stores under $HOME; touching them (even reading) needs a human. */
const SECRET_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.docker/config.json',
  '.kube',
  '.config/gh',
  '.config/gcloud',
  '.azure',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.password-store',
];
const SECRET_SYSTEM_PATHS = ['/etc/shadow', '/etc/sudoers', '/etc/master.passwd'];

class Paths {
  readonly home: string;
  private readonly roots: string[];
  private readonly protectedRoots: string[];
  private readonly secrets: string[];
  constructor(context: RuleContext) {
    this.home = context.home ?? os.homedir();
    this.roots = context.roots.map((root) => realResolve(root));
    this.protectedRoots = (context.protectedPaths ?? []).map((item) => realResolve(item));
    // Resolved like the paths they are compared with (`/etc` is `/private/etc` on macOS).
    this.secrets = [
      ...new Set([
        ...SECRET_HOME_PATHS.map((item) => realResolve(path.join(this.home, item))),
        ...SECRET_SYSTEM_PATHS,
        ...SECRET_SYSTEM_PATHS.map((item) => realResolve(item)),
      ]),
    ];
  }

  /**
   * A word's text after the expansions known statically: a leading `~`, and a
   * leading `$HOME` / `$PWD`. Undefined for `~user` and friends.
   */
  private expand(word: Word, cwd: string | undefined): string | undefined {
    let text = word.text;
    if (word.tilde) {
      if (text === '~' || text.startsWith('~/')) text = this.home + text.slice(1);
      else return undefined; // ~user, ~+, ~-
    }
    if (word.dynamic) {
      const known = /^\$(?:\{(HOME|PWD)\}|(HOME|PWD)(?![A-Za-z0-9_]))/.exec(text);
      if (known) {
        const name = known[1] ?? known[2];
        if (name === 'PWD' && !cwd) return undefined;
        text = (name === 'HOME' ? this.home : cwd!) + text.slice(known[0].length);
      }
    }
    return text;
  }

  /** Absolute path of a word, or undefined when it cannot be known statically. */
  resolve(word: Word, cwd: string | undefined): string | undefined {
    let text = this.expand(word, cwd);
    if (text === undefined || (word.dynamic && /[$*?[{]/.test(text))) return undefined;
    if (!path.isAbsolute(text)) {
      if (!cwd) return undefined;
      text = path.resolve(cwd, text);
    }
    return realResolve(text);
  }

  /**
   * For an operand {@link resolve} cannot pin down: why its expansion might
   * reach credentials (a variable, `..` after a glob, or a literal prefix that
   * a secret path extends), or undefined when every expansion stays clear of
   * them (`src/*.ts`, `~/code/*`).
   */
  unresolvedRisk(word: Word, cwd: string | undefined): string | undefined {
    const text = this.expand(word, cwd);
    if (text === undefined) return `${word.text} cannot be resolved statically`;
    const cut = text.search(/[$*?[{]/);
    if (cut < 0)
      return path.isAbsolute(text) || cwd
        ? undefined
        : `${word.text} is relative to an unknown directory`;
    if (text.includes('$', cut)) return `${word.text} expands a variable whose value is unknown`;
    const literal = text.slice(0, cut);
    const slash = literal.lastIndexOf('/');
    const dir = literal.slice(0, slash + 1);
    // A glob component may itself match `..` (`.*`, `.?`), and `..` after a glob climbs anywhere.
    const tail = text.slice(slash + 1).split('/');
    if (tail.some((part) => part === '..' || (part.startsWith('.') && /[*?[{]/.test(part))))
      return `${word.text} may climb out of its directory`;
    if (!path.isAbsolute(dir) && !cwd) return `${word.text} is relative to an unknown directory`;
    const base = realResolve(path.resolve(cwd ?? '/', dir || '.'));
    const stem = (base.endsWith(path.sep) ? base : base + path.sep) + literal.slice(slash + 1);
    const secret = this.secrets.find((item) => inside(base, item) || item.startsWith(stem));
    return secret ? `${word.text} may expand to credentials at ${secret}` : undefined;
  }

  isSecret(absolute: string): boolean {
    return this.secrets.some((secret) => inside(absolute, secret));
  }

  /** Why writing/deleting `absolute` is dangerous, or undefined when it is ordinary workspace work. */
  writeRisk(absolute: string, destructive: boolean): string | undefined {
    if (HARMLESS.has(absolute)) return undefined;
    if (this.isSecret(absolute)) return `modifies credentials at ${absolute}`;
    if (this.protectedRoots.some((root) => inside(absolute, root)))
      return `modifies protected agent configuration at ${absolute}`;
    // Project agent config at any depth (audit H4): a nested .pirc/ would be
    // a subagent's project config.
    for (const root of this.roots)
      if (
        inside(absolute, root) &&
        path
          .relative(root, absolute)
          .split(path.sep)
          .some((part) => part.toLowerCase() === '.pirc')
      )
        return `modifies agent configuration at ${absolute}`;
    if (destructive && this.roots.some((root) => inside(root, absolute)))
      return `deletes an entire workspace root (${absolute})`;
    if (destructive && this.roots.some((root) => absolute === path.join(root, '.git')))
      return `deletes the repository metadata at ${absolute}`;
    if (this.roots.some((root) => inside(absolute, root))) return undefined;
    if (SCRATCH.some((root) => inside(absolute, root) && absolute !== root)) return undefined;
    return `${destructive ? 'deletes' : 'modifies'} ${absolute}, outside the workspace`;
  }
}

// ---------------------------------------------------------------------------
// Command rules

const READ_ONLY = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'fd',
  'stat',
  'file',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'type',
  'date',
  'uname',
  'whoami',
  'id',
  'hostname',
  'du',
  'df',
  'tree',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'jq',
  'yq',
  'true',
  'false',
  'test',
  '[',
  'nl',
  'column',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'md5sum',
  'md5',
  'shasum',
  'cksum',
  'seq',
  'sleep',
  'ps',
  'pgrep',
  'lsof',
  'uptime',
  'free',
  'nproc',
  'locale',
  'printenv',
  'tac',
  'rev',
  'fold',
  'fmt',
  'expand',
  'unexpand',
  'paste',
  'join',
  'look',
  'bat',
  'eza',
  'exa',
  'tokei',
  'cloc',
  'scc',
  'exit',
  'return',
  ':',
]);

/** Commands whose file operands are written; `all`, the `last` operand, or all `afterFirst`. */
const PATH_WRITERS: Record<string, 'all' | 'last' | 'afterFirst'> = {
  rm: 'all',
  rmdir: 'all',
  unlink: 'all',
  shred: 'all',
  touch: 'all',
  mkdir: 'all',
  tee: 'all',
  truncate: 'all',
  mv: 'all',
  cp: 'last',
  ln: 'last',
  install: 'last',
  rsync: 'last',
  chmod: 'afterFirst',
  chown: 'afterFirst',
  chgrp: 'afterFirst',
};
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv']);

const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas']);
const SYSTEM_DANGER = new Set([
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'fdisk',
  'sfdisk',
  'parted',
  'wipefs',
  'passwd',
  'chsh',
  'visudo',
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'iptables',
  'nft',
  'pfctl',
  'csrutil',
  'spctl',
  'nvram',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const INTERPRETERS = new Set([
  ...SHELLS,
  'python',
  'python3',
  'node',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
]);
/** Wrappers that run the rest of their arguments as a command. */
const WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'nice', 'ionice', 'stdbuf']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const BUILD_TOOLS = new Set([
  'make',
  'cmake',
  'ninja',
  'tsc',
  'prettier',
  'eslint',
  'biome',
  'vitest',
  'jest',
  'pytest',
  'mypy',
  'ruff',
  'black',
  'rustfmt',
  'gofmt',
  'patch',
  'svelte-check',
  'vite',
]);

/** Commands whose operands are not file paths (an unknown `$VAR` there reads nothing). */
const NON_PATH_ARGS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'sleep',
  'seq',
  'exit',
  'return',
  ':',
  'date',
  'export',
  'unset',
  'set',
  'shopt',
  'alias',
  'test',
  '[',
  'which',
  'whereis',
  'type',
  'basename',
  'dirname',
  'printenv',
]);

/** Options whose value is a file or directory the tool writes (M2: checked like redirections). */
const OUTPUT_OPTIONS: Record<string, readonly string[]> = {
  sort: ['-o', '--output'],
  find: ['-fprint', '-fprint0', '-fprintf', '-fls'],
  wget: [
    '-O',
    '--output-document',
    '-P',
    '--directory-prefix',
    '-o',
    '--output-file',
    '-a',
    '--append-output',
  ],
  curl: [
    '-o',
    '--output',
    '--output-dir',
    '-D',
    '--dump-header',
    '-c',
    '--cookie-jar',
    '--trace',
    '--trace-ascii',
    '--stderr',
    '--libcurl',
    '--etag-save',
    '--hsts',
    '--alt-svc',
  ],
  tsc: ['--outDir', '--outFile', '--out', '--declarationDir', '--tsBuildInfoFile'],
  eslint: ['-o', '--output-file', '--cache-location'],
  prettier: ['--cache-location'],
  patch: ['-o', '--output', '-d', '--directory', '-r', '--reject-file', '-B', '--prefix'],
  vite: ['--outDir'],
  go: ['-o'],
  cargo: ['--target-dir', '--out-dir', '--artifact-dir'],
  bun: ['--outdir', '--outfile', '--cwd'],
  npm: ['--prefix'],
  pnpm: ['-C', '--dir', '--prefix'],
  yarn: ['--cwd'],
  make: ['-C', '--directory'],
  cmake: ['-B'],
  ninja: ['-C'],
};

/** Output-option values, minus `-` (stdout). */
const outputs = (args: Word[], names: readonly string[]) =>
  optionValues(args, names).filter((word) => word.text !== '-');

/** The working directory, for tools that write into it (`wget URL`, `curl -O`). */
const cwdWord: Word = { text: '.', quoted: false, dynamic: false };

/** Options taking a separate value, per in-place editor (their values are not file operands). */
const EDITOR_VALUED: Record<string, readonly string[]> = {
  prettier: [
    '--config',
    '--ignore-path',
    '--plugin',
    '--parser',
    '--log-level',
    '--cache-location',
    '--cache-strategy',
    '--stdin-filepath',
    '--config-precedence',
    '--end-of-line',
    '--trailing-comma',
    '--print-width',
    '--tab-width',
    '--arrow-parens',
    '--prose-wrap',
    '--quote-props',
  ],
  eslint: [
    '-c',
    '--config',
    '--ext',
    '--rulesdir',
    '--resolve-plugins-relative-to',
    '--ignore-path',
    '--ignore-pattern',
    '-f',
    '--format',
    '-o',
    '--output-file',
    '--parser',
    '--parser-options',
    '--plugin',
    '--rule',
    '--env',
    '--global',
    '--max-warnings',
    '--cache-location',
    '--cache-strategy',
    '--fix-type',
  ],
  biome: [
    '--config-path',
    '--max-diagnostics',
    '--reporter',
    '--log-level',
    '--log-kind',
    '--stdin-file-path',
  ],
  black: [
    '-l',
    '--line-length',
    '-t',
    '--target-version',
    '--config',
    '--include',
    '--exclude',
    '--extend-exclude',
    '--force-exclude',
    '--stdin-filename',
    '-W',
    '--workers',
    '--required-version',
  ],
  ruff: [
    '--config',
    '--line-length',
    '--target-version',
    '--select',
    '--ignore',
    '--extend-select',
    '--exclude',
    '--extend-exclude',
    '--stdin-filename',
    '--cache-dir',
  ],
  rustfmt: ['--edition', '--config-path', '--config', '--emit', '--color'],
  gofmt: ['-r'],
  patch: [
    '-i',
    '--input',
    '-o',
    '--output',
    '-d',
    '--directory',
    '-r',
    '--reject-file',
    '-B',
    '--prefix',
    '-D',
    '--ifdef',
    '-F',
    '--fuzz',
    '-p',
    '--strip',
    '-V',
    '--version-control',
    '-z',
    '--suffix',
    '-Y',
    '--basename-prefix',
  ],
};

/**
 * Files a formatter or `patch` rewrites in place, or undefined when this
 * invocation edits nothing (prettier without `--write`, `black --check`).
 */
function inPlaceTargets(name: string, args: Word[]): Word[] | undefined {
  const files = (skip = 0) => operandsSkipping(args, EDITOR_VALUED[name] ?? []).slice(skip);
  const checking = hasFlag(args, '--check', '--diff');
  switch (name) {
    case 'prettier':
      return hasFlag(args, '--write', '-w') ? files() : undefined;
    case 'eslint':
      return hasFlag(args, '--fix') ? files() : undefined;
    case 'biome':
      return hasFlag(args, '--write', '--apply', '--apply-unsafe', '--fix') ? files(1) : undefined;
    case 'black':
    case 'rustfmt':
      return checking ? undefined : files();
    case 'ruff': {
      const sub = files()[0]?.text;
      return (sub === 'format' && !checking) || hasFlag(args, '--fix') ? files(1) : undefined;
    }
    case 'gofmt':
      return hasShort(args, 'w') ? files() : undefined;
    case 'patch':
      // `patch [file [patchfile]]`: the first operand is rewritten.
      return files().slice(0, 1);
    default:
      return undefined;
  }
}

/**
 * `sed`: files edited with `-i`, and scripts that run commands (`e`, `s///e`)
 * or read/write other files (`r`, `w`, `s///w`).
 */
function classifySed(args: Word[], state: State): Classification {
  const valued = ['-e', '--expression', '-f', '--file', '-l', '--line-length'];
  const scripts = optionValues(args, ['-e', '--expression']);
  if (optionValues(args, ['-f', '--file']).length)
    return unknown('sed runs a script file that cannot be inspected');
  const inPlace = hasFlag(args, '--in-place') || args.some((w) => /^-[a-zA-Z]*i/.test(w.text));
  // BSD `sed -i '' …`: the empty word is the backup suffix.
  const words = args.filter((word, i) => !(word.text === '' && args[i - 1]?.text === '-i'));
  const files = operandsSkipping(words, valued);
  if (!scripts.length && files.length) scripts.push(files.shift()!);
  for (const script of scripts) {
    if (script.dynamic) return unknown('sed script contains an expansion');
    const subst = /s([^\\\n])(?:\\.|(?!\1)[^\n])*\1(?:\\.|(?!\1)[^\n])*\1([^;\n}]*)/g;
    const flags = [...script.text.matchAll(subst)].map((match) => match[2] ?? '');
    const rest = script.text.replace(subst, ';').replace(/\/(?:\\.|[^/\n])*\//g, '');
    if (flags.some((flag) => /[ew]/.test(flag)) || /(^|[;{}!$\s\d,])[eEwWrR](\s|$|;)/.test(rest))
      return unknown('sed script runs commands or reads or writes other files');
  }
  if (!inPlace) return read('sed');
  return worst(
    write('sed -i edits files in place'),
    checkWrites(files, state, false, 'sed -i edits'),
  );
}

const hasFlag = (words: Word[], ...names: string[]) =>
  words.some(
    (word) => names.includes(word.text) || names.some((n) => word.text.startsWith(`${n}=`)),
  );
/** A short-option cluster (`-rf`) containing any of `letters`. */
const hasShort = (words: Word[], letters: string) =>
  words.some(
    (word) => /^-[A-Za-z]+$/.test(word.text) && [...letters].some((l) => word.text.includes(l)),
  );

/** Operands (non-option words), honouring `--`. */
function operands(words: Word[]): Word[] {
  const out: Word[] = [];
  let options = true;
  for (const word of words) {
    if (options && word.text === '--') {
      options = false;
      continue;
    }
    if (options && word.text.startsWith('-') && word.text !== '-') continue;
    out.push(word);
  }
  return out;
}

/** Like {@link operands}, also skipping the separate value of each option in `valued`. */
function operandsSkipping(words: Word[], valued: readonly string[]): Word[] {
  const out: Word[] = [];
  let options = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (options && word.text === '--') {
      options = false;
      continue;
    }
    if (options && word.text.startsWith('-') && word.text !== '-') {
      if (valued.includes(word.text)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

/** A word made from part of another (`--out=FILE`, `of=FILE`); a leading `~` is taken as expanded. */
const derived = (word: Word, text: string): Word => ({
  text,
  quoted: word.quoted,
  dynamic: word.dynamic,
  tilde: text.startsWith('~'),
});

/**
 * Values of the options in `names`: `--out V`, `--out=V`, `-o V`, `-oV` and
 * clustered short flags (`-sSLo V`). Single-dash long names (`-fprint`) match
 * exactly.
 */
function optionValues(args: Word[], names: readonly string[]): Word[] {
  const out: Word[] = [];
  const isShort = (name: string) => /^-[A-Za-z0-9]$/.test(name);
  const shorts = names.filter(isShort).map((name) => name[1]!);
  const longs = names.filter((name) => !isShort(name));
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const text = word.text;
    if (text === '--') break;
    const long = longs.find((name) => text === name || text.startsWith(`${name}=`));
    if (long) {
      if (text !== long) out.push(derived(word, text.slice(long.length + 1)));
      else if (args[i + 1]) out.push(args[++i]!);
      continue;
    }
    if (!shorts.length || !/^-[A-Za-z0-9]/.test(text)) continue;
    for (let j = 1; j < text.length; j++) {
      if (shorts.includes(text[j]!)) {
        const rest = text.slice(j + 1);
        if (rest) out.push(derived(word, rest));
        else if (args[i + 1]) out.push(args[++i]!);
        break;
      }
      if (!/[A-Za-z0-9]/.test(text[j]!)) break;
    }
  }
  return out;
}

/**
 * Variables that change which program runs or what it loads (`PATH`,
 * preloads, shell start-up files, git and proxy settings). Assigning them
 * makes the rest of the command unjudgeable.
 */
const RISKY_VARIABLES = new Set([
  'PATH',
  'HOME',
  'PWD',
  'CDPATH',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'ZDOTDIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PAGER',
  'MANPAGER',
  'EDITOR',
  'VISUAL',
  'BROWSER',
  'LESSOPEN',
  'LESSCLOSE',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
]);
const RISKY_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'BASH_FUNC_', 'NPM_CONFIG_'];

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;

function riskyAssignment(text: string): string | undefined {
  const name = ASSIGNMENT.exec(text)?.[1];
  if (!name) return undefined;
  const upper = name.toUpperCase();
  return RISKY_VARIABLES.has(upper) ||
    upper.endsWith('_PROXY') ||
    RISKY_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ? name
    : undefined;
}

/** `git -c` keys that cannot run programs; any other key makes git unjudgeable. */
const SAFE_GIT_CONFIG = new Set([
  'user.name',
  'user.email',
  'core.quotepath',
  'core.abbrev',
  'core.autocrlf',
  'core.safecrlf',
  'core.eol',
  'core.filemode',
  'core.ignorecase',
  'init.defaultbranch',
  'column.ui',
  'diff.renames',
  'diff.noprefix',
  'diff.mnemonicprefix',
  'diff.algorithm',
  'diff.colormoved',
  'merge.conflictstyle',
  'pull.rebase',
  'pull.ff',
  'push.default',
  'push.autosetupremote',
  'commit.gpgsign',
  'tag.gpgsign',
  'log.date',
  'log.decorate',
  'log.showsignature',
  'format.pretty',
  'status.short',
  'status.branch',
  'rebase.autosquash',
  'rebase.autostash',
  'fetch.prune',
  'branch.sort',
  'tag.sort',
]);

function safeGitConfig(entry: string): boolean {
  const eq = entry.indexOf('=');
  const key = (eq < 0 ? entry : entry.slice(0, eq)).toLowerCase();
  const value = eq < 0 ? 'true' : entry.slice(eq + 1);
  if (SAFE_GIT_CONFIG.has(key) || key.startsWith('color.') || key.startsWith('advice.'))
    return true;
  if (key === 'core.fsmonitor') return /^(false|no|off|0)$/i.test(value);
  if (key === 'core.pager') return value === 'cat' || value === 'less' || value === '';
  return false;
}

interface State {
  cwd: string | undefined;
  paths: Paths;
  deny: readonly RegExp[];
}

function checkWrites(
  targets: Word[],
  state: State,
  destructive: boolean,
  what: string,
): Classification {
  const writes: string[] = [];
  for (const target of targets) {
    if (HARMLESS.has(target.text)) continue;
    const absolute = state.paths.resolve(target, state.cwd);
    if (!absolute) return unknown(`${what} a path that cannot be resolved statically`);
    const risk = state.paths.writeRisk(absolute, destructive);
    if (risk) return danger(risk);
    writes.push(absolute);
  }
  return writes.length ? { ...write(`${what} files in the workspace`), writes } : read();
}

function classifyGit(args: Word[], state: State): Classification {
  let i = 0;
  let cwd = state.cwd;
  while (i < args.length && args[i]!.text.startsWith('-')) {
    const flag = args[i]!.text;
    if (flag === '-C') {
      const target = args[i + 1];
      cwd = target ? state.paths.resolve(target, cwd) : undefined;
      i += 2;
    } else if (flag === '-c') {
      // Config such as core.fsmonitor, core.sshCommand or credential.helper runs programs.
      const entry = args[i + 1];
      if (!entry || entry.dynamic || !safeGitConfig(entry.text))
        return unknown(`git -c ${entry?.text ?? ''} may make git run another program`.trim());
      i += 2;
    } else if (flag.startsWith('--config-env') || flag.startsWith('--exec-path='))
      return unknown(`git ${flag} may make git run another program`);
    else if (flag.startsWith('--git-dir') || flag.startsWith('--work-tree'))
      return unknown('git with an explicit git dir or work tree');
    else i++;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (!cwd) return unknown('git in a directory that cannot be resolved statically');
  let inner = classifyGitSubcommand(sub, rest);
  // `git log/diff/show --output=FILE` writes a file.
  const outputs = optionValues(rest, ['--output']);
  if (outputs.length && sub !== 'format-patch')
    inner = worst(inner, checkWrites(outputs, { ...state, cwd }, false, `git ${sub} writes`));
  if (sub === 'format-patch')
    inner = worst(
      inner,
      checkWrites(
        optionValues(rest, ['-o', '--output-directory']),
        { ...state, cwd },
        false,
        'git format-patch writes',
      ),
    );
  const risk = state.paths.writeRisk(cwd, false);
  // Repository outside the workspace (or protected): reads are fine, writes are not.
  if (risk && inner.verdict !== 'read')
    return danger(`${`git ${sub ?? ''}`.trim()} in ${cwd}: ${risk}`);
  return inner;
}

/** Classify a git subcommand on its own, independently of the repository location. */
function classifyGitSubcommand(sub: string | undefined, rest: Word[]): Classification {
  const words = rest.map((word) => word.text);
  // Options and subcommands that name a program for git to run.
  const runs = rest.find(
    (word) =>
      /^--(upload-pack|receive-pack|exec|extcmd|open-files-in-pager|tool)(=|$)/.test(word.text) ||
      (word.text.startsWith('-u') &&
        ['ls-remote', 'fetch', 'clone', 'pull', 'archive'].includes(sub ?? '')) ||
      (/^-[A-Za-z]*x/.test(word.text) && ['rebase', 'difftool'].includes(sub ?? '')) ||
      (/^-O/.test(word.text) && sub === 'grep'),
  );
  if (runs) return unknown(`git ${sub} ${runs.text} may make git run another program`);
  if (
    sub === 'mergetool' ||
    sub === 'difftool' ||
    sub === 'credential' ||
    (sub === 'submodule' && words.includes('foreach')) ||
    (sub === 'bisect' && words[0] === 'run')
  )
    return unknown(`git ${sub} runs other programs`);
  switch (sub) {
    case undefined:
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'blame':
    case 'annotate':
    case 'rev-parse':
    case 'ls-files':
    case 'ls-tree':
    case 'ls-remote':
    case 'cat-file':
    case 'describe':
    case 'shortlog':
    case 'grep':
    case 'merge-base':
    case 'whatchanged':
    case 'name-rev':
    case 'rev-list':
    case 'count-objects':
    case 'check-ignore':
    case 'check-attr':
    case 'var':
    case 'help':
    case 'version':
    case 'range-diff':
    case 'for-each-ref':
    case 'show-ref':
    case 'verify-commit':
    case 'verify-tag':
      return read(`git ${sub ?? ''}`.trim());
    case 'branch': {
      if (
        hasFlag(rest, '-D') ||
        (hasFlag(rest, '-d', '--delete') && hasFlag(rest, '-f', '--force'))
      )
        return danger('force-deletes a git branch, possibly losing unmerged commits');
      const listing = rest.every((word) =>
        /^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--contains|--no-contains|--merged|--no-merged|--sort=.*|--format=.*|--points-at|--color.*|--no-color|--column.*)$/.test(
          word.text,
        ),
      );
      return listing ? read('git branch listing') : write('git branch');
    }
    case 'tag':
      return !rest.length || hasFlag(rest, '-l', '--list', '-n', '--contains', '--points-at')
        ? read('git tag listing')
        : write('git tag');
    case 'remote':
      return !rest.length || ['-v', 'show', 'get-url', '--verbose'].includes(words[0] ?? '')
        ? read('git remote listing')
        : write('git remote');
    case 'config':
      if (hasFlag(rest, '--global', '--system')) {
        return hasFlag(rest, '--get', '--get-all', '--get-regexp', '--list', '-l')
          ? read('git config lookup')
          : danger('changes global git configuration');
      }
      if (
        hasFlag(rest, '--get', '--get-all', '--get-regexp', '--list', '-l') ||
        operands(rest).length === 1 ||
        ['get', 'list'].includes(operands(rest)[0]?.text ?? '')
      )
        return read('git config lookup');
      {
        // Aliases, hooks, pagers, filters and helpers in the repository config run programs.
        const key = operands(rest).find((word) => word.text.includes('.'));
        if (hasFlag(rest, '--unset', '--unset-all', '--remove-section') || words[0] === 'unset')
          return write('git config');
        if (!key || key.dynamic || !safeGitConfig(key.text))
          return unknown(`git config ${key?.text ?? ''} may make git run another program`.trim());
        return write('git config');
      }
    case 'stash':
      if (words[0] === 'list' || words[0] === 'show') return read('git stash listing');
      if (words[0] === 'drop' || words[0] === 'clear')
        return danger('permanently discards stashed changes');
      return write('git stash');
    case 'reflog':
      if (!words.length || words[0] === 'show') return read('git reflog');
      return danger('rewrites the reflog, removing recovery points');
    case 'push':
      if (
        hasFlag(
          rest,
          '--force',
          '-f',
          '--force-with-lease',
          '--mirror',
          '--delete',
          '-d',
          '--prune',
        ) ||
        hasShort(rest, 'fd') ||
        operands(rest).some((word) => word.text.startsWith('+') || word.text.startsWith(':'))
      )
        return danger('force-pushes or deletes remote refs, rewriting shared history');
      return write('git push');
    case 'reset':
      return hasFlag(rest, '--hard', '--merge', '--keep')
        ? danger('git reset --hard discards uncommitted work')
        : write('git reset');
    case 'clean':
      return hasFlag(rest, '-n', '--dry-run') || (hasShort(rest, 'n') && !hasShort(rest, 'f'))
        ? read('git clean dry run')
        : danger('git clean permanently deletes untracked files');
    case 'checkout':
      if (hasFlag(rest, '-f', '--force') || words.includes('--') || words.includes('.'))
        return danger('git checkout over paths discards uncommitted changes');
      return write('git checkout');
    case 'restore':
      if (!hasFlag(rest, '--staged', '-S') || hasFlag(rest, '--worktree', '-W'))
        return danger('git restore discards uncommitted changes');
      return write('git restore --staged');
    case 'switch':
      return hasFlag(rest, '--discard-changes', '-f', '--force')
        ? danger('git switch --discard-changes discards uncommitted work')
        : write('git switch');
    case 'filter-branch':
    case 'filter-repo':
      return danger('rewrites the entire repository history');
    case 'update-ref':
      return hasFlag(rest, '-d') ? danger('deletes a git ref') : write('git update-ref');
    case 'gc':
    case 'prune':
      return hasFlag(rest, '--prune', '--aggressive') || sub === 'prune'
        ? danger('prunes unreachable objects, removing recovery points')
        : write('git gc');
    default:
      return GIT_WRITERS.has(sub)
        ? write(`git ${sub}`)
        : unknown(`git ${sub} may be an alias or extension that runs other programs`);
  }
}

/** Built-in git subcommands that change local state without running other programs. */
const GIT_WRITERS = new Set([
  'add',
  'stage',
  'commit',
  'fetch',
  'pull',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'mv',
  'rm',
  'init',
  'clone',
  'apply',
  'am',
  'worktree',
  'notes',
  'format-patch',
  'archive',
  'bundle',
  'sparse-checkout',
  'maintenance',
  'fsck',
  'repack',
  'pack-refs',
  'rerere',
  'submodule',
  'bisect',
  'replace',
  'symbolic-ref',
  'update-index',
  'read-tree',
  'write-tree',
  'commit-tree',
  'hash-object',
  'mktree',
  'mktag',
  'cherry',
  'request-pull',
  'lfs',
  'commit-graph',
  'multi-pack-index',
  'restore',
]);

function classifyPackageManager(name: string, args: Word[]): Classification {
  const sub = operands(args)[0]?.text;
  if (
    [
      'publish',
      'unpublish',
      'deprecate',
      'dist-tag',
      'owner',
      'access',
      'token',
      'login',
      'adduser',
    ].includes(sub ?? '')
  )
    return danger(`${name} ${sub} changes a package registry or credentials`);
  if (name === 'bun' && sub && /\.[cm]?[jt]sx?$/.test(sub)) return unknown('runs a script');
  if (name === 'bun' && hasFlag(args, '-e', '--eval', '-p', '--print'))
    return unknown('evaluates inline code');
  if (['x', 'dlx', 'exec', 'create'].includes(sub ?? ''))
    return unknown(`${name} ${sub} runs an arbitrary package`);
  if (
    [
      'ls',
      'list',
      'outdated',
      'view',
      'info',
      'why',
      'audit',
      'config',
      'pm',
      'help',
      '--version',
      '-v',
    ].includes(sub ?? '')
  ) {
    if (
      (sub === 'config' &&
        operands(args)[1]?.text !== 'get' &&
        operands(args)[1]?.text !== 'list') ||
      (sub === 'pm' && operands(args)[1]?.text !== 'ls')
    )
      return write(`${name} ${sub}`);
    return read(`${name} ${sub}`);
  }
  if (hasFlag(args, '-g', '--global')) return danger(`${name} changes global packages`);
  return write(`${name} ${sub ?? ''}`.trim());
}

function classifyCommand(command: Command, state: State): Classification {
  let words = [...command.words];
  let result = read();
  // Leading environment assignments; `PATH=./bin cat x` runs another `cat`.
  const assign = (text: string) => {
    const risky = riskyAssignment(text);
    if (risky)
      result = worst(result, unknown(`sets ${risky}, which changes what programs run or load`));
  };
  while (words.length && ASSIGNMENT.test(words[0]!.text)) assign(words.shift()!.text);
  // `env [-i] [NAME=value…] cmd`, `timeout 10 cmd`, `nohup cmd`, …
  for (;;) {
    const head = words[0]?.text;
    if (head === 'env') {
      words.shift();
      while (words.length) {
        const text = words[0]!.text;
        if (ASSIGNMENT.test(text)) assign(text);
        else if (text === '-u' || text === '--unset') words.shift();
        else if (!/^(-i|-0|--ignore-environment|--null|-|--unset=.*|-u.+)$/.test(text)) {
          if (text.startsWith('-'))
            result = worst(result, unknown(`env ${text} changes how the command runs`));
          break;
        }
        words.shift();
      }
    } else if (head === 'timeout') {
      words.shift();
      while (words.length && words[0]!.text.startsWith('-')) words.shift();
      words.shift();
    } else if (head && WRAPPERS.has(head)) {
      words.shift();
      while (words.length && words[0]!.text.startsWith('-')) words.shift();
    } else break;
  }

  for (const redirect of command.redirects) {
    if (redirect.op.includes('<')) {
      if (!redirect.target) continue;
      const source = state.paths.resolve(redirect.target, state.cwd);
      if (source && state.paths.isSecret(source)) return danger(`reads credentials at ${source}`);
      const risk = !source && state.paths.unresolvedRisk(redirect.target, state.cwd);
      if (risk) result = worst(result, unknown(`reads ${risk}`));
      continue;
    }
    if (!redirect.target) return unknown('redirection without a target');
    result = worst(result, checkWrites([redirect.target], state, false, 'redirects output to'));
  }

  const head = words[0];
  if (!head) return result;
  if (head.dynamic) return worst(result, unknown('command name is an expansion'));
  const name = path.basename(head.text);
  const args = words.slice(1);

  // Credentials are dangerous to read too: the output lands in the model's context.
  // An operand whose expansion cannot be known might be one (`cat ~/.ssh/*`, `cat $F`).
  for (const word of args) {
    const absolute = state.paths.resolve(word, state.cwd);
    if (absolute && state.paths.isSecret(absolute))
      return danger(`touches credentials at ${absolute}`);
    if (!absolute && !NON_PATH_ARGS.has(name)) {
      const risk = state.paths.unresolvedRisk(word, state.cwd);
      if (risk) result = worst(result, unknown(risk));
    }
  }

  const scripts = denyScripts(head, args, state);
  if (scripts?.verdict === 'danger') return scripts;
  if (scripts) result = worst(result, scripts);

  if (PRIVILEGE.has(name)) return danger(`${name} escalates privileges`);
  if (SYSTEM_DANGER.has(name) || name.startsWith('mkfs'))
    return danger(`${name} changes system configuration or storage`);

  if (name === 'cd' || name === 'pushd') {
    const target = args[0];
    state.cwd = !target
      ? state.paths.home
      : target.text === '-'
        ? undefined
        : state.paths.resolve(target, state.cwd);
    return result;
  }
  if (name === 'popd') {
    state.cwd = undefined;
    return result;
  }
  if (name === 'export') {
    const risky = args.map((word) => riskyAssignment(word.text)).find(Boolean);
    return risky
      ? worst(result, unknown(`sets ${risky}, which changes what programs run or load`))
      : hasFlag(args, '-f', '-n')
        ? worst(result, unknown('export -f/-n changes shell functions'))
        : result;
  }
  if (name === 'unset') return result;
  if (name === 'set') {
    // `set -euo pipefail` and friends; anything else (positional parameters, `-k`, …) is unclear.
    let i = 0;
    for (; i < args.length; i++) {
      const text = args[i]!.text;
      if (/^[-+][euxvETCfnah]+$/.test(text)) continue;
      if (
        /^[-+][euxvETCfnah]*o$/.test(text) &&
        /^(errexit|nounset|pipefail|xtrace|verbose|noclobber|noglob|errtrace|functrace|posix)$/.test(
          args[i + 1]?.text ?? '',
        )
      ) {
        i++;
        continue;
      }
      break;
    }
    return i === args.length ? result : worst(result, unknown('set changes shell state'));
  }
  if (name === 'shopt')
    return args.some((word) => word.text === 'expand_aliases')
      ? worst(
          result,
          unknown('enables alias expansion, so later commands may not be what they look like'),
        )
      : result;
  if (name === 'alias')
    return args.some((word) => word.text.includes('='))
      ? worst(result, unknown('defines an alias, so later commands may not be what they look like'))
      : result;
  if (name === 'printf') {
    // `printf -v PATH …` assigns a variable.
    const target = optionValues(args, ['-v'])[0];
    if (target && (target.dynamic || riskyAssignment(`${target.text}=`)))
      return worst(result, unknown(`printf -v sets ${target.text}`));
  }

  if (READ_ONLY.has(name)) return result;

  const writer = PATH_WRITERS[name];
  if (writer) {
    if (name === 'tee' && !operands(args).length) return result;
    let targets = operands(args);
    if (writer === 'last') targets = targets.slice(-1);
    if (writer === 'afterFirst') targets = targets.slice(1);
    if (name === 'install' && hasShort(args, 'd')) targets = operands(args);
    if (name === 'cp' || name === 'install' || name === 'ln') {
      const t = optionValues(args, ['-t', '--target-directory']);
      if (t.length) targets = t;
    }
    const recursive = hasShort(args, 'rR') || hasFlag(args, '--recursive');
    const destructive =
      DESTRUCTIVE.has(name) ||
      (recursive && ['chmod', 'chown', 'chgrp'].includes(name)) ||
      (name === 'rsync' && hasFlag(args, '--delete', '--delete-after', '--delete-before'));
    if (name === 'mv' || name === 'rsync') {
      // A destination outside the workspace is dangerous too, but not "destructive".
      const all = operands(args);
      const dest = checkWrites(all.slice(-1), state, false, `${name} into`);
      const sources = checkWrites(all.slice(0, -1), state, name === 'mv', `${name} from`);
      return worst(result, worst(dest, sources));
    }
    return worst(result, checkWrites(targets, state, destructive, `${name}`));
  }

  switch (name) {
    case 'git':
      return worst(result, classifyGit(args, state));
    case 'sed':
      return worst(result, classifySed(args, state));
    case 'sort': {
      const out = outputs(args, OUTPUT_OPTIONS.sort!);
      return out.length ? worst(result, checkWrites(out, state, false, 'sort -o writes')) : result;
    }
    case 'find': {
      if (hasFlag(args, '-exec', '-execdir', '-ok', '-okdir'))
        return worst(result, unknown('find -exec runs commands'));
      const out = outputs(args, OUTPUT_OPTIONS.find!);
      if (out.length) result = worst(result, checkWrites(out, state, false, 'find writes'));
      if (hasFlag(args, '-delete')) {
        const firstOption = args.findIndex((w) => w.text.startsWith('-'));
        const starts = firstOption < 0 ? args : args.slice(0, firstOption);
        const roots = starts.length ? starts : [{ text: '.', quoted: false, dynamic: false }];
        return worst(result, checkWrites(roots, state, true, 'find -delete in'));
      }
      return result;
    }
    case 'awk':
    case 'gawk':
    case 'mawk': {
      const program = operands(args)[0]?.text ?? '';
      return worst(
        result,
        /system\s*\(|\|\s*"|>\s*"|getline|-i\s*inplace/.test(
          program + args.map((w) => w.text).join(' '),
        )
          ? unknown('awk program with side effects')
          : read('awk'),
      );
    }
    case 'curl': {
      if (
        hasFlag(args, '-T', '--upload-file', '-F', '--form') ||
        args.some((w) => /^(-d|--data.*)$/.test(w.text))
      )
        return worst(result, unknown('curl sends data to a remote host'));
      if (hasFlag(args, '-K', '--config') || args.some((w) => /^file:/i.test(w.text)))
        return worst(result, unknown('curl reads a local file or config'));
      const out = outputs(args, OUTPUT_OPTIONS.curl!);
      if (out.length) result = worst(result, checkWrites(out, state, false, 'curl writes'));
      if (
        !hasFlag(args, '--output-dir') &&
        (hasFlag(args, '-O', '--remote-name', '--remote-name-all') || hasShort(args, 'O'))
      )
        result = worst(result, checkWrites([cwdWord], state, false, 'curl downloads into'));
      return worst(
        result,
        hasShort(args, 'X') || hasFlag(args, '--request')
          ? unknown('curl with a custom method')
          : read('curl GET'),
      );
    }
    case 'wget': {
      if (args.some((w) => /^file:/i.test(w.text)))
        return worst(result, unknown('wget reads a local file'));
      const out = outputs(args, OUTPUT_OPTIONS.wget!);
      // Without -O / -P the download lands in the working directory.
      const document = optionValues(args, ['-O', '--output-document', '-P', '--directory-prefix']);
      return worst(
        result,
        worst(
          write('wget downloads files'),
          checkWrites(document.length ? out : [...out, cwdWord], state, false, 'wget writes'),
        ),
      );
    }
    case 'dd': {
      const of = args.find((w) => w.text.startsWith('of='));
      if (!of) return result;
      if (of.text.startsWith('of=/dev/') && !HARMLESS.has(of.text.slice(3)))
        return danger('dd writes to a raw device');
      return worst(result, checkWrites([derived(of, of.text.slice(3))], state, false, 'dd writes'));
    }
    case 'kill':
      if (args.some((w) => w.text === '-1')) return danger('kills every process of the user');
      return worst(result, unknown('kill signals a process'));
    case 'killall':
    case 'pkill':
      return worst(result, unknown(`${name} signals processes by name`));
    case 'crontab':
      return hasFlag(args, '-l') ? result : danger('modifies scheduled jobs');
    case 'systemctl':
    case 'launchctl':
    case 'service':
      return ['status', 'list', 'show', 'is-active', 'is-enabled', 'print', 'list-units'].includes(
        operands(args)[0]?.text ?? '',
      )
        ? result
        : danger(`${name} changes system services`);
    case 'npx':
    case 'bunx':
    case 'pnpx':
      return worst(result, unknown(`${name} runs an arbitrary package`));
    case 'cargo': {
      const sub = operands(args)[0]?.text;
      if (sub === 'publish' || sub === 'yank' || sub === 'login' || sub === 'owner')
        return danger(`cargo ${sub} changes a package registry`);
      if (sub === 'install' || sub === 'uninstall')
        return danger(`cargo ${sub} changes globally installed tools`);
      return worst(
        result,
        worst(
          write(`cargo ${sub ?? ''}`.trim()),
          checkWrites(outputs(args, OUTPUT_OPTIONS.cargo!), state, false, 'cargo writes'),
        ),
      );
    }
    case 'go': {
      const sub = operands(args)[0]?.text;
      if (['env', 'version', 'list', 'doc', 'vet'].includes(sub ?? ''))
        return hasFlag(args, '-w') ? danger('go env -w changes global Go settings') : result;
      if (sub === 'install') return danger('go install changes globally installed tools');
      return worst(
        result,
        worst(
          write(`go ${sub ?? ''}`.trim()),
          checkWrites(outputs(args, OUTPUT_OPTIONS.go!), state, false, 'go writes'),
        ),
      );
    }
    case 'pip':
    case 'pip3':
    case 'uv': {
      const sub = operands(args)[0]?.text;
      if (['list', 'show', 'freeze', 'check', '--version'].includes(sub ?? '')) return result;
      if (sub === 'upload' || sub === 'publish')
        return danger(`${name} ${sub} publishes a package`);
      return worst(result, write(`${name} ${sub ?? ''}`.trim()));
    }
    case 'twine':
    case 'gem':
      return operands(args)[0]?.text === 'upload' || operands(args)[0]?.text === 'push'
        ? danger(`${name} publishes a package`)
        : worst(result, unknown(name));
    case 'docker':
    case 'podman': {
      const sub = operands(args)[0]?.text;
      if (
        [
          'ps',
          'images',
          'logs',
          'inspect',
          'version',
          'info',
          'stats',
          'top',
          'port',
          'diff',
          'history',
        ].includes(sub ?? '')
      )
        return result;
      if (sub === 'push' || sub === 'login')
        return danger(`${name} ${sub} changes a registry or credentials`);
      if (sub === 'system' || sub === 'volume' || sub === 'rm' || sub === 'rmi' || sub === 'prune')
        return worst(result, unknown(`${name} ${sub} may delete containers or data`));
      return worst(result, unknown(`${name} ${sub ?? ''}`.trim()));
    }
    case 'kubectl':
    case 'helm': {
      const sub = operands(args)[0]?.text;
      if (
        [
          'get',
          'describe',
          'logs',
          'version',
          'explain',
          'list',
          'status',
          'top',
          'api-resources',
          'config',
        ].includes(sub ?? '') &&
        !(sub === 'config' && operands(args)[1]?.text?.startsWith('set'))
      )
        return result;
      return danger(`${[name, sub].filter(Boolean).join(' ')} changes a cluster`);
    }
    case 'terraform':
    case 'tofu':
    case 'pulumi': {
      const sub = operands(args)[0]?.text;
      if (
        [
          'plan',
          'validate',
          'fmt',
          'show',
          'output',
          'version',
          'preview',
          'providers',
          'graph',
        ].includes(sub ?? '')
      )
        return worst(result, write(`${name} ${sub}`));
      if (sub === 'init') return worst(result, write(`${name} init`));
      return danger(`${[name, sub].filter(Boolean).join(' ')} changes real infrastructure`);
    }
    case 'gh': {
      const [group, action] = operands(args).map((w) => w.text);
      // `gh`, `gh --version`, `gh --help`, `gh version` only print.
      if (
        (group === undefined &&
          args.every((w) => ['--version', '--help', '-h'].includes(w.text))) ||
        (group === 'version' && args.length === 1)
      )
        return result;
      if (group === 'api') {
        const method = args.findIndex((w) => w.text === '-X' || w.text === '--method');
        const verb = method >= 0 ? args[method + 1]?.text.toUpperCase() : undefined;
        if (verb && verb !== 'GET') return danger(`gh api ${verb} changes GitHub state`);
        if (hasFlag(args, '-f', '-F', '--field', '--raw-field', '--input'))
          return danger('gh api with fields sends a mutating request');
        return result;
      }
      if (
        ['view', 'list', 'status', 'diff', 'checks', 'search', 'browse'].includes(action ?? '') ||
        group === 'search' ||
        group === 'status'
      )
        return result;
      if (group === 'auth' || group === 'secret' || group === 'ssh-key' || group === 'gpg-key')
        return action === 'status' ? result : danger(`gh ${group} changes credentials`);
      if (action === 'delete' || action === 'merge' || action === 'close' || group === 'release')
        return danger(`gh ${group} ${action} changes shared GitHub state`);
      return worst(result, unknown(`gh ${group ?? ''} ${action ?? ''}`.trim()));
    }
    case 'nix': {
      const sub = operands(args)[0]?.text;
      if (['eval', 'search', 'show-config', 'path-info', 'why-depends', 'log'].includes(sub ?? ''))
        return result;
      if (sub === 'profile' || sub === 'store' || sub === 'registry')
        return worst(result, unknown(`nix ${sub}`));
      if (sub === 'flake' && operands(args)[1]?.text === 'show') return result;
      return worst(result, write(`nix ${sub ?? ''}`.trim()));
    }
    case 'xargs': {
      let i = 0;
      while (i < args.length && args[i]!.text.startsWith('-'))
        i += /^-[IdLnPsE]$/.test(args[i]!.text) ? 2 : 1;
      // The items read from stdin become unknown operands (they may name credentials).
      const stdinItems: Word = { text: '$XARGS_INPUT', quoted: false, dynamic: true };
      const inner = classifyCommand(
        { words: [...args.slice(i), stdinItems], redirects: [] },
        { ...state },
      );
      return worst(
        result,
        inner.verdict === 'read'
          ? inner
          : worst(inner, unknown('xargs runs a command on unknown input')),
      );
    }
  }

  if (PACKAGE_MANAGERS.has(name)) {
    const out = outputs(args, OUTPUT_OPTIONS[name] ?? []);
    return worst(
      result,
      worst(
        classifyPackageManager(name, args),
        checkWrites(out, state, false, `${name} writes in`),
      ),
    );
  }
  if (BUILD_TOOLS.has(name)) {
    const edited = inPlaceTargets(name, args);
    if (name === 'prettier' && !edited) return result;
    const out = [...outputs(args, OUTPUT_OPTIONS[name] ?? []), ...(edited ?? [])];
    return worst(
      result,
      worst(
        write(`${name} builds, formats or tests the workspace`),
        checkWrites(out, state, false, `${name} writes`),
      ),
    );
  }
  if (INTERPRETERS.has(name) || ['eval', 'exec', 'source', '.'].includes(name))
    return worst(result, unknown(`${name} runs arbitrary code`));
  if (name.startsWith('./') || head.text.includes('/'))
    return worst(result, unknown('runs a local program'));
  return worst(result, unknown(`unrecognised command ${name}`));
}

// ---------------------------------------------------------------------------
// User deny-list

/**
 * Compile the user's deny-list. A pattern is a JavaScript regular expression
 * searched (unanchored) in the command; `/source/flags` sets flags. A pattern
 * that does not compile is matched as literal text rather than dropped, so a
 * typo cannot silently disable it.
 */
export function compileDeny(patterns: readonly string[]): { deny: RegExp[]; invalid: string[] } {
  const deny: RegExp[] = [];
  const invalid: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.trim()) continue;
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
    try {
      deny.push(literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(pattern));
    } catch {
      invalid.push(pattern);
      deny.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
  }
  return { deny, invalid };
}

const denied = (deny: readonly RegExp[], text: string, where: string) => {
  for (const pattern of deny) {
    pattern.lastIndex = 0;
    if (pattern.test(text))
      return {
        ...danger(`${where} matches the deny-list pattern ${pattern}`),
        denied: true as const,
      };
  }
  return undefined;
};

/**
 * The deny-list against the raw text, and against each lexed command with
 * quotes and escapes removed and words single-spaced (`"just"  sw\itch`).
 */
export function denyMatch(text: string, deny: readonly RegExp[]): Classification | undefined {
  if (!deny.length) return undefined;
  const raw = denied(deny, text, 'the command');
  if (raw) return raw;
  const lexed = lex(text);
  if ('complex' in lexed) return undefined;
  for (const pipeline of lexed.pipelines)
    for (const command of pipeline) {
      const hit = denied(deny, command.words.map((word) => word.text).join(' '), 'the command');
      if (hit) return hit;
    }
  return undefined;
}

const MAX_SCRIPT_BYTES = 1024 * 1024;

function readText(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    if (!statSync(file).isFile() || statSync(file).size > MAX_SCRIPT_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Recipes of a Makefile or justfile: header `name … :` then indented body lines. */
function recipes(text: string): Map<string, { deps: string[]; body: string }> {
  const out = new Map<string, { deps: string[]; body: string }>();
  let current: Array<{ deps: string[]; body: string }> = [];
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line)) {
      for (const recipe of current) recipe.body += `${line}\n`;
      continue;
    }
    const header = /^@?([^\s:#=][^:=]*?)\s*::?(?!=)\s*(.*)$/.exec(line);
    if (!header) {
      if (line.trim() && !line.startsWith('#')) current = [];
      continue;
    }
    const [deps, inline] = header[2]!.split(';', 2);
    current = [];
    for (const target of header[1]!.split(/\s+/)) {
      const name = target.replace(/^@/, '');
      const recipe = {
        deps: (deps ?? '').split(/\s+/).filter(Boolean),
        body: inline ? `${inline}\n` : '',
      };
      if (!out.has(name)) out.set(name, recipe);
      current.push(out.get(name)!);
    }
  }
  return out;
}

/** Bodies of `names` and, transitively, of the recipes they depend on. */
function recipeBodies(text: string, names: string[], skipMissing: boolean): string[] | undefined {
  const all = recipes(text);
  const queue = names.length
    ? [...names]
    : [...all.keys()].filter((name) => !name.startsWith('.')).slice(0, 1);
  const seen = new Set<string>();
  const out: string[] = [];
  while (queue.length && seen.size < 64) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const recipe = all.get(name.split(/\s/)[0]!);
    if (!recipe) {
      if (skipMissing) continue;
      return undefined;
    }
    out.push(recipe.body);
    queue.push(...recipe.deps.map((dep) => dep.replace(/\(.*$/, '')).filter(Boolean));
    for (const match of recipe.body.matchAll(/\b(?:\$\(MAKE\)|make|just)\s+([A-Za-z0-9_.\-/]+)/g))
      queue.push(match[1]!);
  }
  return out;
}

/** Bodies of the package.json scripts `names` runs, with pre/post hooks and nested `run`s. */
function packageScriptBodies(dir: string, names: string[]): string[] {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(readText(path.join(dir, 'package.json')) ?? '{}').scripts ??
      {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  const queue = [...names];
  const seen = new Set<string>();
  while (queue.length && seen.size < 64) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const key of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[key];
      if (typeof body !== 'string') continue;
      out.push(body);
      for (const match of body.matchAll(
        /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.\-/@]+)/g,
      ))
        queue.push(match[1]!);
    }
  }
  return out;
}

/**
 * M1: what a command runs indirectly — package scripts, make/just recipes,
 * shell script files — checked against the deny-list. Danger on a match;
 * unknown when the scripts cannot be determined; undefined otherwise.
 */
function denyScripts(head: Word, args: Word[], state: State): Classification | undefined {
  if (!state.deny.length) return undefined;
  const name = path.basename(head.text);
  const at = (dirs: Word[]) =>
    dirs.length ? state.paths.resolve(dirs.at(-1)!, state.cwd) : state.cwd;
  const check = (bodies: string[], where: string) => {
    for (const body of bodies) {
      const hit = denyMatch(body, state.deny);
      if (hit) return { ...hit, reason: `${where} ${hit.reason.replace(/^the command /, '')}` };
    }
    return undefined;
  };
  if (PACKAGE_MANAGERS.has(name)) {
    if (
      hasFlag(
        args,
        '--filter',
        '-F',
        '-r',
        '--recursive',
        '--workspaces',
        '--workspace',
        '-w',
        '-ws',
      )
    )
      return unknown(`${name} runs scripts across workspaces that the deny-list cannot inspect`);
    const dir = at(outputs(args, OUTPUT_OPTIONS[name] ?? []));
    const ops = operands(args).map((word) => word.text);
    const names = ops[0] === 'run' || ops[0] === 'run-script' ? ops.slice(1, 2) : ops.slice(0, 1);
    // Installing runs the project's lifecycle scripts.
    if (['install', 'i', 'ci', 'add'].includes(names[0] ?? '') || !ops.length)
      names.push('install', 'prepare');
    if (!dir) return unknown('package scripts in an unknown directory');
    return check(
      packageScriptBodies(dir, names),
      `${name} ${names.join(' ')} runs a package script that`,
    );
  }
  if (name === 'make' || name === 'just') {
    const dir = at(
      optionValues(args, name === 'make' ? ['-C', '--directory'] : ['-d', '--working-directory']),
    );
    if (!dir) return unknown(`${name} in an unknown directory`);
    const given = optionValues(
      args,
      name === 'make' ? ['-f', '--file', '--makefile'] : ['-f', '--justfile'],
    );
    const candidates = given.length
      ? [state.paths.resolve(given.at(-1)!, dir)]
      : name === 'make'
        ? ['GNUmakefile', 'makefile', 'Makefile'].map((file) => path.join(dir, file))
        : ['justfile', 'Justfile', '.justfile'].map((file) => path.join(dir, file));
    const file = candidates.find((item) => readText(item) !== undefined);
    const text = readText(file);
    if (!text) return given.length ? unknown(`${name} file cannot be read`) : undefined;
    const targets = operandsSkipping(args, [
      '-f',
      '--file',
      '--makefile',
      '-C',
      '--directory',
      '-d',
      '--working-directory',
      '--justfile',
      '-j',
      '-l',
    ])
      .map((word) => word.text)
      .filter((word) => !word.includes('='));
    // make: an unknown target may come from a pattern rule or include, so check the whole file.
    // just: words after the recipe may be its parameters.
    const bodies = recipeBodies(text, targets, name === 'just') ?? [text];
    return check(bodies, `${name} ${targets.join(' ')} runs a recipe that`.replace(/ +/g, ' '));
  }
  // `bash s.sh`, `source s.sh`, `./s.sh`: the script file.
  let file: Word | undefined;
  if (SHELLS.has(name) || name === 'source' || name === '.') {
    if (hasShort(args, 'c')) return undefined; // inline text: already matched as raw text
    file = operandsSkipping(args, ['-o', '+o', '-O', '+O'])[0];
  } else if (head.text.includes('/')) file = head;
  if (!file) return undefined;
  const resolved = state.paths.resolve(file, state.cwd);
  const text = readText(resolved);
  if (text === undefined)
    return resolved
      ? undefined
      : unknown(`runs ${file.text}, which cannot be checked against the deny-list`);
  return check([text], `${file.text} is a script that`);
}

/** The link-creating program a command runs (`ln`, `cp -s`, also behind wrappers), if any. */
function createsLink(command: Command): string | undefined {
  const names = command.words.map((word) => path.basename(word.text));
  const link = names.find((name) => name === 'ln' || name === 'link' || name === 'mklink');
  if (link) return link;
  if (
    names.includes('cp') &&
    (hasShort(command.words, 's') || hasFlag(command.words, '--symbolic-link'))
  )
    return 'cp -s';
  return undefined;
}

/** Patterns recognisable only on the raw text. */
function rawDanger(command: string): Classification | undefined {
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return danger('fork bomb');
  if (/>\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)/.test(command))
    return danger('overwrites a raw disk device');
  if (/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(command))
    return danger('pipes a remote download into a shell');
  return undefined;
}

/** Classify a shell command statically (see module comment). */
export function classifyShell(command: string, context: RuleContext): Classification {
  const trimmed = command.trim();
  if (!trimmed) return read('empty command');
  const deny = context.deny ?? [];
  const listed = denyMatch(trimmed, deny);
  if (listed) return listed;
  const raw = rawDanger(trimmed);
  if (raw) return raw;
  const lexed = lex(trimmed);
  if ('complex' in lexed) return unknown(`uses ${lexed.complex}`);
  const state: State = { cwd: realResolve(context.cwd), paths: new Paths(context), deny };
  let result = read();
  // Paths are resolved now, before the command runs: once it creates a link
  // (`ln -s ~ h; cat h/.ssh/id_rsa`), later paths may lead anywhere.
  let linked: string | undefined;
  for (const pipeline of lexed.pipelines) {
    for (let index = 0; index < pipeline.length; index++) {
      const command = pipeline[index]!;
      const name = path.basename(command.words[0]?.text ?? '');
      if (
        index > 0 &&
        (INTERPRETERS.has(name) || name === 'xargs') &&
        !command.words.slice(1).some((w) => !w.text.startsWith('-'))
      ) {
        const source = path.basename(pipeline[index - 1]!.words[0]?.text ?? '');
        if (source === 'curl' || source === 'wget')
          return danger('pipes a remote download into an interpreter');
      }
      result = worst(result, classifyCommand(command, state));
      if (result.verdict === 'danger') return result;
      if (linked)
        result = worst(
          result,
          unknown(`runs after ${linked} creates a link; its paths may resolve elsewhere`),
        );
      linked ??= createsLink(command);
    }
  }
  return result;
}
