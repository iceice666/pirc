package dev.pirc.pirc_mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayPushVisibilityTest {
    @Test
    fun onlyVisibleSubscribersSuppressTheirSessionPush() {
        val watches = SessionWatchHub()
        watches.subscribe("session-1", "primary", null)

        assertTrue(shouldSuppressVisibleSessionPush("session-1", watches::hasVisibleSubscriber))
        assertFalse(shouldSuppressVisibleSessionPush("session-2", watches::hasVisibleSubscriber))
        assertFalse(shouldSuppressVisibleSessionPush(null, watches::hasVisibleSubscriber))

        // The hidden app keeps its stream/watch lease, but should receive a push.
        watches.setVisibility("primary", false, 1)
        assertFalse(shouldSuppressVisibleSessionPush("session-1", watches::hasVisibleSubscriber))
        assertFalse(watches.leasePolicy("session-1").mayAcquire)

        // A second foreground context showing the session still suppresses it.
        watches.subscribe("session-1", "context-2", null)
        assertTrue(shouldSuppressVisibleSessionPush("session-1", watches::hasVisibleSubscriber))
    }
}
