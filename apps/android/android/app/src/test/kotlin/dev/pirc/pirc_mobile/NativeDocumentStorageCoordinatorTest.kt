package dev.pirc.pirc_mobile

import org.junit.Assert.*
import org.junit.Test

class NativeDocumentStorageCoordinatorTest {
    private val origin = "https://storage.example"
    private val native = NativeDocumentStorage()
    private val notices = mutableListOf<Map<String, Any?>>()
    private val coordinator = NativeDocumentStorageCoordinator({ native }, { null }, { notices += it })
    private fun principal(owner: String, key: String) = NativeDocumentScripts.ResourcePrincipal(
        "$origin/page", origin, ContextRegistry.PRIMARY_CONTEXT_ID, "account", owner, key)
    private fun state(owner: String, key: String, operations: List<Map<*, *>> = emptyList(), revision: Long? = null) =
        coordinator.state(principal(owner, key), "$origin/page", operations, revision, native.generation)
    private fun set(area: String, key: String, value: String) = mapOf(
        "area" to area, "type" to "set", "key" to key, "value" to value,
        "generation" to native.generation, "url" to "$origin/pushed")
    @Suppress("UNCHECKED_CAST")
    private fun events(value: Map<String, Any?>) = value["events"] as List<Map<String, Any?>>

    @Test fun localEventsCrossWindowsWhileSessionEventsStayInTheirTopLevelWindow() {
        state("source", "window-a"); state("peer", "window-a"); state("other", "window-b")
        val source = state("source", "window-a", listOf(set("local", "shared", "猫😀"), set("session", "private", "a")))
        assertTrue(events(source).isEmpty())
        assertEquals(listOf("local", "session"), events(state("peer", "window-a")).map { it["area"] })
        val other = events(state("other", "window-b"))
        assertEquals(1, other.size); assertEquals("local", other[0]["area"])
        assertEquals("$origin/pushed", other[0]["url"])
        assertEquals(3, notices.size)
        assertTrue(notices.all { it.keys == setOf("targetOwner", "generation", "origin", "revision") })
        assertTrue(events(state("other", "window-b")).isEmpty())
        state("source", "window-a", listOf(set("local", "shared", "猫😀")))
        assertEquals(3, notices.size) // Same value creates no event.
    }

    @Test fun openerCopiesOnceReloadKeepsSessionAndCloseRejectsLateWrites() {
        coordinator.openWindow("account", "opener", null)
        state("original", "opener", listOf(set("session", "draft", "before")))
        coordinator.openWindow("account", "child", "opener")
        state("original", "opener", listOf(set("session", "draft", "after")))
        coordinator.openWindow("account", "child", "opener") // no re-clone
        coordinator.closeReader("original", null)
        val restored = state("reloaded", "opener")["state"] as Map<*, *>
        assertEquals(listOf(listOf("draft", "after")), restored["session"])
        val child = state("child-doc", "child")["state"] as Map<*, *>
        assertEquals(listOf(listOf("draft", "before")), child["session"])
        coordinator.openWindow("account", "noopener", null)
        assertEquals(emptyList<Any>(), (state("new", "noopener")["state"] as Map<*, *>)["session"])
        coordinator.closeWindow("account", "child")
        assertThrows(IllegalStateException::class.java) { state("child-doc", "child", listOf(set("session", "late", "lost"))) }
        assertThrows(IllegalStateException::class.java) { coordinator.openWindow("account", "child", null) }
    }

    @Test fun standaloneCloseDropsSessionButKeepsSharedLocalState() {
        state("standalone", "standalone", listOf(set("session", "draft", "private"), set("local", "kept", "shared")))
        coordinator.closeReader("standalone", "wrong-context")
        assertEquals(1, (native.snapshot(origin,"standalone")["session"] as List<*>).size)
        coordinator.closeReader("standalone", null)
        val value = native.snapshot(origin,"standalone")
        assertEquals(emptyList<Any>(),value["session"])
        assertEquals(listOf(listOf("kept","shared")),value["local"])
    }

    @Test fun pendingEventOverflowFailsVisiblyAndNeverSilentlyDropsEvents() {
        state("source", "one"); state("slow", "two")
        repeat(257) { state("source", "one", listOf(set("local", "counter", "$it"))) }
        val reply=state("slow", "two")
        assertTrue((reply["error"] as String).contains("Too many pending"))
        assertTrue(events(reply).isEmpty())
    }

    @Test fun retiringNativeContextsDropsSessionAreasAndRetainsLocalStorage() {
        state("closed-doc", "closed-window", listOf(set("local", "kept", "local"),set("session", "draft", "session")))
        coordinator.closeReadersForContext(ContextRegistry.PRIMARY_CONTEXT_ID)
        assertEquals(emptyList<Any>(),native.snapshot(origin,"closed-window")["session"])
        assertEquals(listOf(listOf("kept","local")),native.snapshot(origin,"closed-window")["local"])
        assertThrows(IllegalStateException::class.java) {state("closed-doc","closed-window")}
        state("next-doc","next-window",listOf(set("session","draft","new")))
        coordinator.closeAllReaders()
        assertEquals(emptyList<Any>(),native.snapshot(origin,"next-window")["session"])
        assertThrows(IllegalStateException::class.java) {state("next-doc","next-window")}
    }

    @Test fun revisionSkipsUnchangedSnapshotsAndRejectsOriginOrGenerationChanges() {
        val first=state("source","one")
        assertNull(state("source","one",revision=first["revision"] as Long)["state"])
        assertThrows(IllegalStateException::class.java) {
            coordinator.state(principal("source","one"),"$origin/page",emptyList(),null,native.generation+1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            coordinator.state(principal("source","one"),"https://other.example/page",emptyList(),null,native.generation)
        }
    }
}
