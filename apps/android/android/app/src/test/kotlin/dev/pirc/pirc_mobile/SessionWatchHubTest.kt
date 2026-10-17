package dev.pirc.pirc_mobile

import org.junit.Assert.*
import org.junit.Test

class SessionWatchHubTest {
    @Test fun visibleAndHiddenHeartbeatPoliciesMatchBrowserIntervalsAndAcquisitionRules() {
        assertEquals(
            SessionLeasePolicy(mayAcquire = true, intervalMs = 10_000L),
            sessionLeasePolicy(visible = true),
        )
        assertEquals(
            SessionLeasePolicy(mayAcquire = false, intervalMs = 15_000L),
            sessionLeasePolicy(visible = false),
        )
    }

    @Test fun visibilityChangeKeepsTheStreamAndRejectsStaleWatchTags() {
        val hub = SessionWatchHub()
        hub.subscribe("session-a", "window-a", "watch-a")
        assertEquals(sessionLeasePolicy(true), hub.leasePolicy("session-a"))

        val hidden = hub.setVisibility(
            "window-a",
            visible = false,
            visibilityRevision = 2,
            eventTag = "watch-a",
        )
        assertTrue(hidden.stoppedSessions.isEmpty())
        assertEquals(listOf("session-a"), hidden.leasePolicyChangedSessions)
        assertTrue(hub.isCurrent("session-a", "window-a", "watch-a"))
        assertEquals(sessionLeasePolicy(false), hub.leasePolicy("session-a"))

        val stale = hub.setVisibility(
            "window-a",
            visible = true,
            visibilityRevision = 3,
            eventTag = "stale-watch",
        )
        assertTrue(stale.staleTag)
        assertFalse(hub.contextVisible("window-a"))
        assertEquals(sessionLeasePolicy(false), hub.leasePolicy("session-a"))

        val staleHide = hub.setVisibility(
            "window-a",
            visible = false,
            visibilityRevision = 1,
            eventTag = "watch-a",
        )
        assertTrue(staleHide.staleVisibility)
        assertFalse(hub.contextVisible("window-a"))
        assertEquals(2L, hub.visibilityRevision("window-a"))

        val resumed = hub.setVisibility(
            "window-a",
            visible = true,
            visibilityRevision = 4,
            eventTag = "watch-a",
        )
        assertEquals(listOf("session-a"), resumed.leasePolicyChangedSessions)
        assertTrue(hub.isCurrent("session-a", "window-a", "watch-a"))
        assertEquals(sessionLeasePolicy(true), hub.leasePolicy("session-a"))
    }

    @Test fun mixedVisibilityUsesVisiblePolicyAndClosedContextDoesNotLeakItsHiddenState() {
        val hub = SessionWatchHub()
        hub.setVisibility("window-a", visible = false, visibilityRevision = 1)
        hub.subscribe("session-a", "window-a", "watch-a")
        assertEquals(sessionLeasePolicy(false), hub.leasePolicy("session-a"))

        hub.subscribe("session-a", "window-b", "watch-b")
        assertEquals(sessionLeasePolicy(true), hub.leasePolicy("session-a"))
        hub.setVisibility(
            "window-b",
            visible = false,
            visibilityRevision = 1,
            eventTag = "watch-b",
        )
        assertEquals(sessionLeasePolicy(false), hub.leasePolicy("session-a"))

        val closed = hub.removeContext("window-a")
        assertTrue(closed.stoppedSessions.isEmpty())
        assertEquals(listOf("window-b"), hub.subscribers("session-a").map { it.contextId })
        assertEquals(sessionLeasePolicy(false), hub.leasePolicy("session-a"))

        val lastClosed = hub.removeContext("window-b")
        assertEquals(listOf("session-a"), lastClosed.stoppedSessions)
        assertEquals(true, hub.contextVisible("window-a"))
        assertNull(hub.visibilityRevision("window-a"))
        hub.subscribe("session-a", "window-a", "new-watch")
        assertEquals(sessionLeasePolicy(true), hub.leasePolicy("session-a"))
    }

    @Test fun sameSessionSharesUpstreamAndClosingOneContextKeepsOtherSubscriber() {
        val hub = SessionWatchHub()
        val first = hub.subscribe("session-a", "window-a", "watch-a")
        val second = hub.subscribe("session-a", "window-b", "watch-b")

        assertEquals(listOf("session-a"), first.startedSessions)
        assertTrue(second.startedSessions.isEmpty())
        assertEquals(2, hub.subscriberCount("session-a"))

        val closed = hub.unsubscribe("window-a", "watch-a")

        assertTrue(closed.stoppedSessions.isEmpty())
        assertEquals(1, hub.subscriberCount("session-a"))
        assertEquals(listOf("window-b"), hub.subscribers("session-a").map { it.contextId })
        assertTrue(hub.isCurrent("session-a", "window-b", "watch-b"))
    }

