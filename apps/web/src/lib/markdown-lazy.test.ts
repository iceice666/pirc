// @vitest-environment jsdom
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { preloadRenderers, renderMarkdown, rendererTick } from './markdown';

// Separate file: module state (loaded renderers) is per test file.
describe('lazy renderers', () => {
  it('renders plain text before KaTeX / highlight.js load, then bumps rendererTick', async () => {
    const before = get(rendererTick);
    const html = renderMarkdown('$x^2$\n\n```ts\nconst x = 1;\n```');
    expect(html).toContain('class="math-pending"');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('class="hljs language-ts">const x = 1;');
    expect(html).not.toContain('hljs-keyword');

    await preloadRenderers();
    expect(get(rendererTick)).toBe(before + 2);
    const loaded = renderMarkdown('$x^2$\n\n```ts\nconst x = 1;\n```');
    expect(loaded).toContain('class="katex"');
    expect(loaded).toContain('hljs-keyword');
  });
});
