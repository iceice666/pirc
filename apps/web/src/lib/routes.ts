/**
 * The web's two pages: the rooms at `/` (`?room=<id>`) and the engine at
 * `/engine` (`?session=`, `?workspace=`, `?open=<section>`). Notifications and
 * links name one of them (public/sw.js keeps its own copy of these rules).
 */
import type { MessageKey } from './i18n/messages';

export const ENGINE_PATH = '/engine';

export function isEnginePath(pathname: string): boolean {
  return pathname === ENGINE_PATH || pathname.startsWith(`${ENGINE_PATH}/`);
}

/**
 * The engine's front page, a section each (`/engine?open=<id>`; the tab strip
 * links to `#<id>`). **Overview** first is the dashboard; the others are the
 * sections it summarises, stacked below it on the same page.
 */
export const OVERVIEW_SECTIONS = [
  { id: 'overview', key: 'engine.section.overview' },
  { id: 'nodes', key: 'engine.section.nodes' },
  { id: 'brain', key: 'engine.section.brain' },
  { id: 'loops', key: 'engine.section.loops' },
  { id: 'wakes', key: 'engine.section.wakes' },
  { id: 'memory', key: 'engine.section.memory' },
  { id: 'sources', key: 'engine.section.sources' },
] as const satisfies readonly { id: string; key: MessageKey }[];
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
