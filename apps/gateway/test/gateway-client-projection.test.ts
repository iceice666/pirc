import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { runtimeClientSnapshot } from '../src/gateway-runtime/client-projection.js';
test('client projection shows newest bounded history and latest watermark, without fake sandbox badge', () => {
  const authority = new GatewaySessionAuthority(':memory:');
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    for (let i = 0; i < 140; i++)
      authority.append(lease, randomUUID(), {
        type: 'message',
        message: { role: 'user', content: `message-${i}`, timestamp: i },
      });
    const snapshot = runtimeClientSnapshot({ authority, lease, owner: 'alice', running: false });
    expect(snapshot.history).toHaveLength(32);
    expect((snapshot.history.at(-1) as { content: unknown }).content).toBe('message-139');
    expect(snapshot.historyPage.olderAvailable).toBe(true);
    let page = snapshot.historyPage,
      history = snapshot.history;
    while (page.olderAvailable) {
      const older = authority.olderHistory(
        lease.binding.sessionId,
        'alice',
        lease.branchId,
        page.olderCursor!,
      );
      history = [...older.history, ...history];
      page = { ...page, ...older.historyPage };
    }
    expect(history).toHaveLength(140);
    expect((history[0] as { content: unknown }).content).toBe('message-0');
    expect(snapshot.watermark.sequence).toBe(140);
    expect('sandbox' in snapshot).toBe(false);
    expect(snapshot.runtime.location).toBe('gateway');
    expect(() => runtimeClientSnapshot({ authority, lease, owner: 'bob', running: false })).toThrow(
      'owner',
    );
  } finally {
    authority.close();
  }
});
