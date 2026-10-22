/**
 * The open session as the engine keeps it: its record, run, runner, cursor
 * and control lease (types.ts `SessionSnapshot`). There is no conversation
 * (plan 12 decision 4): the stream only moves the cursor, renames the
 * session, or asks for a fresh snapshot.
 */
import type { ClientSessionState, EventEnvelope, SessionSnapshot } from './types';

export function fromSnapshot(snapshot: SessionSnapshot): ClientSessionState {
  return { ...snapshot, needsSnapshot: false };
}

export function reduceEvent(
  state: ClientSessionState,
  envelope: EventEnvelope,
): ClientSessionState {
  if (envelope.event.type !== 'reset' && envelope.runnerEpoch !== state.runnerEpoch) {
    return { ...state, needsSnapshot: true };
  }

  const base = { ...state, cursor: envelope.cursor };
  const event = envelope.event;
  switch (event.type) {
    case 'reset':
      return { ...base, needsSnapshot: true };
    case 'session_deleted': // The app closes the session and shows its workspace.
    case 'noop':
    case 'panel_changed':
      return base;
    case 'session_renamed':
      return { ...base, session: { ...state.session, name: event.name } };
  }
}
