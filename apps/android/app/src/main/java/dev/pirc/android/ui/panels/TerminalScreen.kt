package dev.pirc.android.ui.panels

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
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
import androidx.compose.runtime.DisposableEffect
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

/** Keys a phone keyboard lacks, as the bytes a terminal expects. */
private val KEYS = listOf(
    "Esc" to "\u001b", "Tab" to "\t", "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C",
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

    fun type(text: String) {
        viewModel.input(if (ctrl) controlKey(text) else text)
        ctrl = false
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
                        }.also { keyboard = it }
                    },
                )
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
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
                            loadUrl("file:///android_asset/terminal/terminal.html")
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
    DisposableEffect(Unit) { onDispose { web?.destroy() } }
}
