/**
 * Markdown → sanitized HTML for conversation content.
 *
 * - GFM (tables, task lists, strikethrough) via marked
 * - LaTeX via KaTeX: `$…$`, `\(…\)` inline; `$$…$$`, `\[…\]` display
 * - Syntax highlighting via highlight.js (common languages)
 * - ```mermaid blocks become placeholders rendered lazily by {@link enhanceMarkdown}
 *
 * Output is always passed through DOMPurify: model output and tool results are untrusted.
 */
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function renderMath(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      trust: false,
      maxExpand: 500,
    });
  } catch {
    return `<code class="math-error">${escapeHtml(source)}</code>`;
  }
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.match(/\$\$|\\\[/)?.index,
  tokenizer(src) {
    const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[^\S\n]*(?:\n|$)/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: (match[1] ?? match[2] ?? '').trim() };
  },
  renderer: (token) => `<div class="math-block">${renderMath(token.text, true)}</div>\n`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    // $$…$$ used inline (e.g. inside a sentence or list item) still renders as display math.
    const display = /^\$\$([^$]+?)\$\$/.exec(src);
    if (display)
      return { type: 'inlineMath', raw: display[0], text: display[1]!.trim(), display: true };
    const paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (paren) return { type: 'inlineMath', raw: paren[0], text: paren[1]!.trim(), display: false };
    // `$x$`: no space inside the delimiters and no digit right after, so "$5 and $10" stays text.
    const dollar = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (dollar) return { type: 'inlineMath', raw: dollar[0], text: dollar[1]!, display: false };
    return undefined;
  },
  renderer: (token) => renderMath(token.text, !!token.display),
};

function highlight(code: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [blockMath, inlineMath],
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').trim().split(/\s+/)[0]!.toLowerCase();
      if (language === 'mermaid')
        // Source lives in the text node: DOMPurify drops attributes containing `-->`.
        return `<div class="mermaid-block"><pre class="mermaid-source"><code>${escapeHtml(text)}</code></pre></div>\n`;
      if (language === 'math' || language === 'latex' || language === 'tex')
        return `<div class="math-block">${renderMath(text, true)}</div>\n`;
      const label = language || 'text';
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy>Copy</button></div><pre><code class="hljs language-${escapeHtml(label)}">${highlight(text, language)}</code></pre></div>\n`;
    },
    table(token: Tokens.Table) {
      // Wrap so wide tables scroll horizontally instead of stretching the timeline.
      const header = token.header
        .map(
          (cell) =>
            `<th${cell.align ? ` align="${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</th>`,
        )
        .join('');
      const rows = token.rows
        .map(
          (row) =>
            `<tr>${row
              .map(
                (cell) =>
                  `<td${cell.align ? ` align="${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
    },
  },
});

let hooked = false;
function purifier() {
  if (!hooked && typeof window !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

/** Close an unterminated code fence so a streaming message renders stably. */
function closeOpenFence(source: string): string {
  const fences = source.match(/^ {0,3}(`{3,}|~{3,})/gm);
  if (!fences || fences.length % 2 === 0) return source;
  const fence = fences[fences.length - 1]!.trim();
  return `${source}\n${fence}`;
}

export function renderMarkdown(source: string, options: { streaming?: boolean } = {}): string {
  if (!source) return '';
  const input = options.streaming ? closeOpenFence(source) : source;
  const html = marked.parse(input, { async: false });
  return purifier().sanitize(html, {
    ADD_ATTR: ['target', 'data-copy'],
    ADD_TAGS: ['semantics', 'annotation'],
  });
}

/** Highlight a standalone snippet (tool input/output). Returns sanitized HTML. */
export function highlightCode(code: string, language?: string): string {
  return highlight(code, language ?? '');
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  html: 'xml',
  xml: 'xml',
  svelte: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  lua: 'lua',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  r: 'r',
  pl: 'perl',
  mk: 'makefile',
};

export function languageForPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const name = path.split('/').pop() ?? '';
  if (/^(Makefile|GNUmakefile)$/.test(name)) return 'makefile';
  if (name === 'Dockerfile') return 'dockerfile';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_LANGUAGES[extension];
}

type MermaidApi = typeof import('mermaid').default;
let mermaidLoader: Promise<MermaidApi> | undefined;
let mermaidCount = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'base',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      themeVariables: matchMedia('(prefers-color-scheme: dark)').matches
        ? { fontSize: '13px' }
        : {
            background: '#ffffff',
            primaryColor: '#edf3fe',
            primaryBorderColor: '#4176e6',
            primaryTextColor: '#0f1115',
            lineColor: '#81858c',
            secondaryColor: '#f1f3f5',
            tertiaryColor: '#f9fafb',
            fontSize: '13px',
          },
    });
    return mermaid;
  });
  return mermaidLoader;
}

async function renderMermaidBlocks(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-rendered])')];
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  for (const block of blocks) {
    const source = block.querySelector('.mermaid-source code')?.textContent ?? '';
    block.dataset.rendered = 'pending';
    try {
      const { svg } = await mermaid.render(`pirc-mermaid-${++mermaidCount}`, source);
      if (!block.isConnected) continue;
      const figure = document.createElement('div');
      figure.className = 'mermaid-figure';
      figure.innerHTML = svg;
      block.prepend(figure);
      block.dataset.rendered = 'ok';
    } catch (error) {
      block.dataset.rendered = 'error';
      const note = document.createElement('p');
      note.className = 'mermaid-error';
      note.textContent = `Mermaid: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid diagram'}`;
      block.append(note);
    }
  }
}

/**
 * Svelte action: copy buttons on code blocks and lazy Mermaid rendering.
 * Diagrams render only once `ready` is true (i.e. the message stopped streaming),
 * since a half-written diagram cannot be parsed.
 */
export function enhanceMarkdown(node: HTMLElement, params: { html: string; ready: boolean }) {
  const onClick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!button || !node.contains(button)) return;
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 1400);
    });
  };
  node.addEventListener('click', onClick);
  const run = (next: { ready: boolean }) => {
    if (next.ready) void renderMermaidBlocks(node);
  };
  run(params);
  return {
    update: (next: { html: string; ready: boolean }) => queueMicrotask(() => run(next)),
    destroy: () => node.removeEventListener('click', onClick),
  };
}
