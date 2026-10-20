package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.*
import org.junit.Test

class ObservedEventsTest {
    private fun socket(code: Int, vararg messages: String) = MockResponse.Builder().webSocketUpgrade(object: WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            messages.forEach(webSocket::send)
            webSocket.close(code, "done")
        }
    }).build()
    @Test fun changesNeverAdvanceTheSessionCursorAndSurviveReconnect() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(socket(1001,
                """{"type":"memory_changed"}""",
                """{"sessionId":"s","epoch":3,"sequence":7,"type":"pi_event","timestamp":1,"data":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}}""",
                """{"type":"sessions_changed"}""",
                """{"type":"directory_changed"}"""))
            server.enqueue(socket(4401))
            server.start()
            val changes = mutableListOf<String>()
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "c".repeat(43)))
            val signals = withTimeout(5_000) { EventStream(api, onChange = { changes.add(it) }, backoff = { 1 }).open("s", "3:6").toList() }
            assertEquals(listOf("memory_changed", "sessions_changed", "directory_changed"), changes)
            assertEquals(listOf("3:7"), signals.filterIsInstance<StreamSignal.Event>().map { it.envelope.cursor })
            assertEquals(401, (signals.last() as StreamSignal.Closed).error.status)
            val first = server.takeRequest()
            for (name in listOf("memory", "sessions", "directory")) assertEquals("1", first.url.queryParameter(name))
            assertEquals("3:6", first.url.queryParameter("cursor"))
            val second = server.takeRequest()
            assertEquals("3:7", second.url.queryParameter("cursor"))
            assertEquals("1", second.url.queryParameter("memory"))
        }
    }
}
