// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { rovingFocus } from './a11y';

let root: HTMLElement;
afterEach(() => root?.remove());

function setup(html: string, options: Parameters<typeof rovingFocus>[1]) {
  root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  rovingFocus(root, options);
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
}
const press = (key: string) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

it('moves and activates with arrows, Home and End, skipping disabled items', () => {
  const clicked: string[] = [];
  const [a, , c] = setup(
    '<button role="tab">a</button><button role="tab" disabled>b</button><button role="tab">c</button>',
    { selector: '[role="tab"]', activate: true },
  );
  root.addEventListener('click', (event) =>
    clicked.push((event.target as HTMLElement).textContent!),
  );
  a!.focus();
  press('ArrowRight');
  expect(document.activeElement).toBe(c);
  press('ArrowRight');
  expect(document.activeElement).toBe(a);
  press('End');
  expect(document.activeElement).toBe(c);
  press('Home');
  expect(document.activeElement).toBe(a);
  expect(clicked).toEqual(['c', 'a', 'c', 'a']);
});

it('respects orientation', () => {
  const [a, b] = setup('<button>a</button><button>b</button>', {
    selector: 'button',
    orientation: 'vertical',
  });
  a!.focus();
  press('ArrowRight');
  expect(document.activeElement).toBe(a);
  press('ArrowDown');
  expect(document.activeElement).toBe(b);
});
