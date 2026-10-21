package dev.pirc.android.core.rooms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The frames of `/api/events?rooms=1` and where the stream resumes after each. */
class RoomStreamTest {
    @Test
    fun readyCarriesPresenceAndSetsTheCursor() {
        val (signal, cursor) = roomFrame(
            """{"type":"ready","watermark":{"epoch":7,"sequence":12},
               "presence":[{"face":"host","roomId":"general","state":"thinking","since":1}],
               "faces":[{"faceId":"host","state":"idle"}]}""",
            null,
        )!!
        val ready = signal as RoomSignal.Ready
        assertEquals("7:12", cursor)
        assertEquals(mapOf("general" to listOf("host")), thinkingFrom(ready.presence))
        assertEquals(setOf("host"), facePresenceFrom(ready.faces!!).keys)
    }

    @Test
    fun anOlderGatewaysReadyHasNoFaces() {
        val ready = roomFrame("""{"type":"ready","watermark":{"epoch":1,"sequence":0}}""", "1:0")!!.first as RoomSignal.Ready
        assertTrue(ready.presence.isEmpty())
        assertNull(ready.faces)
    }

    @Test
    fun numberedEventsMoveTheCursorAndEphemeralOnesDoNot() {
        val typing = roomFrame(
            """{"type":"room_typing","roomId":"general","epoch":7,"sequence":0,"data":{"user":"u","expiresAt":9}}""",
            "7:12",
        )!!
        assertTrue(typing.first is RoomSignal.Event)
        assertEquals("7:12", typing.second)
        val message = roomFrame(
            """{"type":"room_message","roomId":"general","epoch":7,"sequence":13,"data":{"message":{"id":"m"}}}""",
            "7:12",
        )!!
        assertEquals("7:13", message.second)
    }

    @Test
    fun resetSaysReloadFromTheNewWatermark() {
        val (signal, cursor) = roomFrame("""{"type":"reset","reason":"x","watermark":{"epoch":8,"sequence":0}}""", "7:13")!!
        assertEquals(RoomSignal.Reset, signal)
        assertEquals("8:0", cursor)
    }

    @Test
    fun theRoomsStreamCarriesOnlyItsOwnEvents() {
        for (type in listOf("room_changed", "thread_message", "face_presence", "brain_presence", "loop_changed", "wake_changed")) {
            assertTrue(type, isRoomEvent(type))
        }
        // Hints and session events are not room events.
        assertNull(roomFrame("""{"type":"memory_changed"}""", "1:1"))
        assertNull(roomFrame("""{"type":"message_delta","sequence":4}""", "1:1"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun aFrameThatIsNotAnObjectIsInvalid() {
        roomFrame("[1,2]", null)
    }

    @Test
    fun onlyAuthAndValidationClosesAreFinal() {
        assertEquals(401, roomStreamFatal(4401, null, "token revoked")!!.status)
        assertEquals(401, roomStreamFatal(null, 401)!!.status)
        assertEquals(403, roomStreamFatal(4403, null)!!.status)
        assertEquals(400, roomStreamFatal(4400, null)!!.status)
        assertNull(roomStreamFatal(1006, null))
        assertNull(roomStreamFatal(null, 502))
    }
}
