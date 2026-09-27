import { ApiError } from './api';
import type { ControlLease } from './types';

export interface ControlApi {
  control(sessionId: string): Promise<ControlLease>;
  acquireControl(sessionId: string): Promise<ControlLease>;
  heartbeatControl(sessionId: string, generation: number): Promise<ControlLease>;
}

/** A 409 means the node rejected the lease; anything else may be a transient blip. */
function rejected(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Keeps this client's control lease alive, and picks control back up when nobody
 * else holds a live lease (it lapsed while the tab was asleep, or nobody took it).
 *
 * Never forces: a lease another device holds and keeps renewing is left alone.
 * Returns the lease to show, or `undefined` to keep the current state (transient
 * failure; the next sync retries before the lease TTL runs out).
 */
export async function syncControl(
  api: ControlApi,
  sessionId: string,
  current: ControlLease,
  options: { mayAcquire: boolean },
): Promise<ControlLease | undefined> {
  let lease: ControlLease;
  try {
    if (current.heldByCurrentClient && current.generation) {
      try {
        return await api.heartbeatControl(sessionId, current.generation);
      } catch (error) {
        if (!rejected(error)) return undefined;
        // Expired or superseded (e.g. another tab of this browser took over and
        // shares our client id): look at who holds it now.
      }
    }
    lease = await api.control(sessionId);
  } catch {
    return undefined;
  }
  const free = !lease.holderClientId || lease.expired;
  if (lease.heldByCurrentClient || !free || !options.mayAcquire) return lease;
  try {
    return await api.acquireControl(sessionId);
  } catch (error) {
    // Lost a race with another client: report whoever holds it now.
    if (rejected(error)) return api.control(sessionId).catch(() => lease);
    return lease;
  }
}
