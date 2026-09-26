import { describe, expect, it } from 'vitest';
import { parseGoalWidget } from './goal';

describe('parseGoalWidget', () => {
  it('reads phase, rounds, limit and reason', () => {
    expect(parseGoalWidget(['GOAL · blocked · 4/10', 'Ship the goal tool', 'CI is down'])).toEqual({
      phase: 'blocked',
      disarmed: false,
      rounds: 4,
      maxRounds: 10,
      objective: 'Ship the goal tool',
      reason: 'CI is down',
    });
  });

  it('marks a disarmed active goal and tolerates no limit', () => {
    expect(parseGoalWidget(['GOAL · active · disarmed · 2', 'Keep going'])).toEqual({
      phase: 'active',
      disarmed: true,
      rounds: 2,
      objective: 'Keep going',
    });
  });

  it('ignores anything that is not a goal widget', () => {
    expect(parseGoalWidget(['TODO · 1/2'])).toBeUndefined();
    expect(parseGoalWidget([])).toBeUndefined();
    expect(parseGoalWidget(undefined)).toBeUndefined();
  });
});
