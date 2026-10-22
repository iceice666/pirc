package dev.pirc.android.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a session's stream changes for the engine (plans/rewrite/12-android.md, decision 4). */
class SessionEventsTest {
    private fun frame(json: String) = PircJson.parseToJsonElement(json) as JsonObject
    private fun pi(type: String, extra: String = "") =
        frame("""{"sessionId":"s","epoch":3,"sequence":5,"type":"pi_event","data":{"type":"$type"$extra}}""")

    @Test
    fun deletedRenamedAndPanelsAreSaid() {
        assertEquals(SessionChange.Deleted, sessionChange(frame("""{"type":"session_deleted","data":{"sessionId":"s"}}""")))
        assertEquals(SessionChange.Renamed("Fix lint"), sessionChange(frame("""{"type":"session_renamed","data":{"name":"Fix lint"}}""")))
        assertEquals(SessionChange.None, sessionChange(frame("""{"type":"session_renamed","data":{}}""")))
        assertEquals(SessionChange.PanelChanged(listOf("git", "tasks")), sessionChange(pi("panel_changed", ""","sections":["git","tasks"]""")))
    }

    @Test
    fun runAndRunnerChangesAreReadAgain() {
        for (type in listOf("agent_start", "agent_end", "agent_settled")) assertEquals(type, SessionChange.Refresh, sessionChange(pi(type)))
        for (type in listOf("reset", "runner_ready", "runner_exit", "node_offline", "interaction_created")) {
            assertEquals(type, SessionChange.Refresh, sessionChange(frame("""{"type":"$type"}""")))
        }
    }

    @Test
    fun theTranscriptChangesNothingShown() {
        assertEquals(SessionChange.None, sessionChange(pi("message_update")))
        assertEquals(SessionChange.None, sessionChange(pi("tool_execution_end")))
        assertEquals(SessionChange.None, sessionChange(frame("""{"type":"runner_stderr"}""")))
    }

    @Test
    fun aFrameResumesAtItsEpochAndSequence() {
        assertEquals("3:5", frameCursor(pi("message_update")))
        assertEquals("0:0", frameCursor(frame("""{"type":"reset"}""")))
    }

    @Test
    fun aLeaseIsReadAsItsHolderSeesIt() {
        val mine = ControlLease.from(PircJson.parseToJsonElement("""{"lease":{"clientId":"me","generation":4,"expiresAt":9}}"""), "me")
        assertTrue(mine.heldByCurrentClient)
        assertEquals(4L, mine.generation)
        val expired = ControlLease.from(PircJson.parseToJsonElement("""{"lease":{"clientId":"other","expired":true}}"""), "me")
        assertFalse(expired.heldByCurrentClient)
        assertTrue(expired.free)
        val none = ControlLease.from(PircJson.parseToJsonElement("""{}"""), "me")
        assertNull(none.holderClientId)
        assertTrue(none.free)
    }
}
