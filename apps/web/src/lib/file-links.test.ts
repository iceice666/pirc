// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { localFilePath, onFilePreviewRequest, parseFileLink } from './file-links';
import { enhanceMarkdown, renderMarkdown } from './markdown';

describe('localFilePath', () => {
  it.each([
    ['src/App.svelte', 'src/App.svelte'],
    ['./src/App.svelte', 'src/App.svelte'],
    ['/Users/me/code/pirc/README.md', '/Users/me/code/pirc/README.md'],
    ['/Users/me/code/pirc/src/a.ts:42', '/Users/me/code/pirc/src/a.ts'],
    ['src/a.ts:42:7', 'src/a.ts'],
    ['src/a.ts#L10-L20', 'src/a.ts'],
    ['file:///Users/me/a%20b.ts', '/Users/me/a b.ts'],
    ['plans/%E8%A8%88%E5%8A%83.md', 'plans/計劃.md'],
  ])('%s → %s', (href, path) => expect(localFilePath(href)).toBe(path));

  it.each([
    'https://example.com/a.ts',
    'mailto:a@b.c',
    '#heading',
    '//cdn.example/x.js',
    '',
    'src/',
  ])('ignores %s', (href) => expect(localFilePath(href)).toBeUndefined());

  it('resolves relative links against a document folder', () => {
    expect(localFilePath('../README.md', 'docs/guide')).toBe('docs/README.md');
    expect(localFilePath('img/a.png', 'docs')).toBe('docs/img/a.png');
    expect(localFilePath('/abs/x.md', 'docs')).toBe('/abs/x.md');
  });
});

describe('parseFileLink', () => {
  it.each([
    ['src/a.ts', { path: 'src/a.ts' }],
    ['src/a.ts:42', { path: 'src/a.ts', line: 42 }],
    ['src/a.ts:42:7', { path: 'src/a.ts', line: 42 }],
    ['src/a.ts:10-20', { path: 'src/a.ts', line: 10, endLine: 20 }],
    ['src/a.ts#L10', { path: 'src/a.ts', line: 10 }],
    ['src/a.ts#L10-L20', { path: 'src/a.ts', line: 10, endLine: 20 }],
    ['src/a.ts#L10C2-L12C4', { path: 'src/a.ts', line: 10, endLine: 12 }],
    ['file:///x/a.ts:3', { path: '/x/a.ts', line: 3 }],
  ])('%s', (href, target) => expect(parseFileLink(href)).toEqual(target));
});

describe('bare paths in markdown', () => {
  it.each([
    ['see src/lib/a.ts:12 now', 'src/lib/a.ts:12'],
    ['修改了 apps/web/src/App.svelte。', 'apps/web/src/App.svelte'],
    ['at /Users/me/pirc/README.md.', '/Users/me/pirc/README.md'],
    ['(../docs/guide.md)', '../docs/guide.md'],
    ['.github/workflows/ci.yml', '.github/workflows/ci.yml'],
  ])('links %s', (source, path) => {
    expect(renderMarkdown(source)).toContain(`<a href="${path}" data-file-link="">${path}</a>`);
  });

  it.each([
    'visit https://example.com/a/b.html',
    'visit www.example.com/a.html',
    'ratio 1/2.5 and and/or',
    'plain App.svelte',
    'dir src/lib/ only',
  ])('leaves %s alone', (source) => {
    expect(renderMarkdown(source)).not.toContain('data-file-link');
  });

  it('links inline code that is a path, but not inside a link', () => {
    expect(renderMarkdown('edit `src/a.ts:3`')).toContain(
      '<a href="src/a.ts:3" data-file-link=""><code>src/a.ts:3</code></a>',
    );
    expect(renderMarkdown('run `npm test`, `App.svelte`')).not.toContain('data-file-link');
    const nested = renderMarkdown('[`src/a.ts`](src/b.ts) [src/c.ts](src/d.ts)');
    expect(nested.match(/<a /g)).toHaveLength(2);
    expect(nested).toContain('<a href="src/b.ts" data-file-link=""><code>src/a.ts</code></a>');
    expect(nested).toContain('<a href="src/d.ts" data-file-link="">src/c.ts</a>');
  });

  it('keeps inline code escaped', () => {
    expect(renderMarkdown('`<b>&`')).toContain('<code>&lt;b&gt;&amp;</code>');
  });
});

describe('file links in markdown', () => {
  it('marks file links and keeps web links opening in a new tab', () => {
    const html = renderMarkdown('[a](src/a.ts:3) [b](file:///tmp/b.md) [web](https://example.com)');
    expect(html).toContain('<a href="src/a.ts:3" data-file-link="">a</a>');
    expect(html).toContain('<a href="/tmp/b.md" data-file-link="">b</a>');
    expect(html).toContain('href="https://example.com" target="_blank"');
  });

  it('turns a click into a preview request', () => {
    const node = document.createElement('div');
    node.innerHTML = renderMarkdown('see [a](docs/a.md#L2)');
    document.body.append(node);
    const listener = vi.fn();
    const stop = onFilePreviewRequest(listener);
    const action = enhanceMarkdown(node, { html: node.innerHTML, ready: false });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    node.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(listener).toHaveBeenCalledWith({ path: 'docs/a.md', line: 2 });
    action.destroy();
    stop();
    node.remove();
  });
});
