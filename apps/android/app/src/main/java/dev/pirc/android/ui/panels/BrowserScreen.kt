package dev.pirc.android.ui.panels

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.BrowserLogEntry
import dev.pirc.android.BrowserViewModel
import dev.pirc.android.ui.PircIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** Decode a JPEG off the main thread; the last good image stays until the next is ready. */
@Composable
private fun rememberJpeg(jpeg: ByteArray?): ImageBitmap? {
    val image by produceState<ImageBitmap?>(null, jpeg) {
        if (jpeg == null) {
            value = null
            return@produceState
        }
        withContext(Dispatchers.Default) {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.asImageBitmap()
        }?.let { value = it }
    }
    return image
}

/**
 * The session's browser (plans/browser.md): watch the agent, take over to log
 * in or fill a form (taps, drags that scroll, and the keyboard), record videos,
 * and step through what the agent did.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowserScreen(
    viewModel: BrowserViewModel,
    onOpenRecording: (String) -> Unit,
    onBack: () -> Unit,
) {
    val view by viewModel.view.collectAsStateWithLifecycle()
    val frame by viewModel.frame.collectAsStateWithLifecycle()
    val log by viewModel.log.collectAsStateWithLifecycle()
    val replay by viewModel.replay.collectAsStateWithLifecycle()
    val notice by viewModel.notice.collectAsStateWithLifecycle()
    val unavailable by viewModel.unavailable.collectAsStateWithLifecycle()
    val lease by viewModel.control.lease.collectAsStateWithLifecycle()
    var keyboard by remember { mutableStateOf<TerminalInputView?>(null) }
    var urlDraft by remember { mutableStateOf("") }
    var editingUrl by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    LaunchedEffect(view?.url) { if (!editingUrl) urlDraft = view?.url.orEmpty() }

    val held = lease.heldByCurrentClient
    val userMode = view?.userMode == true
    val canDrive = held && userMode
    val currentFrame by rememberUpdatedState(frame)
    val currentView by rememberUpdatedState(view)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(view?.title?.ifEmpty { null } ?: "Browser", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                actions = {
                    if (!held && !lease.free) TextButton(onClick = viewModel.control::take) { Text("Take control") }
                    if (view?.active == true) TextButton(enabled = held, onClick = { viewModel.record(view?.recording == null) }) {
                        Text(if (view?.recording != null) "Stop rec" else "Record")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))) {
            unavailable?.let {
                Text(it, modifier = Modifier.padding(16.dp), color = colors.error)
                Text(
                    "Install Chromium on the node or set PIRC_BROWSER_EXECUTABLE.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
                return@Column
            }
            // Holds the keyboard for typing into the page (IME text included).
            AndroidView(
                modifier = Modifier.size(1.dp),
                factory = { context -> TerminalInputView(context) { data -> viewModel.type(data) }.also { keyboard = it } },
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val status = when {
                    userMode && view?.agentWaiting == true -> "Agent is waiting for you"
                    userMode -> "You are in control"
                    view?.action != null -> view!!.action!!
                    view?.active == true -> "Agent"
                    else -> "No browser open"
                }
                AssistChip(onClick = {}, label = { Text(status, maxLines = 1, overflow = TextOverflow.Ellipsis) }, modifier = Modifier.weight(1f, fill = false))
                Box(Modifier.weight(1f))
                if (userMode) Button(enabled = held, onClick = { viewModel.returnControl() }) { Text("Return control") }
                else if (view?.active == true) OutlinedButton(enabled = held, onClick = { viewModel.takeOver() }) { Text("Take over") }
            }
            view?.handoff?.let {
                Surface(color = colors.primaryContainer, contentColor = colors.onPrimaryContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                    Text("The agent needs you: $it", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(10.dp))
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(enabled = canDrive, onClick = viewModel::back) { Text("‹") }
                TextButton(enabled = canDrive, onClick = viewModel::forward) { Text("›") }
                TextButton(enabled = canDrive, onClick = viewModel::reload) { Text("↻") }
                OutlinedTextField(
                    value = urlDraft,
                    onValueChange = {
                        editingUrl = true
                        urlDraft = it
                    },
                    singleLine = true,
                    enabled = held,
                    placeholder = { Text("Enter a URL") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = {
                        editingUrl = false
                        viewModel.navigate(urlDraft)
                    }),
                    textStyle = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f).padding(end = 8.dp),
                )
            }
            if ((view?.tabs?.size ?: 0) > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp)) {
                for (tab in view!!.tabs) FilterChip(
                    selected = tab.active,
                    enabled = canDrive,
                    onClick = { viewModel.selectTab(tab.index) },
                    label = { Text(tab.title.ifEmpty { tab.url }.take(30), maxLines = 1) },
                    modifier = Modifier.padding(end = 4.dp),
                )
            }
            notice?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp).clickable { viewModel.dismissNotice() },
                )
            }

            val replaying = replay
            val shown = rememberJpeg(if (replaying != null) replaying.second else frame?.jpeg)
            val ratio = (frame?.width ?: view?.viewportWidth ?: 1280).toFloat() / (frame?.height ?: view?.viewportHeight ?: 800).coerceAtLeast(1)
            if (replaying != null) {
                val entry = log.find { it.index == replaying.first }
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { viewModel.step(-1) }) { Text("Prev") }
                    Text(
                        entry?.let { "${time(it.at)} · ${it.action}" }.orEmpty(),
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { viewModel.step(1) }) { Text("Next") }
                    TextButton(onClick = viewModel::closeReplay) { Text("Live") }
                }
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).aspectRatio(ratio)) {
                when {
                    shown != null -> {
                        var size by remember { mutableStateOf(IntSize.Zero) }
                        fun map(offset: Offset): Pair<Int, Int> {
                            val width = currentFrame?.width ?: currentView?.viewportWidth ?: 1280
                            val height = currentFrame?.height ?: currentView?.viewportHeight ?: 800
                            return (offset.x / size.width.coerceAtLeast(1) * width).toInt() to
                                (offset.y / size.height.coerceAtLeast(1) * height).toInt()
                        }
                        val gestures = if (canDrive && replaying == null) Modifier
                            .pointerInput(Unit) {
                                size = this.size
                                detectTapGestures(
                                    onTap = { offset ->
                                        val (x, y) = map(offset)
                                        viewModel.tap(x, y)
                                        keyboard?.showKeyboard()
                                    },
                                    onDoubleTap = { offset ->
                                        val (x, y) = map(offset)
                                        viewModel.tap(x, y, 2)
                                    },
                                )
                            }
                            .pointerInput(Unit) {
                                size = this.size
                                // Dragging scrolls the page, like a finger on a phone browser.
                                detectDragGestures { change, drag ->
                                    change.consume()
                                    val (x, y) = map(change.position)
                                    val scale = (currentFrame?.width ?: 1280).toFloat() / this.size.width.coerceAtLeast(1)
                                    viewModel.scroll(x, y, -drag.x * scale, -drag.y * scale)
                                }
                            }
                        else Modifier
                        Image(
                            bitmap = shown,
                            contentDescription = view?.title?.let { "Browser: $it" } ?: "Browser",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier
                                .fillMaxSize()
                                .then(if (canDrive) Modifier.border(2.dp, colors.primary) else Modifier.border(1.dp, colors.outlineVariant))
                                .then(gestures),
                        )
                    }
                    view?.active == true || replaying != null ->
                        Text("Loading…", modifier = Modifier.align(Alignment.Center), color = colors.onSurfaceVariant)
                    else -> Text(
                        "The agent opens a browser when it uses web tools. Watch it here, take over to log in or fill forms, and record videos.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.onSurfaceVariant,
                        modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    )
                }
            }
            if (canDrive) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp)) {
                TextButton(onClick = { keyboard?.showKeyboard() }) { Text("Keyboard") }
                for ((label, key) in listOf("Esc" to "\u001b", "Tab" to "\t", "⏎" to "\r", "↑" to "\u001b[A", "↓" to "\u001b[B", "PgUp" to "\u001b[5~", "PgDn" to "\u001b[6~"))
                    TextButton(onClick = { viewModel.type(key) }) { Text(label) }
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                val recordings = log.mapNotNull { it.recording }
                if (recordings.isNotEmpty()) {
                    item { SectionLabel("Recordings") }
                    items(recordings, key = { "rec:$it" }) { path ->
                        ListItem(
                            modifier = Modifier.clickable { onOpenRecording(path) },
                            headlineContent = { Text(path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingContent = { Text("Play", color = colors.primary) },
                        )
                    }
                }
                item { SectionLabel("Activity") }
                if (log.isEmpty()) item { Text("Nothing yet.", modifier = Modifier.padding(horizontal = 16.dp), color = colors.onSurfaceVariant) }
                items(log.asReversed(), key = { it.index }) { entry -> LogRow(entry, selected = replay?.first == entry.index) { viewModel.openReplay(entry) } }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun LogRow(entry: BrowserLogEntry, selected: Boolean, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    ListItem(
        modifier = Modifier
            .then(if (entry.image) Modifier.clickable(onClick = onOpen) else Modifier)
            .semantics { if (entry.image) contentDescription = "Show this step: ${entry.action}" },
        colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = if (selected) colors.surfaceContainerHigh else colors.surface),
        overlineContent = { Text("${time(entry.at)} · ${entry.actor}") },
        headlineContent = { Text(entry.action, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium) },
    )
}

private fun time(at: Long): String = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(at))
