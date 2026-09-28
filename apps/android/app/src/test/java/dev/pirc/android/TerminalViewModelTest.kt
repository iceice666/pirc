package dev.pirc.android

import dev.pirc.android.core.ApiException
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The terminal socket against a real WebSocket server; retries run on a test Main dispatcher. */
@OptIn(ExperimentalCoroutinesApi::class)
class TerminalViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val server = MockWebServer()
    private val unauthorized = mutableListOf<ApiException>()

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

    private fun viewModel() = TerminalViewModel(FakeApi(server.url("/").toString().trimEnd('/')), SESSION, "t1", ME) { unauthorized += it }

    /** A socket that sends [messages] and then closes with [code]. */
    private fun socket(code: Int?, reason: String = "", vararg messages: String) = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            messages.forEach(webSocket::send)
            if (code != null) webSocket.close(code, reason)
        }

        // The app hangs up on stop(): answer, so the server can shut down.
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

    @Test
    fun drawsTheReplayAndBatchesOutput() {
        server.enqueue(socket(null, "", """{"type":"ready","replay":"$ "}""", """{"type":"output","data":"l"}""", """{"type":"output","data":"s\r\n"}"""))
        val model = viewModel()
        model.start()
        eventually("output") { model.snapshot().first == "$ ls\r\n" }
        assertEquals(null, model.notice.value)
        model.stop()
    }

    @Test
    fun aGoneTerminalStopsReconnecting() {
        server.enqueue(socket(4404))
        val model = viewModel()
        model.start()
        eventually("exit") { model.exited.value }
        assertEquals("This terminal no longer exists.", model.notice.value)
        assertEquals(1, server.requestCount)
        model.stop()
    }

    @Test
    fun aDeadTokenUnpairsWithTheGatewaysReason() {
        server.enqueue(socket(4401, "device token revoked or expired"))
        val model = viewModel()
        model.start()
        eventually("unauthorized") { unauthorized.isNotEmpty() }
        assertEquals("Device token revoked or expired. Pair this phone again.", unauthorized.single().message)
        assertEquals(1, server.requestCount)
        model.stop()
    }

    @Test
    fun aDroppedSocketReconnects() {
        server.enqueue(socket(1011, "node restarting"))
        server.enqueue(socket(null, "", """{"type":"ready","replay":"back"}"""))
        val model = viewModel()
        model.start()
        eventually("retry scheduled") { model.notice.value == "Reconnecting…" }
        dispatcher.scheduler.advanceTimeBy(1_000)
        eventually("second connection") { model.snapshot().first == "back" }
        assertEquals(2, server.requestCount)
        assertTrue(!model.exited.value)
        model.stop()
    }
}
