package dev.pirc.pirc_mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EventStreamTeardownTest {
    @Test
    fun synchronousTeardownCannotCloseAContextOpenedByTheNextListener() {
        val registry = ContextRegistry()
        registry.bindPairingStamp("pairing")
        val oldLease = registry.openContext("old-window", "pairing")
        var pendingWorkCancelled = false

        val teardown = EventStreamTeardown(
            cancelPendingOperations = { pendingWorkCancelled = true },
            invalidateContexts = { registry.invalidateAll() },
        )
        teardown.cancel()

        assertTrue(pendingWorkCancelled)
        assertFalse(registry.isCurrent(oldLease))

        // A listener that attaches after onCancel returns gets a clean registry;
        // no delayed teardown from the old listener can invalidate this lease.
        val newLease = registry.openContext("new-window", "pairing")
        assertTrue(registry.isCurrent(newLease))
    }
}
