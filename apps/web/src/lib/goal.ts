/**
 * The session goal reaches the browser as a plain-text widget (key `goal`):
 * `GOAL · <phase>[ · disarmed] · <rounds>[/<max>]`, then the objective, then
 * an optional blocked/paused reason. This turns it back into a record.
 */
export const GOAL_WIDGET = 'goal';

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalView {
  phase: GoalPhase;
  /** Active but waiting for a resume (restored after a restart). */
  disarmed: boolean;
  rounds: number;
  maxRounds?: number;
  objective: string;
  reason?: string;
}

const HEADER = /^GOAL · (active|paused|blocked|complete)( · disarmed)? · (\d+)(?:\/(\d+))?$/;

export function parseGoalWidget(lines: string[] | undefined): GoalView | undefined {
  const header = HEADER.exec(lines?.[0] ?? '');
  if (!header || !lines) return undefined;
  return {
    phase: header[1] as GoalPhase,
    disarmed: !!header[2],
    rounds: Number(header[3]),
    ...(header[4] ? { maxRounds: Number(header[4]) } : {}),
    objective: lines[1] ?? '',
    ...(lines[2] ? { reason: lines[2] } : {}),
  };
}
