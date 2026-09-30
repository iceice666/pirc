import { describe, expect, it } from 'vitest';
import { snapshotFromRaw } from './api';

const raw = (request: Record<string, unknown>) => ({
  session: { id: 's1', workspaceId: 'n:chats', name: 'Chat', runnerState: 'ready' },
  history: [],
  interactions: [
    { id: 'd1', runnerEpoch: 0, kind: 'confirm', status: 'pending', request, expiresAt: 9e12 },
  ],
  watermark: { epoch: 0, sequence: 0 },
});

describe('sandbox status', () => {
  it('comes from the snapshot, and is absent without a runner', () => {
    const base = raw({ title: 'x' });
    expect(
      snapshotFromRaw({ ...base, sandbox: { active: false, reason: 'srt is not installed' } }, null)
        .sandbox,
    ).toEqual({ active: false, reason: 'srt is not installed' });
    expect(snapshotFromRaw({ ...base, sandbox: { active: true } }, null).sandbox).toEqual({
      active: true,
    });
    expect(snapshotFromRaw({ ...base, sandbox: null }, null)).not.toHaveProperty('sandbox');
  });
});

describe('confirmations', () => {
  it("keep the labels a confirmation asks for, such as a delegation's", () => {
    const [confirmation] = snapshotFromRaw(
      raw({
        title: 'Delegate to Test on work?',
        message: 'Fix build\n\nFix the build.',
        confirmLabel: 'Delegate',
        cancelLabel: "Don't",
      }),
      null,
    ).interactions;
    expect(confirmation).toMatchObject({
      kind: 'confirm',
      title: 'Delegate to Test on work?',
      description: 'Fix build\n\nFix the build.',
      confirmLabel: 'Delegate',
      cancelLabel: "Don't",
    });
    const [plain] = snapshotFromRaw(raw({ title: 'Continue?' }), null).interactions;
    expect(plain).not.toHaveProperty('confirmLabel');
  });
});
