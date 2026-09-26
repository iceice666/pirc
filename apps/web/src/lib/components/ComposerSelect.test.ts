// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ComposerSelect from './ComposerSelect.svelte';

const options = [
  { value: 'low', label: 'Low', detail: 'Fast' },
  { value: 'high', label: 'High' },
];
let component: ReturnType<typeof mount>;
let target: HTMLDivElement;

async function setup(disabled = false) {
  target = document.createElement('div');
  document.body.append(target);
  const onselect = vi.fn();
  component = mount(ComposerSelect, {
    target,
    props: { label: 'Reasoning effort', value: 'high', options, disabled, onselect },
  });
  await tick();
  return onselect;
}

const trigger = () => target.querySelector<HTMLButtonElement>('.selector-trigger')!;
const items = () =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));

async function open() {
  trigger().click();
  await tick();
}

function key(value: string) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true }),
  );
}

afterEach(async () => {
  if (component) await unmount(component);
  target?.remove();
});

describe('ComposerSelect', () => {
  it('marks the current option and selects another value, restoring focus', async () => {
    const onselect = await setup();
    await open();
    expect(items()[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(items()[1]);
    items()[0].click();
    await tick();
    expect(onselect).toHaveBeenCalledWith('low');
    expect(target.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('supports arrow keys, Home, End and Escape without changing the value', async () => {
    const onselect = await setup();
    await open();
    key('ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    key('ArrowUp');
    expect(document.activeElement).toBe(items()[1]);
    key('Home');
    expect(document.activeElement).toBe(items()[0]);
    key('End');
    expect(document.activeElement).toBe(items()[1]);
    key('Escape');
    await tick();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(onselect).not.toHaveBeenCalled();
  });

  it('dismisses on an outside pointer or focus change', async () => {
    await setup();
    await open();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();
    expect(items()).toHaveLength(0);
    await open();
    document.body.dispatchEvent(new Event('focusin', { bubbles: true }));
    await tick();
    expect(items()).toHaveLength(0);
  });

  it('does not open while disabled', async () => {
    await setup(true);
    await open();
    expect(trigger().disabled).toBe(true);
    expect(items()).toHaveLength(0);
  });
});
