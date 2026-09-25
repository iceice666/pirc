/**
 * Read-only workspace inspection for the web side panel: Git status, diffs,
 * history and a file browser. Every path is resolved inside the workspace
 * (after following symlinks); Git runs without a shell, without optional
 * locks (so it never contends with the agent's own Git commands) and without
 * external diff/textconv drivers.
 */
import {
  lstatSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.js';

const GIT_TIMEOUT_MS = 15_000;
const DIFF_LIMIT = 1_048_576;
const FILE_LIMIT = 1_048_576;
const DIR_LIMIT = 2_000;
const SHA = /^[0-9a-f]{4,64}$/i;

interface GitResult {
  code: number;
  stdout: string;
  truncated: boolean;
}

async function git(cwd: string, args: string[], limit = DIFF_LIMIT): Promise<GitResult> {
  const proc = Bun.spawn(
    [
      'git',
      '--no-pager',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'color.ui=false',
      ...args,
    ],
    {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
      },
    },
  );
  const timer = setTimeout(() => proc.kill('SIGKILL'), GIT_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = proc.stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        chunks.push(value.subarray(0, limit - size));
        size = limit;
        truncated = true;
        proc.kill('SIGKILL');
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const stdout = Buffer.concat(chunks).toString('utf8');
  if (code !== 0 && !truncated && code !== 1)
    throw new ApiError(
      400,
      'invalid_input',
      stderr.trim().split('\n').slice(-3).join('\n') || `git exited with ${code}`,
    );
  return { code, stdout, truncated };
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    throw new ApiError(404, 'not_found', 'Workspace directory is missing');
  }
}

/** Resolve `relative` inside `root`, following symlinks; rejects escapes. */
export function resolveInside(root: string, relative: string): string {
  if (relative.includes('\0')) throw new ApiError(400, 'invalid_input', 'Invalid path');
  root = realRoot(root);
  const joined = path.resolve(root, relative.replace(/^\/+/, ''));
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    throw new ApiError(404, 'not_found', 'Path not found');
  }
  const rel = path.relative(root, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new ApiError(403, 'forbidden', 'Path is outside the workspace');
  return real;
}

/** A Git pathspec argument that never expands magic or globs. */
function pathspec(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..')
    throw new ApiError(400, 'invalid_input', 'Invalid path');
  // The parent directory must still resolve inside the workspace (deleted files are fine).
  resolveInside(root, path.posix.dirname(normalized));
  return `:(literal)${normalized}`;
}

export interface GitFile {
  path: string;
  origPath?: string;
  /** Porcelain XY codes: index (staged) and worktree (unstaged). '?' = untracked. */
  index: string;
  worktree: string;
}

export async function gitStatus(root: string) {
  root = realRoot(root);
  let top: string;
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch {
    return { repo: false as const };
  }
  const { stdout } = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--branch',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  const records = stdout.split('\0');
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith('## ')) {
      const header = record.slice(3);
      const match = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(header);
      branch = match?.[1] ?? header;
      if (branch.startsWith('No commits yet on ')) branch = branch.slice(18);
      upstream = match?.[2] ?? null;
      ahead = Number(/ahead (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
      continue;
    }
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const file: GitFile = { path: record.slice(3), index, worktree };
    // Renames and copies carry the original path as the next record.
    if (index === 'R' || index === 'C') file.origPath = records[++i] ?? '';
    files.push(file);
  }
  const prefix = path.relative(top, root);
  return {
    repo: true as const,
    root: prefix ? prefix.split(path.sep).join('/') : '',
    branch,
    upstream,
    ahead,
    behind,
    files: files.slice(0, 5_000),
    truncated: files.length > 5_000,
  };
}

/**
 * Unified diff of one path (or the whole workspace): worktree vs index, or
 * index vs HEAD when `staged`. Untracked files diff against /dev/null.
 */
