package dev.pirc.android.ui.panels

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.BuildConfig
import dev.pirc.android.TERMINAL_LOG
import dev.pirc.android.TerminalFrame
import dev.pirc.android.TerminalViewModel
import dev.pirc.android.controlKey
import dev.pirc.android.ui.PircIcons
import androidx.compose.runtime.mutableFloatStateOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.onSubscription
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MIN_FONT = 7f
private const val MAX_FONT = 28f

private fun Color.css() = String.format("#%06X", toArgb() and 0xFFFFFF)

/**
 * The bundled page is served from this https origin instead of `file://`, as
 * WebViewAssetLoader does: only files under [PAGE_DIR] of the app's assets.
 */
private const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
private const val PAGE_DIR = "terminal/"
private const val PAGE_URL = "$ASSET_ORIGIN/assets/${PAGE_DIR}terminal.html"

private val MIME_TYPES = mapOf("html" to "text/html", "js" to "text/javascript", "css" to "text/css", "txt" to "text/plain")

/** A bundled page asset for [request]; an empty 404 for anything else, so nothing reaches the network. */
private fun WebView.asset(request: WebResourceRequest): WebResourceResponse? {
    val url = request.url
    if (url.scheme != "https" || url.host != "appassets.androidplatform.net") return notFound()
    val path = url.path?.removePrefix("/assets/")?.takeIf { it.startsWith(PAGE_DIR) && ".." !in it } ?: return notFound()
    val type = MIME_TYPES[path.substringAfterLast('.')] ?: return notFound()
    return runCatching { WebResourceResponse(type, "utf-8", context.assets.open(path)) }.getOrElse { notFound() }
}

private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))

/** Keys a phone keyboard lacks, as the bytes a terminal expects. */
private val KEYS = listOf(
    "Esc" to "\u001b", "Tab" to "\t", "⏎" to "\r", "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C",
    "|" to "|", "~" to "~", "/" to "/", "-" to "-", "Home" to "\u001b[H", "End" to "\u001b[F",
)


/**
 * A terminal of the session's node: xterm.js in a WebView (local assets only),
 * with the socket kept by [viewModel], plus a row of keys phones lack.
 */
