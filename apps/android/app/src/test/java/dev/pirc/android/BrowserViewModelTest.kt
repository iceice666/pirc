package dev.pirc.android

import dev.pirc.android.core.PircJson
import dev.pirc.android.core.timeline.toolResultFields
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections

/** The browser socket against a real WebSocket server, plus the pure helpers. */
@OptIn(ExperimentalCoroutinesApi::class)
class BrowserViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val server = MockWebServer()
    private val received: MutableList<String> = Collections.synchronizedList(mutableListOf())

    @Before
    fun start() {
        Dispatchers.setMain(dispatcher)
        server.start()
    }

    @After
    fun stop() {
        Dispatchers.resetMain()
        server.close()
    }

    private fun socket(code: Int?, vararg messages: String) = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            messages.forEach(webSocket::send)
            if (code != null) webSocket.close(code, "Browser disabled")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received += text
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = Unit
    }).build()

    private fun eventually(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            dispatcher.scheduler.runCurrent()
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    private fun viewModel() = BrowserViewModel(FakeApi(server.url("/").toString().trimEnd('/')), SESSION, ME) {}

    private val state = """{"type":"state","state":{"active":true,"url":"https://example.com/","title":"Example","mode":"user","handoff":"請登入","agentWaiting":true,"action":null,"recording":{"path":".pirc/recordings/r.webm","startedAt":1},"tabs":[{"index":0,"url":"https://example.com/","title":"Example","active":true}],"viewport":{"width":800,"height":600}}}"""

    @Test
    fun showsTheStreamAndSendsActionsWithTheLease() {
        server.enqueue(
            socket(
                null,
                state,
                """{"type":"frame","data":"AQID","width":800,"height":600}""",
                """{"type":"log","entries":[{"index":4,"at":10,"actor":"agent","action":"Saved recording .pirc/recordings/r.webm","url":"","image":true}]}""",
            ),
        )
        val model = viewModel()
        model.start()
        eventually("frame") { model.frame.value != null && model.log.value.isNotEmpty() }
        val view = model.view.value!!
        assertTrue(view.userMode)
        assertEquals("請登入", view.handoff)
        assertEquals(".pirc/recordings/r.webm", view.recording)
        assertEquals(800, view.viewportWidth)
        assertArrayEquals(byteArrayOf(1, 2, 3), model.frame.value!!.jpeg)
        assertEquals(".pirc/recordings/r.webm", model.log.value.single().recording)

        // FakeApi's lease is held with generation 7 once the keeper has synced.
        eventually("control") { model.control.generation == 7L }
        model.tap(10, 20)
        model.type("你好")
        model.type("\u007f")
        model.returnControl()
        eventually("messages") { received.size >= 5 }
        val sent = received.map { PircJson.parseToJsonElement(it).toString() }
        assertTrue(sent[0], sent[0].contains("\"action\":\"down\"") && sent[0].contains("\"x\":10") && sent[0].contains("\"generation\":7"))
        assertTrue(sent[1].contains("\"action\":\"up\""))
        assertTrue(sent[2], sent[2].contains("\"type\":\"text\"") && sent[2].contains("你好"))
        assertTrue(sent[3].contains("\"key\":\"Backspace\""))
        assertTrue(sent[4].contains("\"type\":\"release\""))

        // Replaying a step asks for its screenshot without needing the lease.
        model.openReplay(model.log.value.single())
        eventually("log_image") { received.size >= 6 }
        assertTrue(received[5].contains("\"log_image\"") && !received[5].contains("generation"))
        model.stop()
    }

    @Test
    fun aNodeWithoutABrowserStopsReconnecting() {
        server.enqueue(socket(4403))
        val model = viewModel()
        model.start()
        eventually("unavailable") { model.unavailable.value != null }
        assertEquals("Browser disabled", model.unavailable.value)
        model.stop()
    }

    @Test
    fun mapsKeyboardBytesToBrowserKeys() {
        assertEquals(BrowserInput.Key("Enter"), browserInput("\r"))
        assertEquals(BrowserInput.Key("Backspace"), browserInput("\u007f"))
        assertEquals(BrowserInput.Key("ArrowLeft"), browserInput("\u001b[D"))
        assertEquals(BrowserInput.Key("PageDown"), browserInput("\u001b[6~"))
        assertEquals(BrowserInput.Key("Control+a"), browserInput("\u0001"))
        assertEquals(BrowserInput.Text("é"), browserInput("é"))
        assertEquals(BrowserInput.Text("a\nb"), browserInput("a\rb"))
        assertNull(browserInput("\u001b[99~"))
        assertNull(browserInput(""))
    }

    @Test
    fun toolResultsCarryASavedRecording() {
        fun fields(details: String) = toolResultFields(PircJson.parseToJsonElement("""{"content":[],"details":$details}"""), "t")
        assertEquals(".pirc/recordings/demo.webm", fields("""{"recording":false,"path":".pirc/recordings/demo.webm"}""").recording)
        assertNull(fields("""{"recording":true,"path":".pirc/recordings/demo.webm"}""").recording)
        assertNull(fields("""{"recording":false,"path":"../x.webm"}""").recording)
    }
}
