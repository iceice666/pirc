// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import StatusGlyph, { glyphOf } from './StatusGlyph.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  target = undefined;
});

function render(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(StatusGlyph, { target, props });
  flushSync();
  return target.querySelector('span')!;
}

it('maps every state vocabulary onto the four shapes', () => {
  expect(glyphOf('working')).toBe('working');
  expect(glyphOf('thinking')).toBe('working');
  expect(glyphOf('ongoing')).toBe('working');
  expect(glyphOf('waiting')).toBe('waiting');
  expect(glyphOf('waiting_input')).toBe('waiting');
  expect(glyphOf('queued')).toBe('waiting');
  expect(glyphOf('failed')).toBe('error');
  expect(glyphOf('offline')).toBe('error');
  expect(glyphOf('done')).toBe('idle');
  expect(glyphOf('completed')).toBe('idle');
  expect(glyphOf('something-new')).toBe('idle');
});

it('is decorative unless it carries a label', () => {
  const bare = render({ state: 'working' });
  expect(bare.getAttribute('aria-hidden')).toBe('true');
  expect(bare.hasAttribute('role')).toBe(false);
});

it('labels itself when it carries a label', () => {
  const labelled = render({ state: 'waiting', label: 'Waiting for you' });
  expect(labelled.getAttribute('role')).toBe('img');
  expect(labelled.getAttribute('aria-label')).toBe('Waiting for you');
  expect(labelled.hasAttribute('aria-hidden')).toBe(false);
});

it('draws each state with its own class', () => {
  const glyph = render({ state: 'waiting' });
  expect(glyph.classList.contains('waiting')).toBe(true);
  expect(glyph.classList.contains('working')).toBe(false);
});
