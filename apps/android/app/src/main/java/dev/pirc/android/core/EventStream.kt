package dev.pirc.android.core

import dev.pirc.android.core.timeline.EventEnvelope
import dev.pirc.android.core.timeline.normalizeEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

sealed interface StreamSignal {
    data object Connected : StreamSignal
    data object Reconnecting : StreamSignal
    data class Event(val envelope: EventEnvelope) : StreamSignal
    /** The gateway refused the stream for good; [error] says why (401: pair again). */
    data class Closed(val error: ApiException) : StreamSignal
}

/**
 * `/api/events` over a WebSocket, like the web's `connectEvents`: resumes from
 * the last cursor after a drop, backs off exponentially, and stops for good on
 * the gateway's auth/validation close codes (4401, 4403, 4404, 4400).
 */
class EventStream(
    private val api: PircApi,
    private val backoff: (attempt: Int) -> Long = { attempt ->
        min(20_000L, 750L shl min(attempt, 5)) + Random.nextLong(400)
    },
) {
    private val client = api.client.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    fun open(sessionId: String, startCursor: String?): Flow<StreamSignal> = channelFlow {
        var cursor = startCursor
        var attempt = 0
        while (isActive) {
            val url = (api.pairing.baseUrl + "/api/events").toHttpUrl().newBuilder()
                .addQueryParameter("sessionId", sessionId)
                .apply { cursor?.let { addQueryParameter("cursor", it) } }
                .build()
            val ended = CompletableDeferred<Ended>()
            val socket = client.newWebSocket(
                api.request("").url(url).build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        attempt = 0
                        trySend(StreamSignal.Connected)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val envelope = try {
                            normalizeEvent(PircJson.parseToJsonElement(text))
                        } catch (_: Exception) {
                            webSocket.close(1003, "Invalid event")
                            return
                        }
                        cursor = envelope.cursor
                        trySend(StreamSignal.Event(envelope))
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                        ended.complete(Ended(code, null, reason))
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        ended.complete(Ended(code, null, reason))
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        ended.complete(Ended(null, response?.code, null))
                    }
                },
            )
            val end = try {
                ended.await()
            } finally {
                socket.cancel()
            }
            fatal(end)?.let {
                send(StreamSignal.Closed(it))
                return@channelFlow
            }
            send(StreamSignal.Reconnecting)
            delay(backoff(attempt++))
        }
    }.buffer(Channel.UNLIMITED)

    /** Close [code] (null for a network failure) with its [reason], or the [status] of a refused upgrade. */
    private data class Ended(val code: Int?, val status: Int?, val reason: String?)

    private fun fatal(end: Ended): ApiException? = fatal(end.code, end.status, end.reason)

    internal fun fatal(code: Int?, status: Int?, reason: String? = null): ApiException? = when {
        code == 4401 -> ApiException(401, "unauthenticated", unauthorizedMessage(reason))
        status == 401 -> ApiException(401, "unauthenticated", unauthorizedMessage(null))
        code == 4403 || status == 403 -> ApiException(403, "forbidden", "The gateway refused this session's events.")
        code == 4404 -> ApiException(404, "not_found", "This session no longer exists.")
        code == 4400 -> ApiException(400, "invalid_input", "The gateway rejected the event stream request.")
        else -> null
    }
}
