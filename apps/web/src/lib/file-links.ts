/**
 * Workspace file links in rendered Markdown.
 *
 * Agents cite files as ordinary Markdown links (`[App.svelte](/abs/path/App.svelte:42)`,
 * `[x](src/x.ts#L10)`, `file:///…`) or as bare text / inline code
 * (`src/x.ts:10`, which the renderer turns into links; see {@link FILE_PATH_SOURCE}).
 * Followed as URLs they 404 against the web app, so {@link enhanceMarkdown}
 * intercepts them and asks the side panel to preview the file instead.
 */

/** A file to preview, optionally at a line range (1-based, inclusive). */
export interface FileTarget {
  /** Workspace-relative or absolute. */
  path: string;
  line?: number;
  endLine?: number;
}

type Listener = (target: FileTarget) => void;
const listeners = new Set<Listener>();

/** Listen for preview requests. Returns an unsubscribe. */
export function onFilePreviewRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestFilePreview(target: FileTarget) {
  for (const listener of listeners) listener(target);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Collapse `.` / `..` segments (never above the start of a relative path). */
function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (part === '..' && absolute) continue;
    else out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/** `file:///a/b` → `/a/b` (DOMPurify would drop the `file:` URL). */
export const stripFileScheme = (href: string) =>
  href.trim().replace(/^file:(\/\/(localhost)?)?/i, '');

function lines(start?: string, end?: string): Pick<FileTarget, 'line' | 'endLine'> {
  const line = start ? Number(start) : 0;
  if (!line) return {};
  const endLine = end ? Number(end) : 0;
  return endLine > line ? { line, endLine } : { line };
}

/**
 * The file an `href` points at, or undefined for web links, anchors and
 * other schemes. Line suffixes `:12`, `:12:3`, `:12-20`, `#L12`, `#L12-L20`
 * become a line range. A relative path resolves against `base` (the
 * directory of the document it appears in; the workspace root for
 * conversation messages).
 */
export function parseFileLink(href: string | null | undefined, base = ''): FileTarget | undefined {
  let value = (href ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return undefined;
  if (/^file:/i.test(value)) value = stripFileScheme(value);
  else if (SCHEME.test(value)) return undefined;
  const hash = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(value);
  value = decode(value.replace(/[?#].*$/, ''));
  const suffix = /:(\d+)(?::\d+|-(\d+))?$/.exec(value);
  if (suffix) value = value.slice(0, suffix.index);
  if (!value || value.endsWith('/')) return undefined;
  const path = normalize(value.startsWith('/') || !base ? value : `${base}/${value}`);
  if (!path || path === '/') return undefined;
  return { path, ...(hash ? lines(hash[1], hash[2]) : lines(suffix?.[1], suffix?.[2])) };
}

export function localFilePath(href: string | null | undefined, base = ''): string | undefined {
  return parseFileLink(href, base)?.path;
}

/**
 * A path written as plain text: optional `/`, `./` or `../`, at least one
 * directory, and a file name with an extension containing a letter (so
 * `1/2.5` or `and/or` stay text), plus an optional `:line` suffix.
 */
export const FILE_PATH_SOURCE = String.raw`(?!www\.)(?:\/|(?:\.{1,2}\/)+)?(?:[\w@+-][\w@.+-]*\/|\.[\w@+-][\w@.+-]*\/)+[\w@.+-]*\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*(?::\d+(?:[:-]\d+)?)?`;
/** Not preceded by a path or URL character, not followed by one. */
const BEFORE = String.raw`(?<![\w@.+\-/:~\\])`;
const AFTER = String.raw`(?![\w/])`;

/** Leading bare path in `src`, if any. */
export const BARE_PATH = new RegExp(`^${FILE_PATH_SOURCE}${AFTER}`);
/** First bare path anywhere in `src` (for marked's `start`). */
export const BARE_PATH_SEARCH = new RegExp(`${BEFORE}${FILE_PATH_SOURCE}${AFTER}`);
/** Inline code that is exactly a path. */
export const CODE_PATH = new RegExp(`^${FILE_PATH_SOURCE}$`);