    @Test fun differentSessionsHaveIndependentStreamLifetimes() {
        val hub = SessionWatchHub()
        val sessionA = hub.subscribe("session-a", "window-a", "watch-a")
        val sessionB = hub.subscribe("session-b", "window-b", "watch-b")

        assertEquals(listOf("session-a"), sessionA.startedSessions)
        assertEquals(listOf("session-b"), sessionB.startedSessions)
        assertEquals(2, hub.sessionCount())

        val closed = hub.removeContext("window-a")

        assertEquals(listOf("session-a"), closed.stoppedSessions)
        assertEquals(1, hub.sessionCount())
        assertTrue(hub.isCurrent("session-b", "window-b", "watch-b"))
        assertFalse(hub.isCurrent("session-a", "window-a", "watch-a"))
    }

    @Test fun deletingSessionRetiresEveryContextAndBlocksStaleRewatchUntilAccountReset() {
        val hub = SessionWatchHub()
        hub.subscribe("session-a", "window-a", "watch-a")
        hub.subscribe("session-a", "window-b", "watch-b")
        hub.subscribe("session-b", "window-c", "watch-c")

        val deleted = hub.markDeleted("session-a")

        assertEquals(listOf("session-a"), deleted.stoppedSessions)
        assertTrue(deleted.sessionDeleted)
        assertEquals(0, hub.subscriberCount("session-a"))
        assertNull(hub.subscription("window-a"))
        assertNull(hub.subscription("window-b"))
        assertEquals(listOf("window-c"), hub.subscribers("session-b").map { it.contextId })

        val staleWatch = hub.subscribe("session-a", "window-a", "stale-watch")
        assertTrue(staleWatch.sessionDeleted)
        assertNull(staleWatch.subscription)
        assertEquals(1, hub.sessionCount())

        hub.clear()
        val afterAccountReset = hub.subscribe("session-a", "window-a", "new-account-watch")
        assertFalse(afterAccountReset.sessionDeleted)
        assertEquals("session-a", afterAccountReset.subscription?.sessionId)
    }

    @Test fun staleUnwatchTagCannotRemoveTheCurrentWatch() {
        val hub = SessionWatchHub()
        hub.subscribe("session-a", "window-a", "old-watch")
        val switched = hub.subscribe("session-b", "window-a", "new-watch")

        assertEquals(listOf("session-a"), switched.stoppedSessions)
        assertEquals(listOf("session-b"), switched.startedSessions)

        val stale = hub.unsubscribe("window-a", "old-watch")
        assertTrue(stale.staleTag)
        assertFalse(stale.removed)
        assertTrue(hub.isCurrent("session-b", "window-a", "new-watch"))
        assertEquals(1, hub.subscriberCount("session-b"))
    }

    @Test fun accountPurgeStopsAllSessionsAndRetiresEveryEventTag() {
        val hub = SessionWatchHub()
        hub.subscribe("session-a", "window-a", "watch-a")
        hub.subscribe("session-a", "window-b", "watch-b")
        hub.subscribe("session-b", "window-c", "watch-c")

        val purged = hub.clear()

        assertEquals(setOf("session-a", "session-b"), purged.stoppedSessions.toSet())
        assertEquals(0, hub.sessionCount())
        assertEquals(0, hub.subscriberCount("session-a"))
        assertFalse(hub.isCurrent("session-a", "window-a", "watch-a"))
        assertFalse(hub.isCurrent("session-b", "window-c", "watch-c"))
        assertNull(hub.visibilityRevision("window-a"))
    }
    @Test fun eventWireUsesDartWatchTagKeyAndScopesChildEvents() {
        val event = scopedEventWire(
            type = "snapshot",
            data = mapOf("session" to "session-a"),
            sessionId = "session-a",
            contextId = "window-a",
            watchTag = "watch-a",
        )

        assertEquals("window-a", event["contextId"])
        assertEquals("watch-a", event["watchTag"])
        assertFalse(event.containsKey("eventTag"))
        assertEquals("snapshot", event["type"])
    }

    @Test fun primaryEventKeepsLegacyEnvelopeAndAccountScopeIsTagged() {
        val primary = scopedEventWire("connection", "live", "session-a", "primary", "watch-a")
        assertEquals("watch-a", primary["watchTag"])
        assertFalse(primary.containsKey("contextId"))

        val account = scopedEventWire("pairingChanged", mapOf("origin" to "https://example.test"), null, scopeName = "account")
        assertEquals("account", account["scope"])
        assertFalse(account.containsKey("contextId"))
        assertFalse(account.containsKey("watchTag"))

        val preferences = mapOf("appearance" to "dark", "mode" to "chat")
        val preferenceChange = scopedEventWire(
            "preferencesChanged",
            preferences,
            sessionId = null,
            scopeName = "account",
        )
        assertEquals("account", preferenceChange["scope"])
        assertEquals(preferences, preferenceChange["data"])
        assertFalse((preferenceChange["data"] as Map<*, *>).containsKey("token"))
    }

}
