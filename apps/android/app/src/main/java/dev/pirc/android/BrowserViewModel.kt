package dev.pirc.android

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PircJson
import dev.pirc.android.core.timeline.array
import dev.pirc.android.core.timeline.get
import dev.pirc.android.core.timeline.number
import dev.pirc.android.core.timeline.string
import dev.pirc.android.core.timeline.text
import dev.pirc.android.core.timeline.truthy
import dev.pirc.android.core.unauthorizedMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.math.min

/** Logcat tag for browser diagnostics: `adb logcat -s PircBrowser`. */
const val BROWSER_LOG = "PircBrowser"

/** The session's browser as the node reports it (node/browser.ts `BrowserViewState`). */
data class BrowserView(
    val active: Boolean = false,
    val url: String = "",
    val title: String = "",
    /** `agent` or `user` (taken over). */
    val mode: String = "agent",
    val handoff: String? = null,
    val agentWaiting: Boolean = false,
    val action: String? = null,
    val recording: String? = null,
    val tabs: List<BrowserTab> = emptyList(),
    val viewportWidth: Int = 1280,
    val viewportHeight: Int = 800,
) {
    val userMode get() = mode == "user"
}

data class BrowserTab(val index: Int, val url: String, val title: String, val active: Boolean)

data class BrowserLogEntry(val index: Long, val at: Long, val actor: String, val action: String, val url: String, val image: Boolean) {
    /** The file of a `Saved recording …` entry. */
    val recording: String? get() = RECORDING_LOG.find(action)?.groupValues?.get(1)
}

private val RECORDING_LOG = Regex("""^Saved recording (\.pirc/recordings/\S+\.webm)$""")

/** A JPEG frame of the page, in viewport pixels [width]×[height]. */
class BrowserFrame(val jpeg: ByteArray, val width: Int, val height: Int)

/** What a phone keyboard produced, as a browser key press or text. */
sealed interface BrowserInput {
    data class Key(val key: String) : BrowserInput
    data class Text(val text: String) : BrowserInput
}

/**
 * Map terminal-style keyboard bytes (from the shared keyboard view) to browser
 * input: control keys become Playwright key names, everything else is text.
 */
fun browserInput(data: String): BrowserInput? = when (data) {
    "" -> null
    "\u007f", "\b" -> BrowserInput.Key("Backspace")
    "\r", "\n" -> BrowserInput.Key("Enter")
    "\t" -> BrowserInput.Key("Tab")
    "\u001b" -> BrowserInput.Key("Escape")
    "\u001b[A" -> BrowserInput.Key("ArrowUp")
    "\u001b[B" -> BrowserInput.Key("ArrowDown")
    "\u001b[C" -> BrowserInput.Key("ArrowRight")
    "\u001b[D" -> BrowserInput.Key("ArrowLeft")
    "\u001b[H" -> BrowserInput.Key("Home")
    "\u001b[F" -> BrowserInput.Key("End")
    "\u001b[3~" -> BrowserInput.Key("Delete")
    "\u001b[5~" -> BrowserInput.Key("PageUp")
    "\u001b[6~" -> BrowserInput.Key("PageDown")
    else -> {
        val char = data.singleOrNull()
        when {
            // Ctrl+letter arrives as a C0 control code.
            char != null && char.code in 1..26 -> BrowserInput.Key("Control+${('a' + char.code - 1)}")
            data.startsWith("\u001b") -> null
            else -> BrowserInput.Text(data.replace("\r", "\n"))
        }
    }
}

internal fun parseView(state: JsonElement?): BrowserView = BrowserView(
    active = state["active"].truthy,
    url = state["url"].text ?: "",
    title = state["title"].text ?: "",
    mode = state["mode"].string ?: "agent",
    handoff = state["handoff"].string,
    agentWaiting = state["agentWaiting"].truthy,
    action = state["action"].string,
    recording = state["recording"]["path"].string,
    tabs = state["tabs"].array.orEmpty().map {
        BrowserTab((it["index"].number ?: 0).toInt(), it["url"].text ?: "", it["title"].text ?: "", it["active"].truthy)
    },
    viewportWidth = (state["viewport"]["width"].number ?: 1280).toInt(),
    viewportHeight = (state["viewport"]["height"].number ?: 800).toInt(),
)

internal fun parseLogEntry(entry: JsonElement?) = BrowserLogEntry(
    index = entry["index"].number ?: 0,
    at = entry["at"].number ?: 0,
    actor = entry["actor"].string ?: "agent",
    action = entry["action"].text ?: "",
    url = entry["url"].text ?: "",
    image = entry["image"].truthy,
)

/**
 * The session's browser, like the web's BrowserTab: a live screencast, a
 * takeover mode that forwards taps and typing (for logins and forms), and a
 * log of steps whose screenshots can be stepped through. Connected only while
 * shown; everything but viewing needs the control lease.
 */
