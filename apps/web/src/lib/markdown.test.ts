// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders GFM and highlighted code', () => {
    const html = renderMarkdown(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('hljs-keyword');
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
