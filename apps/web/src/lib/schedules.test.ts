import { describe, expect, it } from 'vitest';
import { describeCron, describeWhen, formatWall, until, wallInput } from './schedules';

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['5 * * * *', 'Every hour at :05'],
    ['0 */4 * * *', 'Every 4 hours at :00'],
    ['30 9 * * *', 'Every day at 09:30'],
    ['0 9 * * 1-5', 'Weekdays at 09:00'],
    ['0 10 * * 0,6', 'Weekends at 10:00'],
    ['0 9 * * 1', 'Every Monday at 09:00'],
    ['0 9 * * 1,3,7', 'Every Monday, Wednesday, Sunday at 09:00'],
    ['0 9 1 * *', 'Monthly on day 1 at 09:00'],
  ])('%s → %s', (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });

  it('keeps shapes it cannot put in words', () => {
    for (const cron of ['0 9 * 1 *', '0 9-17 * * *', '0 9 1 * 1', 'nonsense'])
      expect(describeCron(cron)).toBe(cron);
  });
});

describe('times', () => {
  const at = Date.parse('2026-09-30T01:30:00Z');

  it('reads the wall clock of the schedule time zone', () => {
    expect(formatWall(at, 'Asia/Taipei')).toBe('2026-09-30 09:30');
    expect(formatWall(at, 'America/New_York')).toBe('2026-09-29 21:30');
    expect(wallInput(at, 'UTC')).toBe('2026-09-30T01:30');
  });

  it('describes when a schedule runs', () => {
    expect(describeWhen({ cron: '0 9 * * 1-5', runAt: null, timezone: 'Asia/Taipei' })).toBe(
      'Weekdays at 09:00 (Asia/Taipei)',
    );
    expect(describeWhen({ cron: null, runAt: at, timezone: 'Asia/Taipei' })).toBe(
      'Once at 2026-09-30 09:30 (Asia/Taipei)',
    );
  });

  it('counts down to the next run', () => {
    expect(until(at, at - 30_000)).toBe('in under a minute');
    expect(until(at, at - 5 * 60_000)).toBe('in 5m');
    expect(until(at, at - 3 * 3_600_000)).toBe('in 3h');
    expect(until(at, at - 2 * 86_400_000)).toBe('in 2d');
  });
});
