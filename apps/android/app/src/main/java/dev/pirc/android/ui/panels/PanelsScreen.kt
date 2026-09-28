package dev.pirc.android.ui.panels

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.FilesViewModel
import dev.pirc.android.Loadable
import dev.pirc.android.PanelTab
import dev.pirc.android.PanelsViewModel
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Commit
import dev.pirc.android.core.GitFile
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.TerminalInfo
import dev.pirc.android.ui.PircIcons
import dev.pirc.android.ui.files.FilesPane

/** A session's side panels, one tab each: files, Git, tasks, memory and terminals. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PanelsScreen(
    viewModel: PanelsViewModel,
    files: FilesViewModel,
    api: PircApi,
    title: String,
    onUnauthorized: (ApiException) -> Unit,
    onOpenFile: (String) -> Unit,
    onOpenDiff: (GitFile, Boolean) -> Unit,
    onOpenCommit: (Commit) -> Unit,
    onOpenTerminal: (TerminalInfo) -> Unit,
    onBack: () -> Unit,
) {
    val tab by viewModel.tab.collectAsStateWithLifecycle()
    val panel by viewModel.panel.collectAsStateWithLifecycle()
    val git by viewModel.git.collectAsStateWithLifecycle()
    val actionError by viewModel.actionError.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    LaunchedEffect(viewModel, files) { viewModel.filesChanged.collect { files.reload() } }
    LaunchedEffect(actionError) {
        actionError?.let {
            snackbar.showSnackbar(it)
            viewModel.dismissActionError()
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(title, maxLines = 1) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                )
                PrimaryScrollableTabRow(selectedTabIndex = tab.ordinal, edgePadding = 8.dp) {
                    for (item in PanelTab.entries) {
                        val badge = when (item) {
                            PanelTab.Git -> ((git as? Loadable.Ready)?.value?.files?.size ?: 0)
                            PanelTab.Tasks -> ((panel as? Loadable.Ready)?.value?.backgroundTasks?.count { it.live } ?: 0)
                            else -> 0
                        }
                        Tab(
                            selected = tab == item,
                            onClick = { viewModel.select(item) },
                            text = {
                                if (badge > 0) BadgedBox(badge = { Badge { Text(badge.toString()) } }) { Text(item.label) }
                                else Text(item.label)
                            },
                        )
                    }
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        AnimatedContent(
            targetState = tab,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "panel",
            modifier = Modifier.fillMaxSize().padding(padding),
        ) { current ->
            when (current) {
                PanelTab.Files -> FilesPane(files, active = tab == PanelTab.Files, onOpenFile = onOpenFile)
                PanelTab.Git -> GitPane(viewModel, onOpenDiff, onOpenCommit)
                PanelTab.Tasks -> TasksPane(viewModel, api, onUnauthorized)
                PanelTab.Memory -> MemoryPane(viewModel)
                PanelTab.Terminal -> TerminalsPane(viewModel, onOpenTerminal)
            }
        }
    }
}

@Composable
private fun TerminalsPane(viewModel: PanelsViewModel, onOpen: (TerminalInfo) -> Unit) {
    val terminals by viewModel.terminals.collectAsStateWithLifecycle()
    val lease by viewModel.control.lease.collectAsStateWithLifecycle()
    PullToRefreshBox(isRefreshing = false, onRefresh = { viewModel.refresh() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        "Shells run in the workspace as the node's account, like the agent's own tools.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (lease.heldByCurrentClient) Button(onClick = { viewModel.createTerminal(onOpen) }, modifier = Modifier.padding(top = 12.dp)) {
                        Text("New terminal")
                    } else TextButton(onClick = viewModel.control::take, modifier = Modifier.padding(top = 8.dp)) {
                        Text(if (lease.free) "Getting control…" else "Take control to open a terminal")
                    }
                }
            }
            when (val current = terminals) {
                Loadable.Loading -> item { Box(Modifier.padding(24.dp).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                is Loadable.Failed -> item { Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
                is Loadable.Ready -> {
                    if (current.value.isEmpty()) item { Text("No terminals.", modifier = Modifier.padding(horizontal = 16.dp)) }
                    items(current.value, key = { it.id }) { terminal ->
                        ListItem(
                            modifier = Modifier.clickable { onOpen(terminal) },
                            headlineContent = { Text(terminal.title.ifEmpty { "Terminal" }) },
                            supportingContent = {
                                Text(
                                    listOfNotNull(
                                        terminal.cwd.ifEmpty { null },
                                        "${terminal.cols}×${terminal.rows}",
                                        if (terminal.exited) "exited" + (terminal.exitCode?.let { " ($it)" } ?: "") else null,
                                    ).joinToString(" · "),
                                )
                            },
                            trailingContent = when {
                                terminal.exited -> ({ TextButton(onClick = { viewModel.removeExitedTerminal(terminal) }) { Text("Remove") } })
                                lease.heldByCurrentClient -> ({ TextButton(onClick = { viewModel.closeTerminal(terminal.id) }) { Text("Close") } })
                                else -> null
                            },
                        )
                        HorizontalDivider(Modifier.padding(start = 16.dp))
                    }
                }
            }
        }
    }
}
