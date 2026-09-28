package dev.pirc.android

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.unauthorizedMessage
import dev.pirc.android.core.timeline.get
import dev.pirc.android.core.timeline.number
import dev.pirc.android.core.timeline.string
import dev.pirc.android.core.timeline.text
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min

/** Logcat tag for terminal diagnostics: `adb logcat -s PircTerminal`. Debug logs are stripped from release builds. */
const val TERMINAL_LOG = "PircTerminal"

/** Output is handed to the view at most once a frame. */
private const val FRAME_MS = 16L

/** Ctrl+[text] for a letter or one of @[\]^_ (the C0 control codes); anything else unchanged. */
fun controlKey(text: String): String {
    if (text.length != 1) return text
    val char = text[0].uppercaseChar()
    return if (char in '@'..'_') (char.code and 0x1f).toChar().toString() else text
}

/** What the terminal view should draw next. */
sealed interface TerminalFrame {
    /** Frames are numbered so a view catching up from [TerminalViewModel.snapshot] skips what it holds. */
    val seq: Long

    /** Start over with this text (a (re)connect replays the scrollback). */
    data class Reset(val text: String, override val seq: Long = 0) : TerminalFrame
    data class Write(val text: String, override val seq: Long = 0) : TerminalFrame
}

/**
 * One live terminal on the session's node, like the web's TerminalView: the
 * socket reconnects with backoff and the node replays scrollback, so the view
 * is rebuilt on every (re)connect. Typing and resizing need the control lease.
 */