export async function gitDiff(
  root: string,
  options: { path?: string | undefined; staged?: boolean; untracked?: boolean },
) {
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  root = realRoot(root);
  if (options.untracked && options.path) {
    const file = resolveInside(root, options.path);
    if (!statSync(file).isFile()) throw new ApiError(400, 'invalid_input', 'Not a file');
    const result = await git(root, [
      ...base,
      '--no-index',
      '--',
      '/dev/null',
      path.relative(root, file),
    ]);
    return { diff: result.stdout, truncated: result.truncated };
  }
  const spec = options.path ? pathspec(root, options.path) : '.';
  const result = await git(root, [...base, ...(options.staged ? ['--cached'] : []), '--', spec]);
  return { diff: result.stdout, truncated: result.truncated };
}

export async function gitLog(root: string, options: { skip: number; limit: number }) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return { commits: [], more: false };
  }
  const { stdout } = await git(root, [
    'log',
    `--max-count=${options.limit + 1}`,
    `--skip=${options.skip}`,
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e',
    '--',
    '.',
  ]);
  const commits = stdout
    .split('\x1e')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, short, author, email, time, refs, subject] = line.split('\x1f');
      return {
        sha: sha!,
        short: short!,
        author: author ?? '',
        email: email ?? '',
        time: Number(time) * 1000,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        subject: subject ?? '',
      };
    });
  return { commits: commits.slice(0, options.limit), more: commits.length > options.limit };
}

export async function gitShow(root: string, sha: string) {
  if (!SHA.test(sha)) throw new ApiError(400, 'invalid_input', 'Invalid commit id');
  const header = await git(root, [
    'show',
    '-s',
    '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%B',
    sha,
    '--',
  ]);
  const [full, author, email, time, refs, ...body] = header.stdout.split('\x1f');
  const patch = await git(root, [
    'show',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    '--format=',
    '--patch',
    '--stat=200',
    sha,
    '--',
  ]);
  return {
    sha: full!,
    author: author ?? '',
    email: email ?? '',
    time: Number(time) * 1000,
    refs: refs ? refs.split(', ').filter(Boolean) : [],
    message: body.join('\x1f').trim(),
    diff: patch.stdout,
    truncated: patch.truncated,
  };
}

export function listDirectory(root: string, relative: string) {
  root = realRoot(root);
  const dir = resolveInside(root, relative || '.');
  if (!statSync(dir).isDirectory()) throw new ApiError(400, 'invalid_input', 'Not a directory');
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git')
    .map((entry) => {
      let kind: 'dir' | 'file' | 'symlink' | 'other' = entry.isDirectory()
        ? 'dir'
        : entry.isFile()
          ? 'file'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other';
      let size: number | undefined;
      const full = path.join(dir, entry.name);
      try {
        if (kind === 'symlink' && statSync(full).isDirectory()) kind = 'dir';
        if (kind === 'file') size = lstatSync(full).size;
      } catch {
        /* dangling link */
      }
      return { name: entry.name, kind, ...(size === undefined ? {} : { size }) };
    })
    .sort((a, b) =>
      a.kind === 'dir' && b.kind !== 'dir'
        ? -1
        : b.kind === 'dir' && a.kind !== 'dir'
          ? 1
          : a.name.localeCompare(b.name),
    );
  const rel = path.relative(root, dir);
  return {
    path: rel ? rel.split(path.sep).join('/') : '',
    entries: entries.slice(0, DIR_LIMIT),
    truncated: entries.length > DIR_LIMIT,
  };
}

export function readWorkspaceFile(root: string, relative: string) {
  root = realRoot(root);
  const file = resolveInside(root, relative);
  const stat = statSync(file);
  if (!stat.isFile()) throw new ApiError(400, 'invalid_input', 'Not a file');
  const length = Math.min(stat.size, FILE_LIMIT);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (!read) break;
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
  const binary = buffer.subarray(0, 8192).includes(0);
  const rel = path.relative(root, file).split(path.sep).join('/');
  return {
    path: rel,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    binary,
    truncated: stat.size > FILE_LIMIT,
    ...(binary ? {} : { content: buffer.toString('utf8') }),
  };
}
