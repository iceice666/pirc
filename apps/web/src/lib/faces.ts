/**
 * Faces (plans/rewrite/10-faces.md): the names one brain speaks through.
 * The host always exists; a project's face has the rooms it answers in,
 * the workspaces it is about and the sources it watches. An archived face
 * stays listed, greyed out, until someone hides it.
 */
import { request } from './http';
import type { OpenLoop } from './loops';
import type { Wake } from './wakes';
import type { Worker } from './workers';

export interface Territory {
  rooms: string[];
  /** Directory workspaces (`node:ws`). */
  workspaces: string[];
  sources: string[];
}

export interface Face {
  id: string;
  name: string;
  bio: string;
  tone: string;
  /** An emoji or initials; the name's first letter when null. */
  avatar: string | null;
  /** `#rrggbb`; a hue of the name when null. */
  color: string | null;
  /** What the face does: its instructions. */
  roleMd: string;
  territory: Territory;
  isHost: boolean;
  createdAt: number;
  archivedAt: number | null;
  hiddenAt: number | null;
}

/** What a face is doing now. */
export interface FacePresence {
  faceId: string;
  state: 'idle' | 'thinking' | 'working' | 'waiting';
  roomId?: string;
  /** What it works on, or what a worker of its asks. */
  line?: string;
  since?: number;
}

export interface FaceInput {
  name?: string;
  bio?: string;
  tone?: string;
  avatar?: string | null;
  color?: string | null;
  roleMd?: string;
  territory?: Territory;
  archived?: boolean;
  hidden?: boolean;
}

export interface FaceActivity {
  loops: OpenLoop[];
  workers: Worker[];
  wakes: Wake[];
}

/** `SOUL.md` or `CHAT.md` (plan 02), as the host's page shows it. */
export interface BrainPrompt {
  text: string;
  writable: boolean;
  reason?: 'nix-store' | 'symlink' | 'permission';
  path: string;
  maxChars: number;
}

export const HOST_FACE_ID = 'host';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  cache: 'no-store',
});
const path = (id: string, rest = '') => `/api/faces/${encodeURIComponent(id)}${rest}`;

export const facesApi = {
  list: (hidden = false) =>
    request<{ faces: Face[]; presence: FacePresence[] }>(`/api/faces${hidden ? '?hidden=1' : ''}`, {
      cache: 'no-store',
    }),
  create: (input: FaceInput & { name: string }) =>
    request<{ face: Face }>('/api/faces', json('POST', input)),
  update: (id: string, input: FaceInput) => request<{ face: Face }>(path(id), json('PATCH', input)),
  activity: (id: string) => request<FaceActivity>(path(id, '/activity'), { cache: 'no-store' }),
  prompts: () =>
    request<{ prompts: { soul: BrainPrompt; chat: BrainPrompt } }>('/api/brain/prompts', {
      cache: 'no-store',
    }),
  savePrompt: (name: 'soul' | 'chat', text: string) =>
    request<{ prompt: BrainPrompt }>(`/api/brain/prompts/${name}`, json('PUT', { text })),
};

/** The face a speaker (`face:<id>`) names, if it is one. */
export function speakerFace(faces: Face[], speaker: string): Face | undefined {
  if (!speaker.startsWith('face:')) return undefined;
  const id = speaker.slice('face:'.length);
  return faces.find((face) => face.id === id);
}

/** A stable hue per name, for faces and people without a color. */
export function hueOf(name: string): number {
  return [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
}

/** What the avatar shows: the face's own, else the first letter. */
export function initialOf(name: string, avatar?: string | null): string {
  return avatar || ([...name][0]?.toUpperCase() ?? '?');
}

/** The faces in the order the member list shows them; hidden ones only when asked for. */
export function listed(faces: Face[], showHidden = false): Face[] {
  return faces.filter((face) => showHidden || !face.hiddenAt);
}

/** The face whose territory has the room (never the host's). */
export function roomFace(faces: Face[], roomId: string): Face | undefined {
  return faces.find(
    (face) => !face.isHost && !face.archivedAt && face.territory.rooms.includes(roomId),
  );
}

/** The words a presence needs, and the line it is working on (i18n adds the translation). */
export interface PresenceLabel {
  word:
    | 'common.status.thinking'
    | 'common.status.working'
    | 'common.status.waiting'
    | 'common.status.here';
  /** What it works on, or what a worker of its asks. */
  line?: string;
}

/** What a presence says, in a few words. */
export function presenceLabel(presence: FacePresence | undefined): PresenceLabel {
  switch (presence?.state) {
    case 'thinking':
      return { word: 'common.status.thinking' };
    case 'working':
      return { word: 'common.status.working', line: presence.line };
    case 'waiting':
      return { word: 'common.status.waiting', line: presence.line };
    default:
      return { word: 'common.status.here' };
  }
}

/**
 * The `@name` being typed at `caret`, if any: from an `@` that starts a word
 * (not inside an address) up to the caret, without spaces.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  const previous = before[at - 1];
  if (previous && /[A-Za-z0-9_.]/.test(previous)) return null;
  return { start: at, query };
}

/** The active faces a typed `@query` may mean, best first. */
export function mentionMatches(faces: Face[], query: string, limit = 6): Face[] {
  const wanted = query.toLowerCase();
  return faces
    .filter((face) => !face.archivedAt && face.name.toLowerCase().includes(wanted))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(wanted) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(wanted) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** The text with the mention at `start` replaced by `@name `, and where the caret goes. */
export function completeMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret).replace(/^ /, ''),
    caret: start + inserted.length,
  };
}
