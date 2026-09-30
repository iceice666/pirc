/** Gateway-owned chat policy, not a process or filesystem sandbox. Missing flags allow. */
export const CAPABILITY_NAMES = [
  'delegation',
  'memory_search',
  'remote_recall',
  'schedules',
  'web_search',
] as const;
export type Capability = (typeof CAPABILITY_NAMES)[number];
export type Capabilities = { version: 1 } & Record<Capability, boolean>;

export function capabilities(value?: unknown): Capabilities {
  const flags = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries([
    ['version', 1],
    ...CAPABILITY_NAMES.map((name) => [name, flags[name] !== false]),
  ]) as Capabilities;
}

export function capabilityForTool(name: string): Capability | undefined {
  if (name === 'delegate' || name === 'delegation_status') return 'delegation';
  if (name === 'memory_search') return 'memory_search';
  if (name === 'schedule') return 'schedules';
  if (name === 'web_search') return 'web_search';
  // recall also serves local session evidence; gate only its remote fallback.
  return undefined;
}
