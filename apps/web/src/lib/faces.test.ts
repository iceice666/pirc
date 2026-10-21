import { describe, expect, it } from 'vitest';
import {
  completeMention,
  initialOf,
  listed,
  mentionAt,
  mentionMatches,
  presenceLabel,
  roomFace,
  speakerFace,
  type Face,
} from './faces';

const face = (id: string, name: string, extra: Partial<Face> = {}): Face => ({
  id,
  name,
  bio: '',
  tone: '',
  avatar: null,
  color: null,
  roleMd: '',
  territory: { rooms: [], workspaces: [], sources: [] },
  isHost: id === 'host',
  createdAt: 1,
  archivedAt: null,
  hiddenAt: null,
  ...extra,
});

const faces = [
  face('host', 'pirc'),
  face('pm', 'PM', { territory: { rooms: ['slimeos'], workspaces: [], sources: [] } }),
  face('old', 'Planner', {
    archivedAt: 1,
    hiddenAt: 2,
    territory: { rooms: ['old'], workspaces: [], sources: [] },
  }),
];

describe('faces', () => {
  it('finds the face of a speaker and of a room', () => {
    expect(speakerFace(faces, 'face:pm')?.name).toBe('PM');
    expect(speakerFace(faces, 'user')).toBeUndefined();
    expect(roomFace(faces, 'slimeos')?.id).toBe('pm');
    expect(roomFace(faces, 'old')).toBeUndefined();
    expect(roomFace(faces, 'general')).toBeUndefined();
    expect(listed(faces).map((item) => item.id)).toEqual(['host', 'pm']);
    expect(listed(faces, true)).toHaveLength(3);
  });

  it('says what a face is doing', () => {
    expect(presenceLabel(undefined)).toBe('Here');
    expect(presenceLabel({ faceId: 'pm', state: 'working', line: 'the PR' })).toBe(
      'Working on the PR',
    );
    expect(presenceLabel({ faceId: 'pm', state: 'thinking' })).toBe('Thinking');
    expect(initialOf('pm')).toBe('P');
    expect(initialOf('pm', '🦀')).toBe('🦀');
  });

  it('finds the @ being typed, not inside an address', () => {
    expect(mentionAt('hi @p', 5)).toEqual({ start: 3, query: 'p' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('me@pm.com', 9)).toBeNull();
    expect(mentionAt('@pm said', 8)).toBeNull();
    expect(mentionAt('問一下@小', 5)).toEqual({ start: 3, query: '小' });
  });

  it('offers the faces that answer, the ones that start so first', () => {
    expect(mentionMatches(faces, 'p').map((item) => item.name)).toEqual(['pirc', 'PM']);
    expect(mentionMatches(faces, 'm').map((item) => item.name)).toEqual(['PM']);
    expect(mentionMatches(faces, 'plan')).toEqual([]);
  });

  it('completes the mention where it was typed', () => {
    expect(completeMention('hi @p there', 5, 3, 'PM')).toEqual({ text: 'hi @PM there', caret: 7 });
    expect(completeMention('@', 1, 0, 'pirc')).toEqual({ text: '@pirc ', caret: 6 });
  });
});
