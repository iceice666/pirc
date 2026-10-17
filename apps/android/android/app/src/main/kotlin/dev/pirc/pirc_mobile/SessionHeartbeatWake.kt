package dev.pirc.pirc_mobile

import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.withTimeoutOrNull

/** A retired session heartbeat stops when its wake channel closes.
 * Policy-change signals and elapsed intervals continue the heartbeat; coroutine
 * cancellation propagates rather than being mistaken for an elapsed interval.
 */
internal suspend fun awaitSessionHeartbeatWake(
    wake: ReceiveChannel<Unit>,
    intervalMs: Long,
): Boolean = withTimeoutOrNull(intervalMs) { wake.receiveCatching().isSuccess } ?: true
