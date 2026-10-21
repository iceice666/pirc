/** Keyboard helpers for composite widgets (tabs, radio groups, menus). */

export interface RovingOptions {
  /** Items to move between, e.g. `[role="tab"]`. Disabled items are skipped. */
  selector: string;
  /** Arrow keys that move: left/right, up/down, or both. */
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** Click the item focus moves to (tabs and radios select on focus). */
  activate?: boolean;
  /** Wrap from the last item to the first and back. */
  wrap?: boolean;
}

/**
 * Svelte action for a long list read item by item (a room's messages, a
 * thread): from the list itself or one of its items, ArrowUp/ArrowDown move
 * focus to the previous/next item, Home/End to the first/last. Entering from
 * the list starts at the newest (ArrowUp, End) or the oldest (ArrowDown,
 * Home). Items carry `tabindex="-1"`; the list itself is the tab stop.
 */
export function listFocus(node: HTMLElement, options: { selector: string }) {
  let current = options;
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(current.selector));
    if (!items.length) return;
    const active = document.activeElement as HTMLElement | null;
    const index = items.findIndex((item) => item === active);
    if (index === -1 && active !== node) return;
    const last = items.length - 1;
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (index === -1) next = event.key === 'ArrowUp' ? last : 0;
    else next = Math.min(last, Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1)));
    event.preventDefault();
    items[next]!.focus();
    items[next]!.scrollIntoView?.({ block: 'nearest' });
  };
  node.addEventListener('keydown', onKeydown);
  return {
    update(next: { selector: string }) {
      current = next;
    },
    destroy() {
      node.removeEventListener('keydown', onKeydown);
    },
  };
}

/**
 * Svelte action: arrow keys, Home and End move focus between the items inside
 * `node` (the WAI-ARIA roving focus pattern). The items themselves keep one
 * `tabindex="0"` (the selected one) and `-1` on the rest.
 */
export function rovingFocus(node: HTMLElement, options: RovingOptions) {
  let current = options;
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const { selector, orientation = 'horizontal', activate = false, wrap = true } = current;
    const items = Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
      (item) => !item.matches(':disabled, [aria-disabled="true"]'),
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1 || !items.length) return;
    const back = [
      ...(orientation !== 'vertical' ? ['ArrowLeft'] : []),
      ...(orientation !== 'horizontal' ? ['ArrowUp'] : []),
    ];
    const forward = [
      ...(orientation !== 'vertical' ? ['ArrowRight'] : []),
      ...(orientation !== 'horizontal' ? ['ArrowDown'] : []),
    ];
    const last = items.length - 1;
    let next: number;
    if (forward.includes(event.key)) next = index === last ? (wrap ? 0 : last) : index + 1;
    else if (back.includes(event.key)) next = index === 0 ? (wrap ? last : 0) : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    const target = items[next]!;
    target.focus();
    if (activate && next !== index) target.click();
  };
  node.addEventListener('keydown', onKeydown);
  return {
    update(next: RovingOptions) {
      current = next;
    },
    destroy() {
      node.removeEventListener('keydown', onKeydown);
    },
  };
}
