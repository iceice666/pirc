// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as markdown from '../markdown';
import { reactiveProps } from '../testing/props.svelte';
import Markdown from './Markdown.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('streaming Markdown', () => {
  it('renders completed blocks once and re-renders only the last one', () => {
    const props = reactiveProps({ source: '# Title\n\nFirst para', streaming: true });
    component = mount(Markdown, { target, props });
    flushSync();
    const heading = target.querySelector('h1')!;
    expect(heading.textContent).toBe('Title');
    const render = vi.spyOn(markdown, 'renderMarkdownChecked');

    props.source = '# Title\n\nFirst paragraph grows';
    flushSync();
    vi.advanceTimersByTime(100);
    flushSync();
    expect(target.querySelector('p')!.textContent).toBe('First paragraph grows');
    // The heading's DOM node survived; only the paragraph was parsed again.
    expect(target.querySelector('h1')).toBe(heading);
    expect(render.mock.calls.map(([source]) => source)).toEqual(['First paragraph grows']);

    props.source = '# Title\n\nFirst paragraph grows\n\n```ts\nconst x';
    flushSync();
    vi.advanceTimersByTime(100);
    flushSync();
    expect(target.querySelector('h1')).toBe(heading);
    expect(target.querySelector('.code-block')).not.toBeNull();
  });

  it('renders the finished message whole', () => {
    const props = reactiveProps({ source: 'a\n\nb', streaming: true });
    component = mount(Markdown, { target, props });
    flushSync();
    props.source = 'a\n\nb\n\nc';
    props.streaming = false;
    flushSync();
    const markup = target.querySelector('.markdown')!.innerHTML.replace(/<!---->/g, '');
    expect(markup.trim()).toBe(markdown.renderMarkdown('a\n\nb\n\nc').trim());
  });
});
