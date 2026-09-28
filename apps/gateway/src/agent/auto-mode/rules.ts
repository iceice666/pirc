/**
 * Static shell-command classifier for auto mode. It decides, without a model,
 * whether a command only reads, writes inside the workspace, is dangerous, or
 * cannot be judged statically (`unknown`, handed to the model classifier).
 *
 * The rules err on the side of `unknown`: anything the lexer does not fully
 * understand (command substitution, heredocs, interpreters, unresolvable
 * paths) is never declared `read`.
 */
import os from 'node:os';
import path from 'node:path';
import { realResolve } from '../sandbox.js';

export type Verdict = 'read' | 'write' | 'danger' | 'unknown';

export interface Classification {
  verdict: Verdict;
  reason: string;
}

export interface RuleContext {
  /** Directory the command starts in. */
  cwd: string;
  /** Canonical roots the agent may write (workspace and allowed paths). */
  roots: readonly string[];
  /** Paths the agent may never write (its own configuration). */
  protectedPaths?: readonly string[];
  home?: string;
}

const RANK: Record<Verdict, number> = { read: 0, write: 1, unknown: 2, danger: 3 };

function worst(a: Classification, b: Classification): Classification {
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
  /** Contains an unresolved expansion (`$VAR`, globs); its value is not known statically. */
  dynamic: boolean;
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
    if (c === '$' || c === '*' || c === '?' || c === '[') current().dynamic = true;
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
    this.secrets = [
      ...SECRET_HOME_PATHS.map((item) => realResolve(path.join(this.home, item))),
      ...SECRET_SYSTEM_PATHS,
    ];
  }

  /** Absolute path of a word, or undefined when it cannot be known statically. */
  resolve(word: Word, cwd: string | undefined): string | undefined {
    if (word.dynamic) return undefined;
    let text = word.text;
    if (!word.quoted && (text === '~' || text.startsWith('~/')))
      text = path.join(this.home, text.slice(1));
    else if (!word.quoted && text.startsWith('~')) return undefined; // ~user
    if (!path.isAbsolute(text)) {
      if (!cwd) return undefined;
      text = path.resolve(cwd, text);
    }
    return realResolve(text);
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

interface State {
  cwd: string | undefined;
  paths: Paths;
}

function checkWrites(
  targets: Word[],
  state: State,
  destructive: boolean,
  what: string,
): Classification {
  let wrote = false;
  for (const target of targets) {
    if (HARMLESS.has(target.text)) continue;
    wrote = true;
    const absolute = state.paths.resolve(target, state.cwd);
    if (!absolute) return unknown(`${what} a path that cannot be resolved statically`);
    const risk = state.paths.writeRisk(absolute, destructive);
    if (risk) return danger(risk);
  }
  return wrote ? write(`${what} files in the workspace`) : read();
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
    } else if (flag === '-c') i += 2;
    else if (flag.startsWith('--git-dir') || flag.startsWith('--work-tree'))
      return unknown('git with an explicit git dir or work tree');
    else i++;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (!cwd) return unknown('git in a directory that cannot be resolved statically');
  const inner = classifyGitSubcommand(sub, rest);
  const risk = state.paths.writeRisk(cwd, false);
  // Repository outside the workspace (or protected): reads are fine, writes are not.
  if (risk && inner.verdict !== 'read')
    return danger(`${`git ${sub ?? ''}`.trim()} in ${cwd}: ${risk}`);
  return inner;
}

