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
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.pirc.android.push.VisibleSession
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Connection
import dev.pirc.android.SessionViewModel
import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.QueueItem
import dev.pirc.android.core.timeline.SandboxStatus
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.ui.session.Composer
import dev.pirc.android.PanelTab
import dev.pirc.android.core.Session
import dev.pirc.android.core.SessionOrigin
import dev.pirc.android.core.TimelineItem
import dev.pirc.android.core.blockingSession
import dev.pirc.android.core.timelineItems
import dev.pirc.android.ui.session.LocalPendingInteractions
import dev.pirc.android.ui.session.LocalWriteBlockOpener
import dev.pirc.android.ui.session.RunCard
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import dev.pirc.android.ui.session.InteractionCard
import dev.pirc.android.ui.session.LocalFileOpener
import dev.pirc.android.ui.session.LocalRecordingOpener
import dev.pirc.android.ui.session.MessageView
import dev.pirc.android.core.FileTarget
import dev.pirc.android.core.parseFileLink
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
    /** What started the session, from the list (the snapshot does not say). */
    origin: SessionOrigin?,
    /** An assistant chat: the engineering chrome (jobs, status widgets) stays out of the way. */
    chat: Boolean,
    /** The listed sessions, to find the one a blocked write names. */
    sessions: List<Session>,
    onOpenSchedule: (scheduleId: String) -> Unit,
    onOpenSession: (id: String, name: String) -> Unit,
    onBack: () -> Unit,
    /** [tab] null: the tab shown last. */
    onOpenPanels: (title: String, tab: PanelTab?) -> Unit,
    onOpenFile: (FileTarget) -> Unit,
    /** Play a browser recording (a `browser_record` tool result). */
    onOpenRecording: (String) -> Unit,
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
    // A write refused for another session's lease links to that session.
    val blockers = remember(sessions, onOpenSession) {
        { name: String -> blockingSession(sessions, name)?.takeIf { it.id != viewModel.sessionId }?.let { holder -> { onOpenSession(holder.id, holder.name) } } }
    }

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    // On screen: notifications about this session would only repeat it.
    LifecycleResumeEffect(viewModel) {
        VisibleSession.id = viewModel.sessionId
        onPauseOrDispose { if (VisibleSession.id == viewModel.sessionId) VisibleSession.id = null }
    }
    // A rename from another device arrives as an event: keep the list in step.
    LaunchedEffect(viewModel) {
        snapshotFlow { state?.session }.filterNotNull().distinctUntilChanged().drop(1).collect { onChanged(it) }
    }

    Scaffold(
        topBar = { Column {
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
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                actions = {
                    val session by remember { derivedStateOf { state?.session } }
                    val title = session?.name ?: fallbackName
                    // The panels as they were left (the web keeps them mounted); a chat keeps them in the menu.
                    if (!chat) TextButton(onClick = { onOpenPanels(title, null) }) { Text("Files") }
                    val running by viewModel.jobs.collectAsStateWithLifecycle()
                    val jobs = if (chat) 0 else running
                    TextButton(onClick = { menu = true }, modifier = Modifier.semantics { if (jobs > 0) stateDescription = "$jobs running jobs" }) {
                        if (jobs > 0) BadgedBox(badge = { Badge { Text(jobs.toString()) } }) { Text("More") } else Text("More")
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        val tabs = listOf(PanelTab.Git, PanelTab.Tasks, PanelTab.Memory, PanelTab.Terminal, PanelTab.Browser)
                        for (tab in if (chat) listOf(PanelTab.Files) + tabs else tabs)
                            DropdownMenuItem(text = { Text(if (tab == PanelTab.Tasks && jobs > 0) "Tasks · $jobs running" else tab.label) }, onClick = {
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
            origin?.let { OriginChip(it, onOpenSchedule, onOpenSession, sessions) }
            state?.sandbox?.takeIf { !it.active }?.let { UnsandboxedChip(it) }
        } },
        bottomBar = {
            // The larger of keyboard and navigation bar, not both stacked.
            val loaded by remember { derivedStateOf { state != null } }
            if (loaded) Composer(viewModel, Modifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)), chat = chat)
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val current = state
            when {
                current != null -> CompositionLocalProvider(LocalUriHandler provides links, LocalFileOpener provides onOpenFile, LocalRecordingOpener provides onOpenRecording, LocalWriteBlockOpener provides blockers, LocalPendingInteractions provides current.interactions.filter { it.status == "pending" }) {
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

/** "Scheduled · CI check" links to the schedule; "Delegated · Fix it" to the chat that delegated it. */
@Composable
private fun OriginChip(origin: SessionOrigin, onOpenSchedule: (String) -> Unit, onOpenSession: (String, String) -> Unit, sessions: List<Session>) {
    val scheduleId = origin.scheduleId
    val from = origin.fromSessionId
    val (label, icon, open) = when {
        origin.schedule && scheduleId != null -> Triple("Scheduled", PircIcons.Clock) { onOpenSchedule(scheduleId) }
        origin.delegation && from != null -> Triple("Delegated", PircIcons.Forward) {
            onOpenSession(from, sessions.firstOrNull { it.id == from }?.name ?: "Chat")
        }
        else -> return
    }
    AssistChip(
        onClick = open,
        label = { Text(listOf(label, origin.title).filter { it.isNotEmpty() }.joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(AssistChipDefaults.IconSize)) },
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}

/** Stays while the agent runs outside the sandbox (the timeline warning scrolls away); tap for why. */
@Composable
private fun UnsandboxedChip(sandbox: SandboxStatus) {
    var open by remember { mutableStateOf(false) }
    AssistChip(
        onClick = { open = true },
        label = { Text("Not sandboxed", maxLines = 1) },
        leadingIcon = { Icon(PircIcons.ShieldOff, contentDescription = null, modifier = Modifier.size(AssistChipDefaults.IconSize)) },
        colors = AssistChipDefaults.assistChipColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            labelColor = MaterialTheme.colorScheme.onErrorContainer,
            leadingIconContentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
        border = null,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        title = { Text("Not sandboxed") },
        text = { Text((sandbox.reason?.let { "$it.\n\n" } ?: "") + "This agent's commands run with the node account's full access.") },
        confirmButton = { TextButton(onClick = { open = false }) { Text("OK") } },
    )
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

/** Timeline items keyed by their (first) message's unique key. */
private fun timelineEntries(messages: List<Message>): List<Pair<String, TimelineItem>> {
    val unique = keys(messages)
    var index = 0
    return timelineItems(messages).map { item ->
        val key = unique[index]
        when (item) {
            is TimelineItem.Single -> {
                index += 1
                key to item
            }
            is TimelineItem.Run -> {
                index += item.messages.size
                "run:$key" to item
            }
        }
    }
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
    // Consecutive tool-only turns become one run card; newest first for the reversed list.
    val entries = remember(state.messages) { timelineEntries(state.messages).asReversed() }
    val messages = state.messages
    val messageKeys = remember(entries) { entries.map { it.first } }
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
            items(entries, key = { it.first }) { (key, item) ->
                when (item) {
                    is TimelineItem.Single -> MessageView(item.message, Modifier.animateItem())
                    is TimelineItem.Run -> RunCard(key, item.messages, Modifier.animateItem())
                }
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
