package dev.pirc.android.core.rooms

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.unauthorizedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

/** A connection open this long counts as stable: the next drop starts the backoff over. */
private const val STABLE_NANOS = 10_000_000_000L

sealed interface RoomSignal {
    data object Connected : RoomSignal
    data object Reconnecting : RoomSignal

    /**
     * The stream stands at its watermark: where faces think now and what each
     * face does (presence is not replayed). Comes after any replayed events.
     */
    data class Ready(val presence: List<JsonObject>, val faces: List<JsonObject>?) : RoomSignal

    /** The cursor expired or the gateway restarted: reload what is shown. */
    data object Reset : RoomSignal

    /** One room event (`room_*`, `thread_*`, `face_*`, presence, loops, wakes). */
    data class Event(val event: JsonObject) : RoomSignal

    /** The gateway refused the stream for good; [error] says why (401: pair again). */
    data class Closed(val error: ApiException) : RoomSignal
}

/** The event types the rooms' stream carries. */
fun isRoomEvent(type: String?): Boolean = type != null && (
    type.startsWith("room_") || type.startsWith("thread_") || type.startsWith("face_") ||
        type == "brain_presence" || type == "loop_changed" || type == "wake_changed"
    )

/** `epoch:sequence` of a frame's watermark (`ready`, `reset`). */
internal fun watermarkCursor(frame: JsonObject): String? {
    val watermark = frame["watermark"] as? JsonObject ?: return null
    val epoch = watermark["epoch"].long ?: return null
    val sequence = watermark["sequence"].long ?: return null
    return "$epoch:$sequence"
}

/**
 * What one text frame of the rooms' stream means, and the cursor after it:
 * the parsing half of [RoomStream], kept apart so it can be tested without a
 * socket. Null for frames this client does not follow.
 */
internal fun roomFrame(text: String, cursor: String?): Pair<RoomSignal, String?>? {
    val frame = PircJson.parseToJsonElement(text) as? JsonObject
        ?: throw IllegalArgumentException("not an object")
    val type = frame["type"].str
    return when {
        type == "ready" -> RoomSignal.Ready(
            presence = (frame["presence"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>(),
            faces = (frame["faces"] as? JsonArray)?.filterIsInstance<JsonObject>(),
        ) to (watermarkCursor(frame) ?: cursor)
        type == "reset" -> RoomSignal.Reset to (watermarkCursor(frame) ?: cursor)
        isRoomEvent(type) -> {
            val sequence = frame["sequence"].long ?: 0
            // Sequence 0 is ephemeral (typing, presence): never a resume point.
            val next = if (sequence > 0) frame["epoch"].long?.let { "$it:$sequence" } ?: cursor else cursor
            RoomSignal.Event(frame) to next
        }
        else -> null
    }
}

/**
 * `/api/events?rooms=1` over a WebSocket, like the web's `connectRooms`:
 * resumes from the cursor of the last numbered event after a drop, backs off
 * exponentially, and stops for good on the gateway's auth/validation close
 * codes (4401, 4403, 4400).
 */
class RoomStream(
    private val api: PircApi,
    /** Cuts a backoff short (the network came back); see [Connectivity]. */
    private val wake: Flow<Unit> = Connectivity.regained,
    private val backoff: (attempt: Int) -> Long = { attempt ->
        min(20_000L, 750L shl min(attempt, 5)) + Random.nextLong(400)
    },
) {
    private val client = api.client.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    fun open(startCursor: String? = null): Flow<RoomSignal> = channelFlow {
        var cursor = startCursor
        var attempt = 0
        while (isActive) {
            val url = (api.pairing.baseUrl + "/api/events").toHttpUrl().newBuilder()
                .addQueryParameter("rooms", "1")
                .apply { cursor?.let { addQueryParameter("cursor", it) } }
                .build()
            val ended = CompletableDeferred<Ended>()
            var openedAt = 0L
            var delivered = false
            val socket = client.newWebSocket(
                api.request("").url(url).build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        openedAt = System.nanoTime()
                        trySend(RoomSignal.Connected)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (!isActive) return
                        val parsed = try {
                            roomFrame(text, cursor)
                        } catch (_: Exception) {
                            webSocket.close(1003, "Invalid event")
                            return
                        } ?: return
                        cursor = parsed.second
                        if (parsed.first is RoomSignal.Event) delivered = true
                        trySend(parsed.first)
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
            roomStreamFatal(end.code, end.status, end.reason)?.let {
                send(RoomSignal.Closed(it))
                return@channelFlow
            }
            if (delivered || (openedAt != 0L && System.nanoTime() - openedAt >= STABLE_NANOS)) attempt = 0
            send(RoomSignal.Reconnecting)
            // Back online: try at once, with the backoff started over.
            if (withTimeoutOrNull(backoff(attempt++)) { wake.first() } != null) attempt = 0
        }
    }.buffer(Channel.UNLIMITED)

    /** Close [code] (null for a network failure) with its [reason], or the [status] of a refused upgrade. */
    private data class Ended(val code: Int?, val status: Int?, val reason: String?)
}

/** A close that retrying cannot fix, as the error to show; null to reconnect. */
internal fun roomStreamFatal(code: Int?, status: Int?, reason: String? = null): ApiException? = when {
    code == 4401 -> ApiException(401, "unauthenticated", unauthorizedMessage(reason))
    status == 401 -> ApiException(401, "unauthenticated", unauthorizedMessage(null))
    code == 4403 || status == 403 -> ApiException(403, "forbidden", "The gateway refused the rooms' events.")
    code == 4400 -> ApiException(400, "invalid_input", "The gateway rejected the rooms' event stream request.")
    else -> null
}
