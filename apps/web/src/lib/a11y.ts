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
