package dev.pirc.pirc_mobile

import dev.pirc.android.core.PushNote
import dev.pirc.android.core.PushTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Notifications point to rooms (plans/rewrite/12-android.md, decision 1). */
class RoomNotificationsTest {
    private fun note(json: String) = PushNote.parse(json.toByteArray())!!

    @Test
    fun aRoomsPushOpensTheRoom() {
        // The gateway's room_message payload (crates/pirc-gateway/src/push.rs).
        val pushed = note("""{"title":"pirc","body":"Here","tag":"room:general","target":{"roomId":"general"},"at":5}""")
        assertEquals(PushTarget.OpenRoom("general"), pushed.target)
        assertEquals("room:general", pushed.tag)
        assertEquals(RoomNotifications.tag("general"), pushed.tag)
        assertNull(pushed.interaction)
    }

    @Test
    fun memoryAndSessionsStillHaveTheirTargets() {
        assertEquals(PushTarget.OpenMemory, note("""{"title":"pirc","body":"b","tag":"memory","target":{"memory":true}}""").target)
        assertEquals(PushTarget.OpenSession("s1"), note("""{"title":"t","body":"b","tag":"t","target":{"sessionId":"s1"}}""").target)
        assertNull(note("""{"title":"t","body":"b","tag":"t","target":{}}""").target)
        // A room wins over anything else said beside it.
        assertEquals(PushTarget.OpenRoom("r"), note("""{"title":"t","body":"b","tag":"t","target":{"roomId":"r","sessionId":"s"}}""").target)
    }

    @Test
    fun aRoomNotifiesOnlyWhenNotMutedNotOnScreenAndWanted() {
        assertTrue(shouldNotifyRoom(muted = false, showing = false, allowed = true))
        assertFalse(shouldNotifyRoom(muted = true, showing = false, allowed = true))
        assertFalse(shouldNotifyRoom(muted = false, showing = true, allowed = true))
        assertFalse(shouldNotifyRoom(muted = false, showing = false, allowed = false))
    }
}