/** Classify a git subcommand on its own, independently of the repository location. */
function classifyGitSubcommand(sub: string | undefined, rest: Word[]): Classification {
  const words = rest.map((word) => word.text);
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
      return hasFlag(rest, '--get', '--get-all', '--get-regexp', '--list', '-l') ||
        operands(rest).length === 1
        ? read('git config lookup')
        : write('git config');
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
      return write(`git ${sub}`);
  }
}

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
  // Leading environment assignments.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text) && !words[0]!.quoted)
    words.shift();
  // `env [-i] [NAME=value…] cmd`, `timeout 10 cmd`, `nohup cmd`, …
  for (;;) {
    const head = words[0]?.text;
    if (head === 'env') {
      words.shift();
      while (
        words.length &&
        (words[0]!.text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text))
      )
        words.shift();
      if (!words.length) return read('env listing');
    } else if (head === 'timeout') {
      words.shift();
      while (words.length && words[0]!.text.startsWith('-')) words.shift();
      words.shift();
    } else if (head && WRAPPERS.has(head)) {
      words.shift();
      while (words.length && words[0]!.text.startsWith('-')) words.shift();
    } else break;
  }

  let result = read();
  for (const redirect of command.redirects) {
    if (redirect.op.includes('<')) {
      const source = redirect.target && state.paths.resolve(redirect.target, state.cwd);
      if (source && state.paths.isSecret(source)) return danger(`reads credentials at ${source}`);
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
  for (const word of args) {
    const absolute = state.paths.resolve(word, state.cwd);
    if (absolute && state.paths.isSecret(absolute))
      return danger(`touches credentials at ${absolute}`);
  }

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
  if (
    name === 'export' ||
    name === 'unset' ||
    name === 'set' ||
    name === 'shopt' ||
    name === 'alias'
  )
    return result;

  if (READ_ONLY.has(name)) return result;

  const writer = PATH_WRITERS[name];
  if (writer) {
    if (name === 'tee' && !operands(args).length) return result;
    let targets = operands(args);
    if (writer === 'last') targets = targets.slice(-1);
    if (writer === 'afterFirst') targets = targets.slice(1);
    if (name === 'cp' || name === 'install') {
      const t = args.findIndex((word) => word.text === '-t' || word.text === '--target-directory');
      if (t >= 0 && args[t + 1]) targets = [args[t + 1]!];
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
      return worst(
        result,
        hasFlag(args, '--in-place') || args.some((w) => /^-[a-zA-Z]*i/.test(w.text))
          ? write('sed -i edits files in place')
          : read('sed'),
      );
    case 'sort':
      return worst(result, hasFlag(args, '-o', '--output') ? write('sort -o') : read('sort'));
    case 'find': {
      if (hasFlag(args, '-exec', '-execdir', '-ok', '-okdir'))
        return worst(result, unknown('find -exec runs commands'));
      if (hasFlag(args, '-fprint', '-fprint0', '-fprintf', '-fls'))
        return worst(result, write('find writes a file'));
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
      const out = args.findIndex((w) => w.text === '-o' || w.text === '--output');
      if (out >= 0 && args[out + 1])
        return worst(result, checkWrites([args[out + 1]!], state, false, 'curl downloads to'));
      if (hasFlag(args, '-O', '--remote-name'))
        return worst(result, write('curl downloads a file'));
      return worst(
        result,
        hasShort(args, 'X') || hasFlag(args, '--request')
          ? unknown('curl with a custom method')
          : read('curl GET'),
      );
    }
    case 'wget':
      return worst(result, write('wget downloads files'));
    case 'dd': {
      const of = args.find((w) => w.text.startsWith('of='));
      if (!of) return result;
      if (of.text.startsWith('of=/dev/') && !HARMLESS.has(of.text.slice(3)))
        return danger('dd writes to a raw device');
      return worst(
        result,
        checkWrites([{ ...of, text: of.text.slice(3) }], state, false, 'dd writes'),
      );
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
      return worst(result, write(`cargo ${sub ?? ''}`.trim()));
    }
    case 'go': {
      const sub = operands(args)[0]?.text;
      if (['env', 'version', 'list', 'doc', 'vet'].includes(sub ?? ''))
        return hasFlag(args, '-w') ? danger('go env -w changes global Go settings') : result;
      if (sub === 'install') return danger('go install changes globally installed tools');
      return worst(result, write(`go ${sub ?? ''}`.trim()));
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
      // The items read from stdin become unknown operands.
      const stdinItems: Word = { text: '{}', quoted: false, dynamic: true };
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

  if (PACKAGE_MANAGERS.has(name)) return worst(result, classifyPackageManager(name, args));
  if (BUILD_TOOLS.has(name)) {
    if (name === 'prettier' && !hasFlag(args, '--write', '-w')) return result;
    return worst(result, write(`${name} builds, formats or tests the workspace`));
  }
  if (INTERPRETERS.has(name) || ['eval', 'exec', 'source', '.'].includes(name))
    return worst(result, unknown(`${name} runs arbitrary code`));
  if (name.startsWith('./') || head.text.includes('/'))
    return worst(result, unknown('runs a local program'));
  return worst(result, unknown(`unrecognised command ${name}`));
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
  const raw = rawDanger(trimmed);
  if (raw) return raw;
  const lexed = lex(trimmed);
  if ('complex' in lexed) return unknown(`uses ${lexed.complex}`);
  const state: State = { cwd: realResolve(context.cwd), paths: new Paths(context) };
  let result = read();
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
    }
  }
  return result;
}
