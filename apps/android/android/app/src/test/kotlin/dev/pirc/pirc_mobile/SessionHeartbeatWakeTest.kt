package dev.pirc.pirc_mobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionHeartbeatWakeTest {
    @Test fun closedChannelStopsInsteadOfThrowing() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        wake.close()
        assertFalse(awaitSessionHeartbeatWake(wake, 10_000))
    }

    @Test fun closingAWaitingChannelStopsInsteadOfCrashingTheScope() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val waiting = async { awaitSessionHeartbeatWake(wake, 10_000) }
        runCurrent()
        assertFalse(waiting.isCompleted)
        wake.close()
        assertFalse(waiting.await())
    }

    @Test fun elapsedIntervalAndPolicyChangeContinueTheHeartbeat() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val waiting = async { awaitSessionHeartbeatWake(wake, 1_000) }
        runCurrent()
        advanceTimeBy(999)
        assertFalse(waiting.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertTrue(waiting.await())
        wake.trySend(Unit)
        assertTrue(awaitSessionHeartbeatWake(wake, 10_000))
        wake.close()
    }

    @Test fun bufferedWakeAfterCloseCannotTurnIntoAnInfiniteRetry() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        wake.trySend(Unit)
        wake.close()
        assertTrue(awaitSessionHeartbeatWake(wake, 10_000))
        assertFalse(awaitSessionHeartbeatWake(wake, 10_000))
    }

    @Test fun cancellationIsNotSwallowedAsAHeartbeatTimeout() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val waiting = async { awaitSessionHeartbeatWake(wake, 10_000) }
        runCurrent()
        waiting.cancel()
        val failure = runCatching { waiting.await() }.exceptionOrNull()
        assertTrue(failure is CancellationException)
        wake.close()
    }
}
