// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as markdown from '../markdown';
import Markdown from './Markdown.svelte';

// Separate file: module state (loaded renderers) is per test file.
const mounted: Array<{ component: ReturnType<typeof mount>; target: HTMLElement }> = [];
function render(source: string) {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(Markdown, { target, props: { source } });
  mounted.push({ component, target });
  return target;
}

afterEach(async () => {
  for (const { component, target } of mounted.splice(0)) {
    await unmount(component);
    target.remove();
  }
});

describe('Markdown', () => {
  it('re-renders only fallback output once a renderer loads', async () => {
    const spy = vi.spyOn(markdown, 'renderMarkdownChecked');
    const code = render('```ts\nconst x = 1;\n```');
    render('Just prose.');
    flushSync();
    expect(code.innerHTML).not.toContain('hljs-keyword');
    const initial = spy.mock.calls.length;

    await markdown.preloadRenderers();
    flushSync();
    // Re-rendering waits for idle time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushSync();
    expect(code.innerHTML).toContain('hljs-keyword');
    expect(spy.mock.calls.length - initial).toBe(1);
  });
});
