package dev.pirc.pirc_mobile

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.rooms.RoomSignal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rooms' domain against a scripted gateway: loading, the stream, and what events ask for. */
@OptIn(ExperimentalCoroutinesApi::class)
class RoomsRuntimeTest {
    private val me = "me@example.com"

    private fun room(id: String, lastSeq: Int, readSeq: Int, unread: Int = 0, activity: Int = 1) = """
        {"id":"$id","name":"$id","kind":"topic","createdAt":1,"archivedAt":null,"lastActivityAt":$activity,
         "sourceScope":null,"movedToRoomId":null,"movedFromRoomId":null,"lastSeq":$lastSeq,"readSeq":$readSeq,
         "unread":$unread,"waiting":false,"waitingSince":null}
    """.trimIndent()

    private fun message(id: String, room: String, seq: Int, speaker: String = "face:host", user: String? = null) = """
        {"id":"$id","roomId":"$room","seq":$seq,"speaker":"$speaker","user":${user?.let { "\"$it\"" } ?: "null"},
         "kind":"text","body":{"text":"t$seq"},"threadId":null,"createdAt":$seq,"editedAt":null,"pinnedAt":null}
    """.trimIndent()

    /** A gateway that answers from [routes] (`METHOD path` → JSON) and records every call. */
    private class FakeApi(val routes: MutableMap<String, String>) :
        PircApi(Pairing("https://pirc.test", "pirc_dev_" + "a".repeat(43))) {
        val calls = mutableListOf<String>()
        override suspend fun json(method: String, path: String, body: JsonObject?): JsonElement? {
            calls += "$method $path" + (body?.let { " $it" } ?: "")
            val reply = routes["$method $path"] ?: throw ApiException(404, "not_found", "no route $method $path")
            return PircJson.parseToJsonElement(reply)
        }
    }

    private class Harness(val runtime: RoomsRuntime, val api: FakeApi, val signals: Channel<RoomSignal>, val published: MutableList<Pair<String, Any?>>)

    /**
     * The runtime's scope runs on the test's scheduler (so advanceUntilIdle
     * runs its work) and is cancelled when [block] ends (the stream never does).
     */
    private fun roomsTest(api: FakeApi = gateway(), clock: () -> Long = { 10_000 }, block: suspend TestScope.(Harness) -> Unit) = runTest {
        val job = Job()
        val signals = Channel<RoomSignal>(Channel.UNLIMITED)
        val published = mutableListOf<Pair<String, Any?>>()
        val runtime = RoomsRuntime(
            scope = CoroutineScope(coroutineContext + job),
            api = { api },
            publish = { type, data -> published += type to data },
            stream = { signals.receiveAsFlow() },
            clock = clock,
            publishDelayMs = 0,
        )
        try {
            block(Harness(runtime, api, signals, published))
        } finally {
            job.cancel()
        }
    }

    private fun gateway() = FakeApi(mutableMapOf(
        "GET /api/rooms" to """{"user":"$me","rooms":[${room("general", 1, 1, activity = 1)},${room("slime", 2, 1, unread = 1, activity = 5)}]}""",
        "GET /api/rooms/general" to """{"room":${room("general", 1, 1)},"pinned":[]}""",
        "GET /api/rooms/general/messages?limit=50" to """{"messages":[${message("m1", "general", 1)}],"hasMore":false}""",
        "GET /api/rooms/slime" to """{"room":${room("slime", 2, 1, unread = 1, activity = 5)},"pinned":[]}""",
        "GET /api/rooms/slime/messages?limit=50" to """{"messages":[${message("s1", "slime", 1)},${message("s2", "slime", 2)}],"hasMore":true}""",
        "POST /api/rooms/slime/read" to """{"room":${room("slime", 2, 2, unread = 0, activity = 5)}}""",
        "POST /api/rooms/general/read" to """{"room":${room("general", 2, 2, unread = 0)}}""",
        "GET /api/faces?hidden=1" to """{"faces":[{"id":"host","name":"pirc"}],"presence":[{"faceId":"host","state":"idle"}]}""",
    ))

    @Suppress("UNCHECKED_CAST")
    private fun snapshot(h: Harness) = h.published.last { it.first == "rooms" }.second as Map<String, Any?>

    @Test
    fun startLoadsTheListTheRoomAndTheFacesInActivityOrder() = roomsTest { h ->
        h.runtime.start(null)
        advanceUntilIdle()
        val shown = snapshot(h)
        assertEquals(me, shown["user"])
        assertEquals("general", shown["currentId"])
        assertEquals(listOf("slime", "general"), (shown["rooms"] as List<Map<String, Any?>>).map { it["id"] })
        assertEquals(listOf("m1"), (shown["messages"] as List<Map<String, Any?>>).map { it["id"] })
        assertEquals(listOf("host"), (shown["faces"] as List<Map<String, Any?>>).map { it["id"] })
        assertEquals(false, shown["loading"])
        assertNull(shown["error"])
    }

