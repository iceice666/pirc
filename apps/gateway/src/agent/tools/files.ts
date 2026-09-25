import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { truncateOutput } from '../sandbox.js';
import { optionalNumber, requireString, text, type Tool } from './types.js';

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const readTool: Tool = {
  name: 'read',
  ptc: true,
  description:
    'Read a file. Text is returned with line numbers (`offset` is 1-based, default limit 2000 lines). Images (png/jpg/gif/webp) are returned as images.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute' },
      offset: { type: 'number', description: '1-based first line' },
      limit: { type: 'number', description: 'Maximum lines to return' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const file = ctx.guard.resolve(requireString(args, 'path'), 'read');
    const info = await stat(file);
    if (info.isDirectory()) throw new Error(`${args.path} is a directory; use ls`);
    const mime = imageTypes[path.extname(file).toLowerCase()];
    if (mime) {
      if (info.size > 5 * 1024 * 1024) throw new Error('Image is larger than 5 MiB');
      return {
        content: [
          { type: 'text', text: `Image ${args.path} (${info.size} bytes)` },
          { type: 'image', data: (await readFile(file)).toString('base64'), mimeType: mime },
        ],
      };
    }
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n');
    const offset = Math.max(1, Math.floor(optionalNumber(args, 'offset') ?? 1));
    const limit = Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? 2000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    let body = slice
      .map((line, index) => `${String(offset + index).padStart(width)}\t${line.slice(0, 4000)}`)
      .join('\n');
    const end = offset - 1 + slice.length;
    if (end < lines.length)
      body += `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
    return text(truncateOutput(body, ctx.config.limits.toolOutputBytes * 2).text);
  },
};

export const writeTool: Tool = {
  name: 'write',
  ptc: true,
  description: 'Create or overwrite a file with the given content. Parent directories are created.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const file = ctx.guard.resolve(requireString(args, 'path'), 'write');
    if (typeof args.content !== 'string') throw new Error('content must be a string');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, args.content);
    return text(`Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`);
  },
};

function simpleDiff(before: string, after: string, file: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - 3);
  const lines = [`--- ${file}`, `+++ ${file}`, `@@ -${from + 1} +${from + 1} @@`];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 4); i++) lines.push(` ${a[i]}`);
  return lines.join('\n');
}

export const editTool: Tool = {
  name: 'edit',
  ptc: true,
  description:
    'Replace exact text in a file. `oldText` must match exactly once unless `replaceAll` is true. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const file = ctx.guard.resolve(requireString(args, 'path'), 'write');
    const oldText = requireString(args, 'oldText');
    if (typeof args.newText !== 'string') throw new Error('newText must be a string');
    const before = await readFile(file, 'utf8');
    const count = before.split(oldText).length - 1;
    if (count === 0) throw new Error(`oldText not found in ${args.path}`);
    if (count > 1 && !args.replaceAll)
      throw new Error(
        `oldText matches ${count} times in ${args.path}; add context or set replaceAll`,
      );
    const after = args.replaceAll
      ? before.split(oldText).join(args.newText)
      : before.replace(oldText, () => args.newText as string);
    await writeFile(file, after);
    const diff = simpleDiff(before, after, String(args.path));
    return text(`Edited ${args.path} (${count} replacement${count === 1 ? '' : 's'})`, { diff });
  },
};

export const lsTool: Tool = {
  name: 'ls',
  ptc: true,
  description: 'List a directory (directories end with /).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Default: workspace root' } },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const dir = ctx.guard.resolve(
      typeof args.path === 'string' && args.path ? args.path : '.',
      'read',
    );
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, 1000);
    return text(
      shown.join('\n') +
        (names.length > shown.length ? `\n[${names.length - shown.length} more]` : '') || '(empty)',
    );
  },
};

const skipDirs = new Set(['.git', 'node_modules', '.direnv', 'result', 'dist', 'target']);

async function* walk(root: string, limit: { left: number }): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length && limit.left > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        if (limit.left-- <= 0) return;
        yield full;
      }
    }
  }
}

export const findTool: Tool = {
  name: 'find',
  ptc: true,
  description:
    'Find files by glob pattern (e.g. "**/*.ts"). Skips .git, node_modules, dist, target, result.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search (default workspace)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const root = ctx.guard.resolve(
      typeof args.path === 'string' && args.path ? args.path : '.',
      'read',
    );
    const glob = new Bun.Glob(requireString(args, 'pattern'));
    const matches: string[] = [];
    for await (const file of walk(root, { left: 200_000 })) {
      const relative = path.relative(root, file);
      if (glob.match(relative)) matches.push(relative);
      if (matches.length >= 500) break;
    }
    return text(matches.sort().join('\n') || 'No matches');
  },
};

export const grepTool: Tool = {
  name: 'grep',
  ptc: true,
  description:
    'Search file contents with a JavaScript regular expression. Returns `path:line: text`. Optional `glob` filters files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean' },
      limit: { type: 'number', description: 'Maximum matches (default 200)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const root = ctx.guard.resolve(
      typeof args.path === 'string' && args.path ? args.path : '.',
      'read',
    );
    const regex = new RegExp(requireString(args, 'pattern'), args.ignoreCase ? 'i' : '');
    const filter = typeof args.glob === 'string' && args.glob ? new Bun.Glob(args.glob) : undefined;
    const limit = Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? 200));
    const results: string[] = [];
    const info = await stat(root);
    const files = info.isFile() ? [root] : walk(root, { left: 100_000 });
    const base = info.isFile() ? path.dirname(root) : root;
    for await (const file of files) {
      if (ctx.signal.aborted) throw new Error('Aborted');
      const relative = path.relative(base, file);
      if (filter && !filter.match(relative) && !filter.match(path.basename(file))) continue;
      let content: string;
      try {
        const size = (await stat(file)).size;
        if (size > 2 * 1024 * 1024) continue;
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (regex.test(lines[index]!)) {
          results.push(`${relative}:${index + 1}: ${lines[index]!.slice(0, 300)}`);
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }
    return text(
      results.length
        ? results.join('\n') + (results.length >= limit ? `\n[limit ${limit} reached]` : '')
        : 'No matches',
    );
  },
};
