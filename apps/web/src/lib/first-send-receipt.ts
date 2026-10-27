/** Per-attempt outcomes are ordered; Stop and deletion apply to the whole operation. */
import type { Preparation, RetryAttempt, RetryReceipt } from './first-send';
export function attemptNumber(p?: Preparation): number {
  const n = p?.messageAdmission?.attemptNumber;
  if (n === undefined) return 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid first-message attempt number.');
  return n;
}
export function mergePreparation(
  previous: Preparation | undefined,
  value: Preparation,
): Preparation {
  const before = previous?.messageAdmission,
    incoming = value.messageAdmission;
  const oldNumber = attemptNumber(previous),
    newNumber = attemptNumber(value);
  if (
    oldNumber === newNumber &&
    before?.commandId &&
    incoming?.commandId &&
    before.commandId !== incoming.commandId
  )
    throw new Error('The first-message attempt identity changed.');
  const stale = newNumber < oldNumber;
  const same = newNumber === oldNumber;
  const keep =
    !!previous &&
    ((previous.state === 'cancelled' &&
      (value.state !== 'cancelled' || (!previous.cleanupPending && value.cleanupPending))) ||
      (previous.state === 'admitted' && !['admitted', 'cancelled'].includes(value.state)) ||
      (previous.accepted && !value.accepted) ||
      (value.state !== 'cancelled' &&
        (stale ||
          (same && before?.outcome === 'not_admitted' && incoming?.outcome !== 'not_admitted'))));
  const chosen = keep ? previous! : value;
  let result = previous?.nodeMapped || value.nodeMapped ? { ...chosen, nodeMapped: true } : chosen;
  if (result.state === 'cancelled') return result;
  const confirmed = !!(before?.stopConfirmed || incoming?.stopConfirmed);
  const requested = confirmed || !!(before?.stopRequested || incoming?.stopRequested);
  const admitted = previous?.state === 'admitted' || value.state === 'admitted';
  if (before || incoming) {
    const selected = stale ? before : same ? { ...before, ...chosen.messageAdmission } : incoming;
    result = {
      ...result,
      state: admitted ? 'admitted' : confirmed ? 'stopped' : requested ? 'stopping' : result.state,
      messageAdmission: {
        ...selected,
        stopRequested: requested,
        stopConfirmed: confirmed,
        outcome: admitted ? 'admitted' : (selected?.outcome ?? 'pending'),
        retryEligible:
          !admitted &&
          !requested &&
          result.state === 'admission_failed' &&
          selected?.outcome === 'not_admitted' &&
          selected.retryEligible === true,
      },
    };
  }
  return result;
}

/** A 404 or a predecessor rejection cannot retire a possibly delayed request. */
export function retryRetired(attempt: RetryAttempt, value: RetryReceipt): boolean {
  const retry = value?.retry,
    p = value?.preparation;
  if (
    !p ||
    !retry ||
    retry.retryId !== attempt.retryId ||
    retry.previousCommandId !== attempt.previousCommandId
  )
    throw new Error('The retry receipt does not match the saved retry.');
  if (retry.retired === true || retry.status === 'not_reserved') {
    if (
      retry.retired !== true ||
      retry.status !== 'not_reserved' ||
      retry.commandId !== undefined ||
      retry.attemptNumber !== undefined ||
      p.messageAdmission?.retryId === attempt.retryId
    )
      throw new Error('The retry receipt does not match the saved retry.');
    return true;
  }
  const number = retry.attemptNumber;
  if (
    typeof retry.commandId !== 'string' ||
    !retry.commandId.trim() ||
    !Number.isSafeInteger(number) ||
    number! <= attempt.previousAttemptNumber ||
    (p.state !== 'cancelled' &&
      (attemptNumber(p) < number! ||
        (attemptNumber(p) === number && p.messageAdmission?.commandId !== retry.commandId)))
  )
    throw new Error('The retry receipt did not identify a successor attempt.');
  return false;
}
