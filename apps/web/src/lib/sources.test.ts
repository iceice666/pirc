import { describe, expect, it } from 'vitest';
import {
  cadence,
  describeSource,
  followedSources,
  sourceStatus,
  withFollowed,
  type Source,
} from './sources';
import { describeTrigger, type Wake } from './wakes';

const source = (overrides: Partial<Source> = {}): Source => ({
  id: 'email:gmail',
  kind: 'email',
  name: 'Gmail',
  user: 'me',
  config: { host: 'imap.gmail.com', username: 'me@gmail.com', mailbox: 'INBOX', port: 993 },
  pausedAt: null,
  lastPolledAt: null,
  lastError: null,
  failures: 0,
  createdAt: 1,
  updatedAt: 1,
  rooms: [],
  cadenceMs: 300_000,
  ...overrides,
});

describe('sources', () => {
  it('describes a source without its credentials', () => {
    expect(describeSource(source())).toBe('me@gmail.com · imap.gmail.com · INBOX');
    expect(
      describeSource(
        source({ kind: 'calendar', config: { mode: 'ics', host: 'calendar.google.com' } }),
      ),
    ).toBe('ICS · calendar.google.com');
    expect(
      describeSource(
        source({
          kind: 'moodle',
          config: {
            siteName: 'School Moodle',
            fullName: 'Brian D',
            url: 'https://moodle.school.edu',
          },
        }),
      ),
    ).toBe('School Moodle · Brian D · https://moodle.school.edu');
  });

  it('says how it is doing', () => {
    expect(sourceStatus(source())).toEqual({ text: 'Not read yet', tone: 'muted' });
    expect(sourceStatus(source({ lastPolledAt: 5 }))).toEqual({
      text: 'Read every 5 min',
      tone: 'ok',
    });
    expect(
      sourceStatus(source({ failures: 2, lastError: 'the server cannot be reached' })).tone,
    ).toBe('error');
    expect(sourceStatus(source({ pausedAt: 9, failures: 2, lastError: 'x' })).text).toBe('Paused');
    expect(cadence(3_600_000)).toBe('every 1 h');
    expect(cadence(86_400_000)).toBe('once a day');
  });

  it("reads and changes a room's scope", () => {
    expect(followedSources(null)).toEqual([]);
    expect(followedSources({ sources: ['a', 3, 'b'] })).toEqual(['a', 'b']);
    expect(withFollowed({ workspaces: ['w'], sources: ['a'] }, ['b'])).toEqual({
      workspaces: ['w'],
      sources: ['b'],
    });
    expect(withFollowed(null, [])).toEqual({ sources: [] });
  });

  it('names what woke pirc', () => {
    const wake = { kind: 'source', trigger: { name: 'School mail', reason: 'loop' } } as Wake;
    expect(describeTrigger(wake)).toBe('Something new in School mail touched an open loop');
    expect(describeTrigger({ ...wake, trigger: { name: 'Team', reason: 'followed' } })).toBe(
      'Something new in Team',
    );
    expect(describeTrigger({ ...wake, trigger: {} })).toBe('A source changed');
  });
});
