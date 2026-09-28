/**
 * Duration for a Svelte JS transition (`fade`, `slide`): 0 when the user asks
 * for reduced motion. The global CSS rule in app.css only reaches CSS
 * animations and transitions, not the inline styles Svelte animates.
 */
export function motion(ms: number): number {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : ms;
}
