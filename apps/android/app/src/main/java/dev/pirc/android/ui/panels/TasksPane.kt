package dev.pirc.android.ui.panels

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Loadable
import dev.pirc.android.PanelsViewModel
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.BackgroundOutput
import dev.pirc.android.core.BackgroundTask
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.TeamMember
import dev.pirc.android.ui.session.CodePane
import kotlinx.coroutines.delay
import java.io.IOException

/** Background jobs, subagents and teammates, the team's task board and messages. */
@Composable
fun TasksPane(viewModel: PanelsViewModel, api: PircApi, onUnauthorized: (ApiException) -> Unit) {
    val panel by viewModel.panel.collectAsStateWithLifecycle()
    var watching by rememberSaveable { mutableStateOf<String?>(null) }

    PullToRefreshBox(isRefreshing = false, onRefresh = { viewModel.refresh() }, modifier = Modifier.fillMaxSize()) {
        when (val current = panel) {
            Loadable.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is Loadable.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            is Loadable.Ready -> {
                val state = current.value
                val subagents = state.team.agents.filter { it.mode == "subagent" }
                val teammates = state.team.agents.filter { it.mode != "subagent" }
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item { SectionTitle("Background tasks") }
                    if (state.backgroundTasks.isEmpty()) item { Empty("No background tasks.") }
                    items(state.backgroundTasks, key = { "task:${it.id}" }) { task -> TaskRow(task) { watching = task.id } }
                    if (subagents.isNotEmpty()) {
                        item { SectionTitle("Subagents") }
                        items(subagents, key = { "sub:${it.name}" }) { MemberRow(it) }
                    }
                    item { SectionTitle("Teammates") }
                    if (teammates.isEmpty()) item { Empty("No teammates.") }
                    items(teammates, key = { "mate:${it.name}" }) { MemberRow(it) }
                    if (state.team.tasks.isNotEmpty()) {
                        item { SectionTitle("Task board") }
                        items(state.team.tasks, key = { "board:${it.id}" }) { task ->
                            ListItem(
                                headlineContent = { Text("#${task.id} ${task.subject}") },
                                supportingContent = {
                                    Text(
                                        listOfNotNull(
                                            task.status.replace('_', ' '),
                                            task.owner?.let { "owner $it" } ?: "unowned",
                                            task.blockedBy.takeIf { it.isNotEmpty() }?.joinToString(", ", prefix = "after ") { "#$it" },
                                            if (task.blocked) "blocked" else null,
                                        ).joinToString(" · "),
                                    )
                                },
                            )
                        }
                    }
                    if (state.team.events.isNotEmpty()) {
                        item { SectionTitle("Team messages") }
                        items(state.team.events.takeLast(50).asReversed(), key = { "event:${it.id}" }) { event ->
                            ListItem(
                                overlineContent = {
                                    Text(listOfNotNull(event.kind, event.from?.let { f -> "$f → ${event.to ?: "all"}" }).joinToString(" · "))
                                },
                                headlineContent = { Text(event.body ?: event.name ?: "", maxLines = 4, overflow = TextOverflow.Ellipsis) },
                            )
                        }
                    }
                }
            }
        }
    }

    watching?.let { id ->
        val task = (panel as? Loadable.Ready)?.value?.backgroundTasks?.firstOrNull { it.id == id }
        TaskOutputSheet(api, viewModel.sessionId, id, task, onStop = { viewModel.stopTask(id) }, onUnauthorized = onUnauthorized) { watching = null }
    }
}

@Composable
private fun Empty(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

@Composable
private fun TaskRow(task: BackgroundTask, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Text(task.command, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), maxLines = 2, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            Text(
                listOfNotNull(
                    task.status.replace('_', ' '),
                    task.exitCode?.let { "exit $it" },
                    if (task.tty) "tty" else null,
                    task.notifyOn?.let { "notify /$it/" },
                    task.error,
                ).joinToString(" · "),
            )
        },
        trailingContent = { if (task.live) CircularProgressIndicator(Modifier.padding(4.dp), strokeWidth = 2.dp) },
    )
    HorizontalDivider(Modifier.padding(start = 16.dp))
}

@Composable
private fun MemberRow(member: TeamMember) {
    ListItem(
        headlineContent = { Text(member.name + (member.model?.let { " · $it" } ?: "")) },
        supportingContent = {
            Column {
                Text(listOfNotNull(member.status, member.kind, if (member.background) "background" else null).joinToString(" · "))
                member.task?.let { Text(it, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                member.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error, maxLines = 3) }
            }
        },
    )
}

/** The latest output of one background task, refreshed while it runs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskOutputSheet(
    api: PircApi,
    sessionId: String,
    taskId: String,
    known: BackgroundTask?,
    onStop: () -> Unit,
    onUnauthorized: (ApiException) -> Unit,
    onDismiss: () -> Unit,
) {
    var output by remember { mutableStateOf<Loadable<BackgroundOutput>>(Loadable.Loading) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(taskId, tick) {
        while (true) {
            output = try {
                Loadable.Ready(api.backgroundOutput(sessionId, taskId))
            } catch (error: IOException) {
                if (error is ApiException && error.unauthorized) onUnauthorized(error)
                Loadable.Failed(error.message ?: "Could not read the output.")
            }
            val live = (output as? Loadable.Ready)?.value?.task?.live ?: false
            if (!live) break
            delay(2_000)
        }
    }
    val task = (output as? Loadable.Ready)?.value?.task ?: known
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxHeight(0.9f).navigationBarsPadding().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(task?.command ?: taskId, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Monospace), maxLines = 3)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    listOfNotNull(task?.status?.replace('_', ' '), task?.exitCode?.let { "exit $it" }, task?.cwd).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { tick++ }) { Text("Refresh") }
                if (task?.status == "running") OutlinedButton(onClick = onStop) { Text("Stop") }
            }
            when (val current = output) {
                Loadable.Loading -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                is Loadable.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error)
                is Loadable.Ready -> CodePane("Last 400 lines", AnnotatedString(current.value.output.ifEmpty { "(no output yet)" }), Modifier.fillMaxWidth(), maxHeight = 2_000.dp)
            }
        }
    }
}
