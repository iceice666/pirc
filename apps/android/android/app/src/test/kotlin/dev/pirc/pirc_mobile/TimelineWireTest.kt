package dev.pirc.pirc_mobile

import dev.pirc.android.core.Session
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.SessionOrigin
import dev.pirc.android.core.timeline.*
import org.junit.Assert.*
import org.junit.Test

class TimelineWireTest {
    @Test fun messageBranchesSurviveSnapshotDecoderAndFlutterChannel() {
        val raw = PircJson.parseToJsonElement("""{"session":{"id":"s","workspaceId":"w","name":"Session"},"history":[{"role":"user","entryId":"new","timestamp":1000,"content":"Revised","branches":[{"entryId":"old","text":"Original","selected":false},{"entryId":"new","text":"Revised","selected":true},{"entryId":"invalid","text":"Missing selection"}]}]}""")
        val state = snapshotState(raw)
        val message = state.messages.single()
        assertEquals("new", message.entryId)
        assertEquals(listOf(MessageBranch("old", "Original", false), MessageBranch("new", "Revised", true)), message.branches)
        val wire = (state.wire()["messages"] as List<*>).single() as Map<*, *>
        assertEquals("new", wire["entryId"])
        assertEquals(listOf(
            mapOf("entryId" to "old", "text" to "Original", "selected" to false),
            mapOf("entryId" to "new", "text" to "Revised", "selected" to true),
        ), wire["branches"])
    }

    @Test fun timelineMetadataSurvivesTheFlutterChannel() {
        val tool = ToolCall("t", "read", startedAt=1000L, endedAt=2200L)
        val message = Message("m", "assistant", "", 1000L, isPartial=true,
            thinkingRedacted=true, stopReason="aborted", errorMessage="Canceled", model="example-model",
            tools=listOf(tool), systemKind="notice", level="warning", label="Renderer", meta="detail")
        val state = SessionState(Session("s", "w", "Session"), "running", null,
            listOf(message), emptyList(), emptyList(), "cursor", "epoch")
        val wire = (state.wire()["messages"] as List<*>).single() as Map<*, *>
        assertEquals(true, wire["partial"])
        assertEquals(true, wire["thinkingRedacted"])
        assertEquals("aborted", wire["stopReason"])
        assertEquals("Canceled", wire["error"])
        assertEquals("example-model", wire["model"])
        assertEquals("warning", wire["level"])
        assertEquals("detail", wire["meta"])
        val toolWire = (wire["tools"] as List<*>).single() as Map<*, *>
        assertEquals(1000L, toolWire["startedAt"])
        assertEquals(2200L, toolWire["endedAt"])
    }

    @Test fun ptcOperationsAndApprovalAssociationSurviveTheFlutterChannel() {
        val operation = ToolCall(
            "p1x:op2",
            "edit",
            status = "succeeded",
            output = "Edited a.ts (1 replacement)",
            diff = "--- a.ts\n+++ b.ts",
            startedAt = 2600L,
            endedAt = 3000L,
        )
        val parent = ToolCall(
            "p1",
            "ptc",
            status = "failed",
            operations = listOf(operation),
        )
        val interaction = Interaction(
            id = "i2",
            runnerEpoch = "3",
            toolCallId = "p1x:op2",
            kind = "confirm",
            title = "Allow edit?",
        )
        val state = SessionState(
            Session("s", "w", "Session"),
            "running",
            null,
            listOf(Message("m", "assistant", "Renaming.", 1000L, tools = listOf(parent))),
            listOf(interaction),
            emptyList(),
            "3:20",
            "3",
        )

        val wire = state.wire()
        val message = (wire["messages"] as List<*>).single() as Map<*, *>
        val tool = (message["tools"] as List<*>).single() as Map<*, *>
        val child = (tool["operations"] as List<*>).single() as Map<*, *>
        assertEquals("p1x:op2", child["id"])
        assertEquals("edit", child["name"])
        assertEquals("succeeded", child["status"])
        assertEquals("Edited a.ts (1 replacement)", child["output"])
        assertEquals("--- a.ts\n+++ b.ts", child["diff"])
        assertEquals(2600L, child["startedAt"])
        assertEquals(3000L, child["endedAt"])

        val question = (wire["interactions"] as List<*>).single() as Map<*, *>
        assertEquals("p1x:op2", question["toolCallId"])
    }

    @Test fun approvalModesAndLiveChangesSurviveSnapshotAndEventReduction() {
        val raw = PircJson.parseToJsonElement(
            """{"session":{"id":"s","workspaceId":"w","name":"Session"},"watermark":{"epoch":1,"sequence":2},"agent":{"approvalMode":"auto","defaultApprovalMode":"read-only"}}""",
        )
        val initial = snapshotState(raw)
        assertEquals("auto", initial.approvalMode)
        assertEquals("read-only", initial.defaultApprovalMode)
        val wire = initial.wire()
        assertEquals("auto", wire["approvalMode"])
        assertEquals("read-only", wire["defaultApprovalMode"])

        val event = normalizeEvent(PircJson.parseToJsonElement(
            """{"sessionId":"s","epoch":1,"sequence":3,"type":"pi_event","data":{"type":"approval_mode_changed","mode":"full-access"}}""",
        ))
        val updated = initial.reduce(event)
        assertEquals("full-access", updated.approvalMode)
        assertEquals("1:3", updated.cursor)
        assertFalse(updated.needsSnapshot)
        assertEquals(TimelineEvent.Noop, normalizeEvent(PircJson.parseToJsonElement(
            """{"sessionId":"s","epoch":1,"sequence":4,"type":"pi_event","data":{"type":"approval_mode_changed","mode":"unknown"}}""",
        )).event)
    }

    @Test fun delegationStatusSurvivesSessionSerializationAcrossTheFlutterChannel() {
        val state = SessionState(
            Session(
                "s", "w", "Session",
                origin = SessionOrigin(
                    kind = "delegation",
                    title = "Work",
                    delegationId = "d",
                    fromSessionId = "parent",
                    status = "waiting_input",
                ),
            ),
            "running", null, emptyList(), emptyList(), emptyList(), "cursor", "epoch",
        )
        val origin = ((state.wire()["session"] as Map<*, *>)["origin"] as Map<*, *>)
        assertEquals("delegation", origin["kind"])
        assertEquals("waiting_input", origin["status"])
    }
}
