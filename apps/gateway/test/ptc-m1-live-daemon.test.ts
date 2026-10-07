import { expect, test } from 'bun:test';
import { startFixtureDaemon } from './ptc-m1/daemon-fixture.js';

for (const kind of ['coding', 'chat'] as const)
  test(`disposable ${kind} daemon enforces bound identity and stores only a pending schedule`, async () => {
    const daemon = await startFixtureDaemon(kind);
    try {
      expect(await daemon.authorizationProof()).toBe(true);
      await expect(daemon.dispatch('schedule.delete', { id: 'anything' })).rejects.toThrow(
        'Unexpected',
      );
      const invalid = await daemon.dispatch('schedule.create', {
        prompt: 'synthetic',
        cron: 'bad',
      });
      expect(invalid.status).toBe(400);
      const answer = await daemon.dispatch('schedule.create', {
        prompt: 'Check synthetic CI',
        title: 'Synthetic CI',
        cron: '0 9 * * *',
        timezone: 'UTC',
      });
      expect(answer.status).toBe(200);
      const result = (answer.body as { result: { proposalId: string; status: string } }).result;
      expect(result.status).toBe('pending_approval');
      expect(daemon.scheduleProof(result.proposalId)).toBe(true);
      expect(daemon.scheduleProof('unknown')).toBe(false);
      expect(daemon.scheduleEnforcement()).toEqual({
        activeSchedules: 0,
        proposals: 1,
        nonPendingProposals: 0,
      });
    } finally {
      await daemon.close();
    }
  });
