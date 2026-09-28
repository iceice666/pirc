package dev.pirc.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Connection
import dev.pirc.android.SessionViewModel
import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.QueueItem
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.ui.session.Composer
import dev.pirc.android.PanelTab
import dev.pirc.android.core.Session
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import dev.pirc.android.ui.session.InteractionCard
import dev.pirc.android.ui.session.LocalFileOpener
import dev.pirc.android.ui.session.MessageView
import dev.pirc.android.core.FileTarget
import dev.pirc.android.core.parseFileLink
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/** A session: its live timeline, and the composer riding on the keyboard. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    viewModel: SessionViewModel,
    fallbackName: String,
    onBack: () -> Unit,
    onOpenPanels: (title: String, tab: PanelTab) -> Unit,
    onOpenFile: (FileTarget) -> Unit,
    onChanged: (Session) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    // File links in messages open the viewer; anything else goes to the browser.
    val browser = LocalUriHandler.current
    val links = remember(browser, onOpenFile) {
        object : UriHandler {
            override fun openUri(uri: String) {
                parseFileLink(uri)?.let(onOpenFile) ?: browser.openUri(uri)
            }
        }
    }

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    // A rename from another device arrives as an event: keep the list in step.
    LaunchedEffect(viewModel) {
        snapshotFlow { state?.session }.filterNotNull().distinctUntilChanged().drop(1).collect { onChanged(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    // Derived, so streamed text does not recompose the bar.
                    val name by remember { derivedStateOf { state?.session?.name } }
                    val runStatus by remember { derivedStateOf { state?.run?.status } }
                    Column {
                        Text(name ?: fallbackName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            subtitle(runStatus, connection),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                actions = {
                    val session by remember { derivedStateOf { state?.session } }
                    val title = session?.name ?: fallbackName
                    TextButton(onClick = { onOpenPanels(title, PanelTab.Files) }) { Text("Files") }
                    TextButton(onClick = { menu = true }) { Text("More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        for (tab in listOf(PanelTab.Git, PanelTab.Tasks, PanelTab.Memory, PanelTab.Terminal))
                            DropdownMenuItem(text = { Text(tab.label) }, onClick = {
                                menu = false
                                onOpenPanels(title, tab)
                            })
                        HorizontalDivider()
                        val current = session
                        if (current != null) {
                            DropdownMenuItem(text = { Text("Rename") }, onClick = {
                                menu = false
                                renaming = true
                            })
                            DropdownMenuItem(text = { Text(if (current.pinned) "Unpin" else "Pin to the top") }, onClick = {
                                menu = false
                                viewModel.updateSession(pinned = !current.pinned, onChanged = onChanged)
                            })
                            DropdownMenuItem(text = { Text(if (current.settled) "Reopen" else "Mark as settled") }, onClick = {
                                menu = false
                                viewModel.updateSession(settled = !current.settled, onChanged = onChanged)
                            })
                        }
                    }
                },
            )
        },
        bottomBar = {
            // The larger of keyboard and navigation bar, not both stacked.
            val loaded by remember { derivedStateOf { state != null } }
            if (loaded) Composer(viewModel, Modifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)))
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val current = state
            when {
                current != null -> CompositionLocalProvider(LocalUriHandler provides links, LocalFileOpener provides onOpenFile) {
                    Timeline(current, viewModel)
                }
                error != null -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = viewModel::reload) { Text("Retry") }
                }
                else -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            }
            if (current != null && error != null) Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth(),
            ) {
                Text(error!!, modifier = Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer)
            }
        }
    }
    if (renaming) state?.session?.let { session ->
        RenameDialog(
            name = session.name,
            onRename = {
                renaming = false
                viewModel.updateSession(name = it, onChanged = onChanged)
            },
            onDismiss = { renaming = false },
        )
    }
}

private fun subtitle(runStatus: String?, connection: Connection): String {
    val run = when (runStatus) {
        "queued", "running" -> "Running"
        "waiting_input" -> "Needs your input"
        "stopping" -> "Stopping"
        "failed" -> "Last run failed"
        else -> null
    }
    val link = when (connection) {
        Connection.Connecting -> "Connecting…"
        Connection.Reconnecting -> "Reconnecting…"
        Connection.Stopped -> "Offline"
        Connection.Live -> null
    }
    return listOfNotNull(run, link).joinToString(" · ").ifEmpty { "Live" }
}

/** Keys must be unique; replays can deliver an entry twice. */
private fun keys(messages: List<Message>): List<String> {
    val seen = HashMap<String, Int>()
    return messages.map { message ->
        val count = seen.merge(message.id, 1, Int::plus)!!
        if (count == 1) message.id else "${message.id}#$count"
    }
}

/**
 * Newest at the bottom, anchored there (a reversed list) so streaming text
 * grows upward. While the reader is at the bottom, new entries follow; once
 * they scroll up, a button brings them back.
 */
@Composable
private fun Timeline(state: SessionState, viewModel: SessionViewModel) {
    val control by viewModel.control.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    // Commands need the lease and the stream; taps while reconnecting would only fail.
    val canCommand = control.heldByCurrentClient && connection == Connection.Live
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val messages = state.messages.asReversed()
    val messageKeys = remember(state.messages) { keys(state.messages).asReversed() }
    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 24 } }
    var follow by remember { mutableStateOf(true) }

    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to atBottom }.collect { (scrolling, bottom) -> if (scrolling) follow = bottom }
    }
    LaunchedEffect(messageKeys.firstOrNull()) { if (follow) list.scrollToItem(0) }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = list,
            reverseLayout = true,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            if (state.queue.isNotEmpty())
                item(key = "queue") {
                    Queue(state.queue, canCommand && !busy, viewModel::sendQueuedNow, viewModel::clearQueue, Modifier.animateItem())
                }
            items(state.interactions.filter { it.status == "pending" }, key = { "i:" + it.id }) { interaction ->
                InteractionCard(
                    interaction,
                    canAnswer = canCommand,
                    hasControl = control.heldByCurrentClient,
                    busy = busy,
                    onAnswer = { viewModel.answer(interaction, it) },
                    modifier = Modifier.animateItem(),
                )
            }
            itemsIndexed(messages, key = { index, _ -> messageKeys[index] }) { _, message ->
                MessageView(message, Modifier.animateItem())
            }
            if (messages.isEmpty()) item(key = "empty") {
                Text("No messages yet.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AnimatedVisibility(
            visible = !atBottom,
            enter = fadeIn() + scaleIn(),
            exit = fadeOut() + scaleOut(),
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) {
            SmallFloatingActionButton(onClick = {
                follow = true
                scope.launch { list.animateScrollToItem(0) }
            }) { Icon(PircIcons.ArrowDown, contentDescription = "Scroll to the latest message", modifier = Modifier.size(20.dp)) }
        }
    }
}

@Composable
private fun Queue(queue: List<QueueItem>, canAct: Boolean, onSendNow: (QueueItem) -> Unit, onClear: () -> Unit, modifier: Modifier) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = MaterialTheme.shapes.medium, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 14.dp, top = 4.dp, end = 4.dp, bottom = 4.dp)) {
            for (item in queue) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${if (item.kind == "steer") "Steering" else "Queued"}: ${item.content}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                // Interrupts the current model call or tool and delivers this message at once.
                IconButton(onClick = { onSendNow(item) }, enabled = canAct) {
                    Icon(PircIcons.SendNow, contentDescription = "Send now", modifier = Modifier.size(20.dp))
                }
            }
            TextButton(onClick = onClear, enabled = canAct, modifier = Modifier.align(Alignment.End)) { Text("Clear queue") }
        }
    }
}
