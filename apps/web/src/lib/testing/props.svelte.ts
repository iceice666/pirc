/** Component props that tests can change after `mount` (a `$state` proxy). */
export function reactiveProps<T extends Record<string, unknown>>(initial: T): T {
  const props = $state(initial);
  return props;
}
