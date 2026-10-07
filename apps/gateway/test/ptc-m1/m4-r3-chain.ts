/** The round 3 stop chain, validated as the round 3 scripts do (used to start round 4). */
import { APPROVED_OPENAI_001 } from './openai-resume.js';
import { OPENAI_PROTOCOL } from './openai-contract.js';
import { M4_BOUNDS } from './m4-bounds.js';
import { PTC_ORACLE_MAPPING } from './ptc-surface.js';
import { TEAM_ORACLE_REVISION } from './team-evidence.js';
import { M4_R3, M4_R3_STOPS, m4R3Run } from './m4-run.js';
import { validatePairedStopped, type PairedRow } from './m4-paired.js';

export const ROUND3_FIELDS = {
  provider: 'openai',
  auxiliaryReasoningMap: { off: 'low', minimal: 'low' },
  arms: M4_R3.arms,
  protocol: OPENAI_PROTOCOL,
  oracleMapping: PTC_ORACLE_MAPPING,
  teamOracleRevision: TEAM_ORACLE_REVISION,
  bounds: M4_BOUNDS,
  fixtureHash: APPROVED_OPENAI_001.fixture,
  primeOutcome: 'record',
};

export async function validateRound3Chain(read: (name: string) => Promise<string>) {
  const same = (manifest: any) =>
    Object.entries(ROUND3_FIELDS).every(
      ([key, value]) => JSON.stringify(manifest[key]) === JSON.stringify(value),
    );
  let rows: PairedRow[] = [];
  let carry: { spentUnits: number; admittedAttempts: number } = { ...M4_R3.carry };
  for (const [i, stop] of M4_R3_STOPS.entries()) {
    if (stop.name !== m4R3Run(i + 1) || JSON.stringify(stop.carry) !== JSON.stringify(carry))
      throw new Error('Round 3 stop chain mismatch');
    const step = validatePairedStopped(
      {
        trials: await read(`${stop.name}.trials.jsonl`),
        budget: await read(`${stop.name}.budget.jsonl`),
        summary: await read(`${stop.name}.summary.json`),
      },
      stop,
      rows,
      same,
    );
    rows = step.rows;
    carry = step.carry;
  }
  return { rows, carry };
}
