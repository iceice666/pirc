import { describe, expect, it } from 'vitest';
import { ago, duration, elapsed, shortAgo } from './time';

const now = Date.parse('2026-09-27T12:00:00Z');

describe('time', () => {
  it('ago', () => {
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(ago(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('shortAgo', () => {
    expect(shortAgo(new Date(now - 10_000).toISOString(), now)).toBe('now');
    expect(shortAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(shortAgo(now - 3 * 3_600_000, now)).toBe('3h');
    expect(shortAgo(now - 49 * 3_600_000, now)).toBe('2d');
  });

  it('duration', () => {
    expect(duration(undefined)).toBe('');
    expect(duration(now - 12_000, undefined, now)).toBe('12s');
    expect(duration(now - 184_000, now)).toBe('3m 4s');
    expect(duration(new Date(now - 3_720_000).toISOString(), new Date(now).toISOString())).toBe(
      '1h 2m',
    );
  });

  it('elapsed', () => {
    expect(elapsed('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.420Z')).toBe('420 ms');
    expect(elapsed('2026-01-01T00:00:00Z', '2026-01-01T00:00:01.250Z')).toBe('1.3 s');
    expect(elapsed('2026-01-01T00:00:00Z', '2026-01-01T00:00:14Z')).toBe('14 s');
    expect(elapsed('2026-01-01T00:00:01Z', '2026-01-01T00:00:00Z')).toBe('');
    expect(elapsed(undefined, '2026-01-01T00:00:00Z')).toBe('');
  });
});
