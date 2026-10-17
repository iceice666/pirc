package dev.pirc.android.push

import dev.pirc.android.core.Pairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrationGuardTest {
    private val firstPairing = Pairing("https://first.example", "device-token-a")
    private val secondPairing = Pairing("https://second.example", "device-token-b")

    @Test
    fun pendingEndpointIsCompensatedAfterDisableOrReplacement() {
        val pending = PushRegistrationAttempt("attempt-a", firstPairing)

        val active = PushRegistrationSnapshot(true, "attempt-a", firstPairing)
        assertTrue(active.accepts(pending))
        assertFalse(active.shouldCompensate(pending))

        val disabled = PushRegistrationSnapshot(false, null, firstPairing)
        assertFalse(disabled.accepts(pending))
        assertTrue(disabled.shouldCompensate(pending))

        val replacement = PushRegistrationSnapshot(true, "attempt-b", firstPairing)
        assertFalse(replacement.accepts(pending))
        assertTrue(replacement.shouldCompensate(pending))
    }

    @Test
    fun accountChangeRejectsCompletionEvenWhenInstanceMatches() {
        val pending = PushRegistrationAttempt("attempt-a", firstPairing)
        val afterPairingChange = PushRegistrationSnapshot(true, "attempt-a", secondPairing)

        assertFalse(afterPairingChange.accepts(pending))
        assertTrue(afterPairingChange.shouldCompensate(pending))
    }

    @Test
    fun lateFailureOrUnregisterFromPreviousAttemptIsIgnored() {
        val current = PushRegistrationSnapshot(true, "attempt-b", secondPairing)

        assertTrue(current.acceptsCallback("attempt-b"))
        assertFalse(current.acceptsCallback("attempt-a"))
        assertFalse(current.acceptsCallback(LEGACY_UNIFIED_PUSH_INSTANCE))
    }



    @Test
    fun replacementMustBeRegisteredBeforeOldInstancesAreRetired() {
        val calls = mutableListOf<String>()
        val failed = runCatching {
            registerBeforeRetiring(
                activeInstance = "new",
                retiredInstances = setOf("old"),
                register = {
                    calls += "register"
                    error("invalid VAPID")
                },
                unregister = { calls += "unregister:$it" },
            )
        }.exceptionOrNull()

        assertTrue(failed is IllegalStateException)
        assertEquals(listOf("register"), calls)

        calls.clear()
        val result = registerBeforeRetiring(
            activeInstance = "new",
            retiredInstances = setOf("old-a", "old-b", "new"),
            register = {
                calls += "register"
                true
            },
            unregister = { instance ->
                calls += "unregister:$instance"
                if (instance == "old-b") error("temporary connector failure")
            },
        )

        assertEquals(listOf("register", "unregister:old-a", "unregister:old-b"), calls)
        assertTrue(result.registered)
        assertEquals(setOf("old-b"), result.pendingRetiredInstances)
    }

    @Test
    fun staleReplacementDoesNotRetireOldRegistration() {
        val calls = mutableListOf<String>()
        val result = registerBeforeRetiring(
            activeInstance = "new",
            retiredInstances = setOf("old"),
            register = {
                calls += "guard"
                false
            },
            unregister = { calls += "unregister:$it" },
        )

        assertEquals(listOf("guard"), calls)
        assertFalse(result.registered)
        assertEquals(setOf("old"), result.pendingRetiredInstances)
    }

    @Test
    fun legacyDefaultCallbacksRemainAcceptedAndCanBeUnregistered() {
        val legacy = PushRegistrationSnapshot(true, null, firstPairing)

        assertTrue(legacy.acceptsCallback(LEGACY_UNIFIED_PUSH_INSTANCE))
        assertFalse(legacy.acceptsCallback("new-attempt"))
        assertEquals(
            LEGACY_UNIFIED_PUSH_INSTANCE,
            unifiedPushInstanceToUnregister(
                instance = null,
                enabled = false,
                endpoint = "https://push.example/endpoint",
                error = null,
            ),
        )
        assertNull(
            unifiedPushInstanceToUnregister(
                instance = null,
                enabled = false,
                endpoint = null,
                error = null,
            ),
        )
    }
}
