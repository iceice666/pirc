package dev.pirc.android

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.ControlLease
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ControlKeeperTest {
    @Test
    fun acquiresAFreeLeaseThenRenewsIt() = runTest {
        val api = FakeApi()
        api.lease = ControlLease()
        val keeper = ControlKeeper(backgroundScope, api, SESSION, ME) {}
        api.lease = ControlLease(ME, heldByCurrentClient = true, generation = 3)
        keeper.start()
        runCurrent()
        assertEquals(3L, keeper.generation)
        advanceTimeBy(10_001)
        assertTrue(api.calls.last().startsWith("heartbeat:3"))
        keeper.stop()
        val calls = api.calls.size
        advanceTimeBy(60_000)
        assertEquals(calls, api.calls.size)
    }

    @Test
    fun neverForcesUnlessTaken() = runTest {
        val api = FakeApi()
        api.lease = ControlLease("web", heldByCurrentClient = false, generation = 5)
        val keeper = ControlKeeper(backgroundScope, api, SESSION, ME) {}
        keeper.start()
        runCurrent()
        assertNull(keeper.generation)
        assertTrue(api.calls.none { it == "acquire:true" })
        api.lease = ControlLease(ME, heldByCurrentClient = true, generation = 6)
        keeper.take()
        runCurrent()
        assertTrue("acquire:true" in api.calls)
        assertEquals(6L, keeper.generation)
    }

    @Test
    fun reportsADeadTokenAndRidesOutBlips() = runTest {
        val errors = mutableListOf<IOException>()
        val api = object : FakeApi() {
            var failure: ApiException? = ApiException(401, "unauthenticated", "revoked")
            override suspend fun control(sessionId: String, clientId: String): ControlLease {
                failure?.let { throw it }
                return super.control(sessionId, clientId)
            }
        }
        api.lease = ControlLease(ME, heldByCurrentClient = true, generation = 1)
        val keeper = ControlKeeper(backgroundScope, api, SESSION, ME) { errors += it }
        keeper.start()
        runCurrent()
        assertEquals(1, errors.size)
        // A transient failure is not reported; the next sync picks the lease up.
        api.failure = ApiException(503, null, "node offline")
        advanceTimeBy(10_001)
        assertEquals(1, errors.size)
        api.failure = null
        advanceTimeBy(10_001)
        assertEquals(1L, keeper.generation)
    }
}
