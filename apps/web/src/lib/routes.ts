/**
 * The web's two pages: the rooms at `/` (`?room=<id>`) and the engine at
 * `/engine` (`?session=`, `?workspace=`, `?open=memory`). Notifications and
 * links name one of them (public/sw.js keeps its own copy of these rules).
 */
export const ENGINE_PATH = '/engine';

export function isEnginePath(pathname: string): boolean {
  return pathname === ENGINE_PATH || pathname.startsWith(`${ENGINE_PATH}/`);
}
