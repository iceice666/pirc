package dev.pirc.pirc_mobile

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** A session's snapshot as the engine keeps it: no transcript (decision 4). */
class SessionMetaTest {
    @Test
    fun keepsTheRecordTheRunAndTheRunnerOnly() {
        val meta = SessionMeta.from(PircJson.parseToJsonElement(
            """{"session":{"id":"s","name":"Fix lint","workspaceId":"w"},"run":{"id":"r","status":"running"},
               "runnerStatus":"ready","runnerEpoch":"4","cursor":"4:12","messages":[{"id":"m"}],"interactions":[]}""",
        ))
        val wire = meta.wire()
        assertEquals(setOf("session", "run", "runnerStatus", "runnerEpoch", "cursor"), wire.keys)
        assertEquals("Fix lint", (wire["session"] as Map<*, *>)["name"])
        assertEquals("running", (wire["run"] as Map<*, *>)["status"])
        assertEquals("4:12", wire["cursor"])
    }

    @Test
    fun aSnapshotWithoutASessionIsABadReply() {
        assertThrows(ApiException::class.java) { SessionMeta.from(PircJson.parseToJsonElement("""{"run":null}""")) }
    }

    @Test
    fun thePlatformWireKeepsBooleansNumbersAndText() {
        val raw = mapOf("flag" to true, "generation" to 9007199254740992L, "nullable" to null, "nested" to listOf(mapOf("text" to "中文")))
        assertEquals(raw, raw.json().wire())
    }
}
