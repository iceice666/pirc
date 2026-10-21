/**
 * The web's two pages: the rooms at `/` (`?room=<id>`) and the engine at
 * `/engine` (`?session=`, `?workspace=`, `?open=<section>`). Notifications and
 * links name one of them (public/sw.js keeps its own copy of these rules).
 */
export const ENGINE_PATH = '/engine';

export function isEnginePath(pathname: string): boolean {
  return pathname === ENGINE_PATH || pathname.startsWith(`${ENGINE_PATH}/`);
}

/** The engine's front page, a tab each (`/engine?open=<id>`). */
export const OVERVIEW_SECTIONS = [
  { id: 'nodes', label: 'Nodes' },
  { id: 'brain', label: 'Brain' },
  { id: 'loops', label: 'Open loops' },
  { id: 'wakes', label: 'Wakes' },
  { id: 'memory', label: 'Memory' },
  { id: 'sources', label: 'Sources' },
] as const;
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number]['id'];

export function isOverviewSection(value: unknown): value is OverviewSection {
  return OVERVIEW_SECTIONS.some((section) => section.id === value);
}

/** A link into the engine: one of its front page's tabs, or a session. */
export function engineLink(target: OverviewSection | { session: string }): string {
  return typeof target === 'string'
    ? `${ENGINE_PATH}?open=${target}`
    : `${ENGINE_PATH}?session=${encodeURIComponent(target.session)}`;
}