@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    viewModel: TerminalViewModel,
    title: String,
    initialFontSize: Float,
    onFontSize: (Float) -> Unit,
    onClose: () -> Unit,
    onBack: () -> Unit,
) {
    val notice by viewModel.notice.collectAsStateWithLifecycle()
    val exited by viewModel.exited.collectAsStateWithLifecycle()
    val lease by viewModel.control.lease.collectAsStateWithLifecycle()
    var ctrl by remember { mutableStateOf(false) }
    var fontSize by rememberSaveable { mutableFloatStateOf(initialFontSize) }
    var menu by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<TerminalWebView?>(null) }
    var keyboard by remember { mutableStateOf<TerminalInputView?>(null) }
    val colors = MaterialTheme.colorScheme
    val currentCtrl by rememberUpdatedState(ctrl)

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    LaunchedEffect(lease.heldByCurrentClient) { if (lease.heldByCurrentClient) viewModel.controlChanged() }

    val pageSettings = remember(colors, fontSize) {
        buildJsonObject {
            put("debug", BuildConfig.DEBUG)
            put("fontSize", (fontSize * 4).roundToInt() / 4f)
            put("theme", buildJsonObject {
                put("background", colors.surface.css())
                put("foreground", colors.onSurface.css())
                put("cursor", colors.primary.css())
                put("selectionBackground", colors.primary.copy(alpha = 0.3f).css())
            })
        }.toString()
    }
    val currentSettings by rememberUpdatedState(pageSettings)

    // Typing reads as "show me the prompt": xterm only scrolls down by itself
    // for keys it handles, and ours never reach it.
    fun type(text: String) {
        viewModel.input(if (ctrl) controlKey(text) else text)
        ctrl = false
        web?.evaluateJavascript("pirc.scrollToBottom()", null)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                actions = {
                    if (!lease.heldByCurrentClient && !lease.free) TextButton(onClick = viewModel.control::take) { Text("Take control") }
                    TextButton(onClick = { menu = true }) { Text("More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Show keyboard") }, onClick = {
                            menu = false
                            keyboard?.showKeyboard()
                        })
                        DropdownMenuItem(text = { Text(if (exited) "Remove" else "Close terminal") }, onClick = {
                            menu = false
                            onClose()
                        })
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))) {
            notice?.let {
                Surface(color = colors.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                // Holds the keyboard; the WebView itself never takes focus.
                AndroidView(
                    modifier = Modifier.size(1.dp),
                    factory = { context ->
                        TerminalInputView(context) { data ->
                            viewModel.input(if (currentCtrl) controlKey(data) else data)
                            if (currentCtrl) ctrl = false
                            web?.evaluateJavascript("pirc.scrollToBottom()", null)
                        }.also { keyboard = it }
                    },
                )
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    // Released even if the page never became ready (a JS error, leaving early).
                    onRelease = { it.destroy() },
                    factory = { context ->
                        TerminalWebView(
                            context,
                            onTap = {
                                keyboard?.showKeyboard()
                                web?.evaluateJavascript("pirc.focus()", null)
                            },
                            // Pinch to zoom, like tmux clients: the pty is resized to the new grid.
                            onScale = { factor -> fontSize = (fontSize * factor).coerceIn(MIN_FONT, MAX_FONT) },
                        ).apply {
                            settings.javaScriptEnabled = true
                            // Bundled assets load regardless; nothing else on disk is reachable.
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            setBackgroundColor(colors.surface.toArgb())
                            webViewClient = object : WebViewClient() {
                                // Only the bundled page: never navigate anywhere else.
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                                // Every request is answered locally; nothing reaches the network.
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = view.asset(request)
                            }
                            if (BuildConfig.DEBUG) {
                                // The page is inspectable from chrome://inspect over adb.
                                WebView.setWebContentsDebuggingEnabled(true)
                                webChromeClient = object : WebChromeClient() {
                                    // The page's console (xterm state, JS errors) next to the socket log.
                                    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                                        Log.d(TERMINAL_LOG, "page: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                                        return true
                                    }
                                }
                            }
                            addJavascriptInterface(
                                object {
                                    @JavascriptInterface fun settings(): String = currentSettings

                                    // The terminal's own replies to queries (keys go through TerminalInputView).
                                    @JavascriptInterface fun input(data: String) {
                                        post {
                                            viewModel.input(if (currentCtrl) controlKey(data) else data)
                                            if (currentCtrl) ctrl = false
                                        }
                                    }

                                    @JavascriptInterface fun resize(cols: Int, rows: Int) = viewModel.resize(cols, rows)

                                    @JavascriptInterface fun ready() {
                                        post {
                                            web = this@apply
                                            // Ready to type, as in a terminal app.
                                            keyboard?.showKeyboard()
                                            evaluateJavascript("pirc.focus()", null)
                                        }
                                    }
                                },
                                "Pirc",
                            )
                            loadUrl(PAGE_URL)
                        }
                    },
                )
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
            ) {
                FilterChip(selected = ctrl, onClick = { ctrl = !ctrl }, label = { Text("Ctrl") }, modifier = Modifier.padding(horizontal = 2.dp))
                for ((label, bytes) in KEYS) TextButton(onClick = { type(bytes) }) { Text(label) }
            }
        }
    }

    // Draw what the socket delivers. A new view first catches up from the
    // snapshot, taken once subscribed, and skips the frames it already holds.
    val view = web
    LaunchedEffect(view) {
        if (view == null) return@LaunchedEffect
        var shown = Long.MAX_VALUE
        viewModel.frames.onSubscription {
            val (text, seq) = viewModel.snapshot()
            shown = seq
            view.evaluateJavascript("pirc.reset(${JsonPrimitive(text)})", null)
        }.collect { frame ->
            if (frame.seq <= shown) return@collect
            val script = when (frame) {
                is TerminalFrame.Reset -> "pirc.reset(${JsonPrimitive(frame.text)})"
                is TerminalFrame.Write -> "pirc.write(${JsonPrimitive(frame.text)})"
            }
            view.evaluateJavascript(script, null)
        }
    }
    // Steps of a quarter point: a pinch sends a stream of tiny factors.
    val shownFont = (fontSize * 4).roundToInt() / 4f
    LaunchedEffect(view, shownFont) { view?.evaluateJavascript("pirc.fontSize($shownFont)", null) }
    LaunchedEffect(shownFont) {
        delay(500)
        onFontSize(shownFont)
    }
    LaunchedEffect(view, colors) {
        view?.evaluateJavascript("pirc.theme(${org.json.JSONObject(pageSettings).getJSONObject("theme")})", null)
    }
}
