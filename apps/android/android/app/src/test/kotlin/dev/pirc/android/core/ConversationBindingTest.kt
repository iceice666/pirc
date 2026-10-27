package dev.pirc.android.core

import dev.pirc.android.core.timeline.snapshotState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ConversationBindingTest {
    private val raw = """{"id":"same-id","workspaceId":"node:project","name":"Existing","runnerEpoch":50,"binding":{"version":1,"membership":{"revision":2,"legacyWorkspaceId":"node:project"},"execution":{"generation":7,"workspaceId":"node:project","nodeId":"node","modeId":"research"}}}"""

    @Test fun capturedCommandBindingRejectsMalformedInputBeforeDelivery() {
        val binding = PircJson.parseToJsonElement(raw).jsonObject["binding"]!!
        assertEquals(7L, commandBinding(binding).execution.generation)
        for (invalid in listOf(JsonNull, JsonArray(emptyList()), JsonObject(emptyMap()),
            PircJson.parseToJsonElement(binding.toString().replace("\"generation\":7", "\"generation\":0")))) {
            val error = runCatching { commandBinding(invalid) }.exceptionOrNull()
            assertTrue(error is ApiException && error.status == 400)
        }
    }

    @Test fun snapshotAndEditsRetainIndependentRevisionsAndTheBridgePayload() {
        val state = snapshotState(PircJson.parseToJsonElement("""{"session":$raw,"watermark":{"epoch":50,"sequence":4}}""")) { 1L }
        assertEquals("same-id", state.session.id)
        assertEquals("50", state.runnerEpoch)
        assertEquals(2L, state.session.binding!!.membership.revision)
        assertEquals(7L, state.session.binding!!.execution.generation)
        val edited = state.session.edited(name="Updated", pinned=true)
        assertEquals(state.session.binding, edited.binding)
        // SessionState.wire sends this same serialized Session to Flutter.
        val bridge = PircJson.encodeToJsonElement(Session.serializer(), edited).jsonObject
        assertEquals(PircJson.parseToJsonElement(raw).jsonObject["binding"], bridge["binding"])
        assertEquals(edited, PircJson.decodeFromJsonElement(Session.serializer(), bridge))
    }

    @Test fun legacyServerDoesNotInventBindingVersions() {
        val session = PircJson.decodeFromString<Session>("""{"id":"old","workspaceId":"node:repo","name":"Old"}""")
        assertNull(session.binding)
    }

    @Test fun nullNodeMappingSurvivesSerialization() {
        val session = PircJson.decodeFromString<Session>(raw.replace("\"nodeId\":\"node\"", "\"nodeId\":null"))
        assertNull(session.binding!!.execution.nodeId)
        assertEquals(session, PircJson.decodeFromJsonElement(Session.serializer(), PircJson.encodeToJsonElement(Session.serializer(), session)))
    }

    @Test fun unsupportedVersionsAndConflictingScopesAreNotOldServerFallbacks() {
        val invalid = listOf(
            raw.replace("\"version\":1", "\"version\":2"),
            raw.replace("\"revision\":2", "\"revision\":0"),
            raw.replace("\"legacyWorkspaceId\":\"node:project\"", "\"legacyWorkspaceId\":\"other\""),
            raw.replace("\"generation\":7", "\"generation\":9007199254740992"),
            raw.replace("\"modeId\":\"research\"", "\"modeId\":\"\""),
            raw.replace("\"generation\":7,\"workspaceId\":\"node:project\"", "\"generation\":7,\"workspaceId\":\"other\""),
        )
        for (input in invalid) {
            assertTrue(input, runCatching { PircJson.decodeFromString<Session>(input) }.isFailure)
        }
    }
}
