import { untrack } from 'svelte';

/**
 * Run `fn` when `source()` changes. The callback runs untracked, so it may read
 * and write state freely without subscribing to it. Must be called during
 * component initialisation (it creates an effect).
 *
 * `immediate` also runs `fn` for the initial value (e.g. load data for the
 * first session, then again whenever the session changes).
 */
export function watch<T>(
  source: () => T,
  fn: (value: T, previous: T | undefined) => void,
  options: { immediate?: boolean } = {},
): void {
  let initialized = false;
  let previous: T | undefined;
  $effect.pre(() => {
    const value = source();
    if (initialized && Object.is(value, previous)) return;
    const before = previous;
    const first = !initialized;
    initialized = true;
    previous = value;
    if (first && !options.immediate) return;
    untrack(() => fn(value, before));
  });
}
