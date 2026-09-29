package dev.pirc.android.core

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class PushTest {
    private val server = MockWebServer()
    private lateinit var api: PircApi

    @Before
    fun start() {
        server.start()
        api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "b".repeat(43)))
    }

    @After
    fun stop() = server.close()

    private fun note(json: String) = PushNote.parse(json.toByteArray())

    @Test
    fun readsWhatTheGatewayPushes() {
        assertEquals(
            PushNote("CI check failed", "Scheduled run", "session:s1", PushTarget.OpenSession("s1")),
            note("""{"title":"CI check failed","body":"Scheduled run","tag":"session:s1","target":{"sessionId":"s1"},"at":1}"""),
        )
        assertEquals(
            PushTarget.OpenSchedules("s9"),
            note("""{"title":"t","body":"b","tag":"run:r1","target":{"schedules":true,"scheduleId":"s9"}}""")!!.target,
        )
        assertEquals(PushTarget.OpenMemory, note("""{"title":"t","tag":"memory","target":{"memory":true}}""")!!.target)
        // No tag: the title stands in, so it still replaces itself.
        assertEquals("t", note("""{"title":"t"}""")!!.tag)
        // Not the gateway's.
        assertNull(note("""{"body":"no title"}"""))
        assertNull(note("garbage"))
    }

    @Test
    fun registersThisPhoneWithTheGateway() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"publicKey":"BKey","subscriptions":[{"id":"push_1","kind":"unifiedpush","name":"Pixel","host":"ntfy.sh"}]}""").build())
        server.enqueue(MockResponse.Builder().code(201).body("""{"subscription":{"id":"push_2","kind":"unifiedpush","name":"Pixel 9","host":"ntfy.example"}}""").build())
        server.enqueue(MockResponse.Builder().body("""{"delivered":2}""").build())
        server.enqueue(MockResponse.Builder().code(204).build())

        assertEquals("BKey", api.pushInfo().publicKey)
        server.takeRequest()
        assertEquals("push_2", api.subscribePush("https://ntfy.example/up123", "P".repeat(87), "A".repeat(22), "Pixel 9").id)
        val subscribe = server.takeRequest()
        assertEquals("/api/push/subscriptions", subscribe.url.encodedPath)
        assertEquals(
            PircJson.parseToJsonElement(
                """{"endpoint":"https://ntfy.example/up123","keys":{"p256dh":"${"P".repeat(87)}","auth":"${"A".repeat(22)}"},"kind":"unifiedpush","name":"Pixel 9"}""",
            ),
            PircJson.parseToJsonElement(subscribe.body!!.utf8()),
        )
        assertEquals(2, api.testPush())
        server.takeRequest()
        api.unsubscribePush(endpoint = "https://ntfy.example/up123")
        val remove = server.takeRequest()
        assertEquals("DELETE" to """{"endpoint":"https://ntfy.example/up123"}""", remove.method to remove.body!!.utf8())
    }
}