class TerminalViewModel(
    private val api: PircApi,
    val sessionId: String,
    val terminalId: String,
    private val clientId: String,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    val control = ControlKeeper(viewModelScope, api, sessionId, clientId) { error ->
        if (error is ApiException && error.unauthorized) onUnauthorized(error)
    }

    private val client: OkHttpClient = api.client.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    /** Everything drawn since the last reset, so a recreated view can catch up. */
    private val screen = StringBuilder()
    private val _frames = MutableSharedFlow<TerminalFrame>(extraBufferCapacity = 1024, onBufferOverflow = BufferOverflow.SUSPEND)
    val frames: SharedFlow<TerminalFrame> = _frames

    /** Output not yet handed to the view: `cat` of a big file is thousands of frames, drawn as a few writes. */
    private val pending = StringBuilder()
    private var flushing: Job? = null

    /** A frame could not be buffered: the view must start over from [screen]. */
    private var overflowed = false

    private val _notice = MutableStateFlow<String?>("Connecting…")
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val _exited = MutableStateFlow(false)
    val exited: StateFlow<Boolean> = _exited.asStateFlow()

    private var socket: WebSocket? = null
    private var retry: Job? = null
    private var attempts = 0
    private var visible = false
    private var size = 80 to 24
    private var sentSize = ""

    private var seq = 0L

    /** What a newly attached view starts from, and the last frame it includes. */
    @Synchronized
    fun snapshot(): Pair<String, Long> {
        flush()
        return screen.toString() to seq
    }

    @Synchronized
    internal fun draw(next: TerminalFrame) {
        when (next) {
            is TerminalFrame.Reset -> {
                pending.setLength(0)
                overflowed = false
                screen.setLength(0)
                screen.append(next.text)
                emit(next.copy(seq = ++seq))
            }
            is TerminalFrame.Write -> {
                screen.append(next.text)
                // Keep roughly the node's own scrollback, not the whole session.
                if (screen.length > 512_000) screen.delete(0, screen.length - 256_000)
                pending.append(next.text)
                if (flushing?.isActive != true) flushing = viewModelScope.launch {
                    delay(FRAME_MS)
                    flush()
                }
            }
        }
    }

    /** Hand the output gathered since the last frame to the view, as one write. */
    @Synchronized
    internal fun flush() {
        flushing?.cancel()
        flushing = null
        if (overflowed) {
            overflowed = false
            pending.setLength(0)
            emit(TerminalFrame.Reset(screen.toString(), ++seq))
            return
        }
        if (pending.isEmpty()) return
        val text = pending.toString()
        pending.setLength(0)
        emit(TerminalFrame.Write(text, ++seq))
    }

    private fun emit(frame: TerminalFrame) {
        if (!_frames.tryEmit(frame)) {
            Log.w(TERMINAL_LOG, "view is behind; redrawing from the screen")
            overflowed = true
            if (flushing?.isActive != true) flushing = viewModelScope.launch {
                delay(FRAME_MS)
                flush()
            }
        }
    }

    fun start() {
        visible = true
        control.start()
        if (socket == null && !_exited.value) connect()
    }

    fun stop() {
        visible = false
        control.stop()
        retry?.cancel()
        socket?.close(1000, "hidden")
        socket = null
    }

    private fun connect() {
        retry?.cancel()
        val request = api.terminalRequest(sessionId, terminalId)
        Log.d(TERMINAL_LOG, "connect $terminalId (attempt $attempts)")
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TERMINAL_LOG, "open $terminalId: HTTP ${response.code}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                val message = runCatching { PircJson.parseToJsonElement(text) }.getOrElse { error ->
                    Log.w(TERMINAL_LOG, "unparseable frame (${text.length} chars)", error)
                    return
                }
                if (message["type"].string != "output") Log.d(TERMINAL_LOG, "frame ${message["type"].string} ${text.length} chars")
                when (message["type"].string) {
                    "ready" -> {
                        attempts = 0
                        _notice.value = null
                        sentSize = ""
                        draw(TerminalFrame.Reset(message["replay"].text ?: ""))
                        sendSize()
                    }
                    "output" -> draw(TerminalFrame.Write(message["data"].text ?: ""))
                    "exit" -> {
                        _exited.value = true
                        val code = message["exitCode"].number
                        draw(TerminalFrame.Write("\r\n\u001b[2m[process exited${code?.let { " with code $it" } ?: ""}]\u001b[0m\r\n"))
                    }
                    "error" -> _notice.value = when (message["code"].string) {
                        "lost_control" -> "Take control of the session to type here."
                        else -> message["message"].string ?: "The terminal rejected the input."
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TERMINAL_LOG, "closed $terminalId: $code $reason")
                ended(webSocket, code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TERMINAL_LOG, "failure $terminalId: HTTP ${response?.code}", t)
                ended(webSocket, if (response?.code == 401) 4401 else null)
            }
        })
    }

    private fun ended(webSocket: WebSocket, code: Int?, reason: String? = null) {
        if (webSocket !== socket) return
        socket = null
        when {
            _exited.value || !visible -> Unit
            code == 4401 -> {
                val message = unauthorizedMessage(reason)
                _notice.value = message
                onUnauthorized(ApiException(401, "unauthenticated", message))
            }
            code == 4404 -> {
                _exited.value = true
                _notice.value = "This terminal no longer exists."
            }
            else -> {
                _notice.value = "Reconnecting…"
                retry = viewModelScope.launch {
                    delay(min(10_000L, 500L shl min(attempts++, 5)))
                    if (visible && socket == null) connect()
                }
            }
        }
    }

    private fun send(type: String, block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): Boolean {
        val generation = control.generation ?: run {
            Log.d(TERMINAL_LOG, "send $type dropped: no control lease")
            _notice.value = "Take control of the session to type here."
            return false
        }
        val socket = socket ?: run {
            Log.d(TERMINAL_LOG, "send $type dropped: no socket")
            return false
        }
        val text = PircJson.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            buildJsonObject {
                put("type", type)
                block()
                put("clientId", clientId)
                put("generation", generation)
            },
        )
        val queued = socket.send(text)
        if (!queued || type != "input") Log.d(TERMINAL_LOG, "send $type queued=$queued")
        return queued
    }

    fun input(data: String) {
        if (_exited.value) return
        if (send("input") { put("data", data) } && _notice.value?.startsWith("Take control") == true) _notice.value = null
    }

    fun resize(cols: Int, rows: Int) {
        size = cols to rows
        sendSize()
    }

    private fun sendSize() {
        val (cols, rows) = size
        val key = "${cols}x$rows"
        if (key == sentSize || control.generation == null) return
        if (send("resize") {
                put("cols", cols)
                put("rows", rows)
            }
        ) sentSize = key
    }

    /** Control came back: the pty may have been resized by another client meanwhile. */
    fun controlChanged() {
        sentSize = ""
        sendSize()
    }

    /** End the shell (or drop an exited one from the list). Needs control. */
    fun close(onDone: () -> Unit) {
        val generation = control.generation ?: run {
            _notice.value = "Take control of the session to close this terminal."
            return
        }
        viewModelScope.launch {
            try {
                api.closeTerminal(sessionId, terminalId, clientId, generation)
                onDone()
            } catch (error: java.io.IOException) {
                if (error is ApiException && error.unauthorized) onUnauthorized(error)
                _notice.value = error.message ?: "Could not close the terminal."
            }
        }
    }

    override fun onCleared() {
        stop()
    }
}
