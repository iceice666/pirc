package dev.pirc.android.core

import dev.pirc.android.core.timeline.TimelineEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class EventStreamTest {
    private val server = MockWebServer()
    private val token = "pirc_dev_" + "c".repeat(43)
    private lateinit var stream: EventStream

    @Before
    fun start() {
        server.start()
        stream = EventStream(PircApi(Pairing(server.url("/").toString().trimEnd('/'), token))) { 10 }
    }

    @After
    fun stop() = server.close()

    /** A gateway socket that sends [messages] and then closes with [code]. */
    private fun socket(code: Int, vararg messages: String) = MockResponse.Builder().webSocketUpgrade(
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                messages.forEach(webSocket::send)
                webSocket.close(code, "bye")
            }
        },
    ).build()

    private fun event(sequence: Int) =
        """{"sessionId":"s1","epoch":3,"sequence":$sequence,"type":"pi_event","timestamp":1,"data":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x$sequence"}}}"""

    @Test
    fun resumesFromTheLastCursorAfterADrop() = runBlocking {
        server.enqueue(socket(1001, event(7), event(8)))
        server.enqueue(socket(4401))
        val signals = withTimeout(5_000) { stream.open("s 1", "3:6").toList() }

        val events = signals.filterIsInstance<StreamSignal.Event>().map { it.envelope }
        assertEquals(listOf("3:7", "3:8"), events.map { it.cursor })
        assertEquals(TimelineEvent.MessageDelta("x7", thinking = false), events.first().event)
        assertTrue(signals.contains(StreamSignal.Reconnecting))
        assertEquals(401, (signals.last() as StreamSignal.Closed).error.status)

        val first = server.takeRequest()
        assertEquals("Bearer $token", first.headers["Authorization"])
        assertEquals("s 1", first.url.queryParameter("sessionId"))
        assertEquals("3:6", first.url.queryParameter("cursor"))
        assertEquals("3:8", server.takeRequest().url.queryParameter("cursor"))
    }

    @Test
    fun stopsOnAMissingSession() = runBlocking {
        server.enqueue(socket(4404))
        val closed = withTimeout(5_000) { stream.open("gone", null).first { it is StreamSignal.Closed } }
        assertEquals(404, (closed as StreamSignal.Closed).error.status)
        assertEquals(null, server.takeRequest().url.queryParameter("cursor"))
    }

    @Test
    fun treatsARefusedUpgradeAsUnauthorized() = runBlocking {
        server.enqueue(MockResponse.Builder().code(401).build())
        val signals = withTimeout(5_000) { stream.open("s1", null).take(1).toList() }
        assertEquals(401, (signals.single() as StreamSignal.Closed).error.status)
    }
}
