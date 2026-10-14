export function sensitiveField(target?: unknown): boolean {
  let el: any = target ?? (globalThis as any).document?.activeElement;
  if (target === undefined) while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName).toUpperCase();
  const type = String(el.type ?? '').toLowerCase();
  if (tag === 'INPUT' && type === 'password') return true;
  const editable =
    (tag === 'INPUT' &&
      ![
        'checkbox',
        'radio',
        'submit',
        'button',
        'reset',
        'image',
        'file',
        'range',
        'color',
      ].includes(type)) ||
    tag === 'TEXTAREA' ||
    el.isContentEditable === true;
  if (!editable) return false;
  const pattern = /pass(word)?|secret|otp|one-time|cvc|cvv|csc/i;
  const names = ['name', 'id', 'aria-label', 'autocomplete', 'placeholder'].map(
    (name) => el.getAttribute?.(name) ?? '',
  );
  const labels = Array.from((el.labels ?? []) as ArrayLike<any>).map(
    (label: any) => label.textContent ?? '',
  );
  return [...names, ...labels].some((text) => pattern.test(String(text)));
}