    @Test
    fun readsCountOnlyWhileTheAppIsInFront() = roomsTest { h ->
        h.runtime.start("slime")
        advanceUntilIdle()
        assertTrue("read while hidden", h.api.calls.none { it.startsWith("POST /api/rooms/slime/read") })
        h.runtime.setVisible(true)
        advanceUntilIdle()
        assertTrue(h.api.calls.any { it == "POST /api/rooms/slime/read {\"seq\":2}" })
        val slime = (snapshot(h)["rooms"] as List<Map<String, Any?>>).first { it["id"] == "slime" }
        assertEquals(0L, slime["unread"])
    }

    @Test
    fun streamEventsGoThroughTheReducerAndTheirEffectsRun() = roomsTest { h ->
        h.runtime.setVisible(true)
        h.runtime.start(null)
        advanceUntilIdle()
        h.signals.send(RoomSignal.Connected)
        h.signals.send(RoomSignal.Ready(
            presence = listOf(PircJson.parseToJsonElement("""{"face":"host","roomId":"general","state":"thinking","since":1}""") as JsonObject),
            faces = null,
        ))
        // A face speaks in the open room: shown, then read.
        h.signals.send(RoomSignal.Event(PircJson.parseToJsonElement(
            """{"type":"room_message","roomId":"general","epoch":1,"sequence":5,"timestamp":2,"data":{"message":${message("m2", "general", 2)}}}""",
        ) as JsonObject))
        advanceUntilIdle()
        val shown = snapshot(h)
        assertEquals("connected", shown["connection"])
        assertEquals(mapOf("general" to listOf("host")), shown["thinking"])
        assertEquals(listOf("m1", "m2"), (shown["messages"] as List<Map<String, Any?>>).map { it["id"] })
        assertTrue(h.api.calls.any { it == "POST /api/rooms/general/read {\"seq\":2}" })
        // A room the list does not know: the list reloads.
        val before = h.api.calls.count { it == "GET /api/rooms" }
        h.signals.send(RoomSignal.Event(PircJson.parseToJsonElement(
            """{"type":"room_changed","roomId":"new","epoch":1,"sequence":6,"timestamp":3,"data":{"room":${room("new", 0, 0)}}}""",
        ) as JsonObject))
        advanceUntilIdle()
        assertEquals(before + 1, h.api.calls.count { it == "GET /api/rooms" })
    }

    @Test
    fun aResetReloadsEverything() = roomsTest { h ->
        h.runtime.start(null)
        advanceUntilIdle()
        val loads = h.api.calls.count { it == "GET /api/rooms/general/messages?limit=50" }
        h.signals.send(RoomSignal.Reset)
        advanceUntilIdle()
        assertEquals(loads + 1, h.api.calls.count { it == "GET /api/rooms/general/messages?limit=50" })
    }

    @Test
    fun switchingRoomsNeverShowsTheLastRoomsMessagesAndAMissingRoomSaysSo() = roomsTest { h ->
        h.runtime.start(null)
        advanceUntilIdle()
        h.runtime.open("gone")
        advanceUntilIdle()
        val shown = snapshot(h)
        assertEquals("gone", shown["currentId"])
        assertEquals(emptyList<Any>(), shown["messages"])
        assertEquals("This room does not exist.", shown["error"])
    }

    @Test
    fun typingIsSentAtMostEveryThreeSeconds() {
        var now = 10_000L
        val api = gateway().also { it.routes["POST /api/rooms/general/typing"] = "{}" }
        roomsTest(api, { now }) { h -> typing(h, { now += it }) }
    }

    private suspend fun TestScope.typing(h: Harness, wait: (Long) -> Unit) {
        val runtime = h.runtime
        val api = h.api
        runtime.keystroke("general")
        wait(1_000)
        runtime.keystroke("general")
        wait(2_500)
        runtime.keystroke("general")
        advanceUntilIdle()
        assertEquals(2, api.calls.count { it.startsWith("POST /api/rooms/general/typing") })
    }

    @Test
    fun aRoomIsShowingOnlyOpenAndInFront() = roomsTest { h ->
        h.runtime.start("general")
        advanceUntilIdle()
        assertTrue(!h.runtime.isShowing("general"))
        h.runtime.setVisible(true)
        assertTrue(h.runtime.isShowing("general"))
        assertTrue(!h.runtime.isShowing("slime"))
        h.runtime.setVisible(false)
        assertTrue(!h.runtime.isShowing("general"))
    }

    @Test
    fun stopForgetsTheAccountsRooms() = roomsTest { h ->
        h.runtime.start(null)
        advanceUntilIdle()
        h.runtime.stop()
        assertEquals("rooms" to null, h.published.last())
        assertNull(h.runtime.wire())
    }
}
