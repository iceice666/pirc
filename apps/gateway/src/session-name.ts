import type { GatewayDatabase } from './database.js';
import type { EventHub } from './events.js';

/**
 * Persist a name reported by the agent (or relayed from a node) and tell
 * clients. A generated (`auto`) title never replaces a name the user chose.
 */
export function applySessionName(
  db: GatewayDatabase,
  events: EventHub,
  sessionId: string,
  epoch: number,
  data: Record<string, unknown>,
): void {
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 200) : '';
  if (!name) return;
  if (data.source === 'auto') {
    if (!db.autoRenameSession(sessionId, name)) return;
  } else {
    const session = db.getSession(sessionId);
    if (session.name === name && session.nameSource === 'user') return;
    db.renameSession(sessionId, name);
  }
  events.publish(sessionId, epoch, 'session_renamed', {
    name,
    source: data.source === 'auto' ? 'auto' : 'user',
  });
}

/** Fields of a session row that never leave the process that owns them. */
export function publicSession<
  T extends {
    privateSessionPath?: unknown;
    piSessionId?: unknown;
    ownerUser?: unknown;
    partialOutputLost?: unknown;
  },
>(session: T): Omit<T, 'privateSessionPath' | 'piSessionId' | 'ownerUser' | 'partialOutputLost'> {
  const {
    privateSessionPath: _path,
    piSessionId: _pi,
    ownerUser: _owner,
    partialOutputLost: _lost,
    ...rest
  } = session;
  return rest;
}