class BrowserViewModel(
    private val api: PircApi,
    val sessionId: String,
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

    private val _view = MutableStateFlow<BrowserView?>(null)
    val view: StateFlow<BrowserView?> = _view.asStateFlow()

    private val _frame = MutableStateFlow<BrowserFrame?>(null)
    val frame: StateFlow<BrowserFrame?> = _frame.asStateFlow()

    private val _log = MutableStateFlow<List<BrowserLogEntry>>(emptyList())
    val log: StateFlow<List<BrowserLogEntry>> = _log.asStateFlow()

    /** Replay: a logged step and its screenshot (null while loading or when none was kept). */
    private val _replay = MutableStateFlow<Pair<Long, ByteArray?>?>(null)
    val replay: StateFlow<Pair<Long, ByteArray?>?> = _replay.asStateFlow()

    private val _notice = MutableStateFlow<String?>("Connecting…")
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /** The node has no browser: stop trying. */
    private val _unavailable = MutableStateFlow<String?>(null)
    val unavailable: StateFlow<String?> = _unavailable.asStateFlow()

    private var socket: WebSocket? = null
    private var retry: Job? = null
    private var attempts = 0
    private var visible = false

    fun start() {
        visible = true
        control.start()
        if (socket == null && _unavailable.value == null) connect()
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
        socket = client.newWebSocket(api.browserRequest(sessionId), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                val message = runCatching { PircJson.parseToJsonElement(text) }.getOrElse { return }
                receive(message)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                ended(webSocket, code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(webSocket, code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(BROWSER_LOG, "failure: HTTP ${response?.code}", t)
                ended(webSocket, if (response?.code == 401) 4401 else null)
            }
        })
    }

    internal fun receive(message: JsonElement) {
        when (message["type"].string) {
            "state" -> {
                attempts = 0
                if (_notice.value == "Connecting…" || _notice.value == "Reconnecting…") _notice.value = null
                val next = parseView(message["state"])
                _view.value = next
                if (!next.active) _frame.value = null
            }
            "frame" -> {
                val data = message["data"].string ?: return
                _frame.value = BrowserFrame(
                    Base64.getDecoder().decode(data),
                    (message["width"].number ?: 0).toInt(),
                    (message["height"].number ?: 0).toInt(),
                )
            }
            "log" -> _log.value = message["entries"].array.orEmpty().map(::parseLogEntry)
            "log_entry" -> _log.value = (_log.value + parseLogEntry(message["entry"])).takeLast(150)
            "log_image" -> {
                val index = message["index"].number ?: return
                if (_replay.value?.first == index)
                    _replay.value = index to message["data"].string?.let { Base64.getDecoder().decode(it) }
            }
            "error" -> _notice.value = when (message["code"].string) {
                "lost_control" -> "Take control of the session to use the browser."
                "agent_in_control" -> "Tap “Take over” first."
                else -> message["message"].string ?: "The browser rejected the input."
            }
        }
    }

    private fun ended(webSocket: WebSocket, code: Int?, reason: String? = null) {
        if (webSocket !== socket) return
        socket = null
        when {
            !visible -> Unit
            code == 4401 -> {
                val message = unauthorizedMessage(reason)
                _notice.value = message
                onUnauthorized(ApiException(401, "unauthenticated", message))
            }
            code == 4403 -> _unavailable.value = reason?.ifEmpty { null } ?: "The browser is not available on this node."
            else -> {
                _notice.value = "Reconnecting…"
                retry = viewModelScope.launch {
                    delay(min(10_000L, 500L shl min(attempts++, 5)))
                    if (visible && socket == null) connect()
                }
            }
        }
    }

    /** Send without the lease (viewing only). */
    private fun sendRaw(type: String, block: JsonObjectBuilder.() -> Unit = {}) {
        socket?.send(PircJson.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("type", type)
            block()
            put("clientId", clientId)
        }))
    }

    /** Send an action; it needs the control lease. */
    private fun act(type: String, block: JsonObjectBuilder.() -> Unit = {}): Boolean {
        val generation = control.generation ?: run {
            _notice.value = "Take control of the session to use the browser."
            return false
        }
        val socket = socket ?: return false
        return socket.send(PircJson.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("type", type)
            block()
            put("clientId", clientId)
            put("generation", generation)
        }))
    }

    fun takeOver() = act("takeover")
    fun returnControl() = act("release")
    fun record(start: Boolean) = act("record") { put("action", if (start) "start" else "stop") }
    fun back() = act("back")
    fun forward() = act("forward")
    fun reload() = act("reload")
    fun selectTab(index: Int) = act("tab") { put("index", index) }

    fun navigate(url: String) {
        if (url.isBlank()) return
        if (_view.value?.userMode != true) act("takeover")
        act("navigate") { put("url", url.trim()) }
    }

    /** A tap at viewport coordinates: press and release. */
    fun tap(x: Int, y: Int, clickCount: Int = 1) {
        if (!act("mouse") {
                put("action", "down"); put("x", x); put("y", y); put("button", "left"); put("clickCount", clickCount)
            }) return
        act("mouse") { put("action", "up"); put("x", x); put("y", y); put("button", "left"); put("clickCount", clickCount) }
    }

    fun scroll(x: Int, y: Int, dx: Float, dy: Float) = act("wheel") {
        put("x", x); put("y", y); put("dx", dx); put("dy", dy)
    }

    /** Keyboard bytes from the shared keyboard view. */
    fun type(data: String) {
        when (val input = browserInput(data)) {
            is BrowserInput.Key -> act("key") { put("key", input.key) }
            is BrowserInput.Text -> act("text") { put("text", input.text) }
            null -> Unit
        }
    }

    fun openReplay(entry: BrowserLogEntry) {
        if (!entry.image) return
        _replay.value = entry.index to null
        sendRaw("log_image") { put("index", entry.index) }
    }

    fun step(delta: Int) {
        val current = _replay.value?.first ?: return
        val withImages = _log.value.filter { it.image }
        val at = withImages.indexOfFirst { it.index == current }
        withImages.getOrNull(at + delta)?.let(::openReplay)
    }

    fun closeReplay() {
        _replay.value = null
    }

    fun dismissNotice() {
        _notice.value = null
    }

    override fun onCleared() {
        stop()
    }
}
