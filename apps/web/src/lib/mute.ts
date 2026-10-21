/**
 * Rooms muted on this device (plans/rewrite/11-web.md): no notifications
 * from them here, while every other device keeps its own choice. Kept in
 * localStorage for the pages and copied to a cache the service worker reads
 * (public/sw.js, `MUTED_ROOMS_KEY`), since a worker has no localStorage.
 */
const STORAGE_KEY = 'relay.muted-rooms';
export const SETTINGS_CACHE = 'relay-settings-v1';
export const MUTED_ROOMS_KEY = '/__pirc_muted_rooms__';

export function mutedRooms(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Mute or unmute a room here; the list after the change. */
export function setMuted(roomId: string, muted: boolean): string[] {
  const list = mutedRooms().filter((item) => item !== roomId);
  if (muted) list.push(roomId);
  try {
    if (list.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage the choice lasts for this page only.
  }
  void mirror(list);
  return list;
}

/** The service worker's copy. */
async function mirror(list: string[]) {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(SETTINGS_CACHE);
    await cache.put(
      MUTED_ROOMS_KEY,
      new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }),
    );
  } catch {
    // Notifications from it still show; the room stays muted in the list.
  }
}

/** Bring the worker's copy up to date (a page start; storage may have been edited). */
export function syncMuted(): void {
  void mirror(mutedRooms());
}
