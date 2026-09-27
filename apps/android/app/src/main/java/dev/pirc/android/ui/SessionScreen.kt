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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
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
import dev.pirc.android.core.timeline.Interaction
import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.QueueItem
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.ui.session.MessageView
import kotlinx.coroutines.launch

/** A session's live timeline (read-only for now: answering and prompting come next). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(viewModel: SessionViewModel, fallbackName: String, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state?.session?.name ?: fallbackName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            subtitle(state, connection),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val current = state
            when {
                current != null -> Timeline(current)
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
}

private fun subtitle(state: SessionState?, connection: Connection): String {
    val run = when (state?.run?.status) {
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
private fun Timeline(state: SessionState) {
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
            modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        ) {
            if (state.interactions.isNotEmpty() || state.queue.isNotEmpty())
                item(key = "footer") { Footer(state.interactions, state.queue, Modifier.animateItem()) }
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
            modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(16.dp),
        ) {
            SmallFloatingActionButton(onClick = {
                follow = true
                scope.launch { list.animateScrollToItem(0) }
            }) { Text("↓") }
        }
    }
}

@Composable
private fun Footer(interactions: List<Interaction>, queue: List<QueueItem>, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (item in queue) Text(
            "${if (item.kind == "steer") "Steering" else "Queued"}: ${item.content}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        for (interaction in interactions.filter { it.status == "pending" }) Surface(
            color = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(interaction.title, style = MaterialTheme.typography.titleSmall)
                interaction.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                interaction.options.forEach { Text("• ${it.label}", style = MaterialTheme.typography.bodyMedium) }
                Text(
                    "The agent is waiting. Answering from the phone comes in the next update; use the web for now.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}
