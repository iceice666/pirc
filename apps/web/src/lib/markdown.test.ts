// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { preloadRenderers, renderMarkdown, stableBlockEnd } from './markdown';

describe('renderMarkdown', () => {
  beforeAll(() => preloadRenderers());

  it('renders GFM and highlighted code', () => {
    const html = renderMarkdown(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('hljs-keyword');
  });

  it.each(['：', '，', '。', '！', '？', '」', '）'])(
    'renders bold ending in CJK punctuation %s without a following space',
    (punctuation) => {
      expect(renderMarkdown(`**驗證${punctuation}**新增 4 個測試`)).toContain(
        `<strong>驗證${punctuation}</strong>新增 4 個測試`,
      );
    },
  );

  it('preserves inline formatting inside CJK bold labels', () => {
    expect(renderMarkdown('**驗證 `check`：**新增')).toContain(
      '<strong>驗證 <code>check</code>：</strong>新增',
    );
    expect(renderMarkdown('- **驗證：**新增')).toContain('<strong>驗證：</strong>新增');
  });

  it('leaves escaped delimiters, code, and ordinary emphasis rules unchanged', () => {
    expect(renderMarkdown('`**驗證：**新增`')).toContain('<code>**驗證：**新增</code>');
    expect(renderMarkdown('```text\n**驗證：**新增\n```')).toContain('**驗證：**新增</code>');
    expect(renderMarkdown('\\*\\*驗證：\\*\\*新增')).not.toContain('<strong>');
    expect(renderMarkdown('**Label:**next')).not.toContain('<strong>');
    expect(renderMarkdown('**粗體**與 *斜體*')).toContain('<strong>粗體</strong>與 <em>斜體</em>');
    expect(renderMarkdown('**驗證：')).not.toContain('<strong>');
  });

  it('renders inline and display math but leaves prices alone', () => {
    const html = renderMarkdown('Area $\\pi r^2$ costs $5 and $10.\n\n$$\n\\int_0^1 x\\,dx\n$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="math-block"');
    expect(html).toContain('costs $5 and $10.');
  });

  it('leaves math inside code spans untouched', () => {
    expect(renderMarkdown('`$x$`')).toContain('<code>$x$</code>');
  });

  it('turns mermaid fences into lazy placeholders', () => {
    const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain('<code>graph TD; A--&gt;B</code>');
  });

  it('sanitizes raw HTML from model output', () => {
    const html = renderMarkdown(
      '<img src=x onerror="alert(1)"><script>alert(2)</script>[x](javascript:alert(3))',
    );
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  it('closes an open fence while streaming', () => {
    const html = renderMarkdown('text\n\n```py\nprint(1)', { streaming: true });
    expect(html).toContain('class="code-block"');
  });
});

describe('stableBlockEnd', () => {
  it.each([
    ['# Title\n\npara one\n\n- a\n- b\n\nlast', 28],
    ['```ts\nx\n\ny\n```\n\nafter', 16],
    ['| a | b |\n|---|---|\n| 1 | 2 |\n\ntext', 31],
    ['$$\nx\n\ny\n$$\n\nz', 12],
    ['> q\n\n> r\n\nz', 10],
  ])('splits %j where both halves render like the whole', (source, end) => {
    expect(stableBlockEnd(source)).toBe(end);
    expect(renderMarkdown(source.slice(0, end)) + renderMarkdown(source.slice(end))).toBe(
      renderMarkdown(source),
    );
  });

  it.each([
    ['one block', 'just a paragraph'],
    // A loose list is one block: splitting it would restart the numbering.
    ['a loose list', '1. a\n\n2. b\n\n3. c'],
    ['an open fence', '```ts\nopen\n\nstill'],
    ['CRLF text', 'a\r\n\r\nb'],
  ])('keeps %s whole', (_, source) => {
    expect(stableBlockEnd(source)).toBe(0);
  });

  it('continues from an earlier boundary', () => {
    const source = 'one\n\ntwo\n\nthree';
    expect(stableBlockEnd(source, 5)).toBe(10);
  });
});
