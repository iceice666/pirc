package dev.pirc.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.AppViewModel
import dev.pirc.android.core.RecentRow
import dev.pirc.android.core.isChatSession
import dev.pirc.android.core.workGroups

/**
 * Work: every session outside the chat workspaces, by what it needs. Needs
 * you (answers, missed runs, memory proposals, from anywhere) comes first,
 * with its actions inline; then Running and Recent, optionally one workspace.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkTab(viewModel: AppViewModel, actions: SessionActions) {
    val state by viewModel.sessions.collectAsStateWithLifecycle()
    val inbox by viewModel.inbox.collectAsStateWithLifecycle()
    val busy by viewModel.inboxBusy.collectAsStateWithLifecycle()
    val sources by viewModel.proposalSources.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    var showDone by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var addingWorkspace by remember { mutableStateOf(false) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior()

    val directories = remember(state.workspaces) { state.workspaces.filter { !it.isChat }.sortedBy { it.displayName.lowercase() } }
    // A workspace chosen before it went away shows everything again.
    val chosen = filter?.takeIf { id -> directories.any { it.id == id } }
    val groups = remember(state.sessions, state.workspaces, chosen, showDone) {
        workGroups(
            state.sessions,
            include = { session -> !isChatSession(session, state.workspaces) && (chosen == null || session.workspaceId == chosen) },
            showSettled = showDone,
        )
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = { TopAppBar(title = { HomeTitle("Work", viewModel) }, scrollBehavior = scroll) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { creating = true },
                icon = { Icon(PircIcons.Plus, contentDescription = null) },
                text = { Text("New session") },
                expanded = scroll.state.collapsedFraction < 0.5f,
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.loading,
            onRefresh = { viewModel.refresh() },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                state.error?.let { error -> item(key = "error") { ListError(error, state.loading, viewModel::retry, Modifier.animateItem()) } }

                if (!inbox.isEmpty) {
                    item(key = "h:needs") { SectionHeader("Needs you", count = inbox.count) }
                    items(inbox.waiting, key = { "w:" + it.id }) { session ->
                        WaitingCard(session, Modifier.animateItem()) { actions.open(session) }
                    }
                    items(inbox.missed, key = { "m:" + it.run.id }) { missed ->
                        MissedRunCard(
                            missed,
                            busy = "run:${missed.run.id}" in busy,
                            modifier = Modifier.animateItem(),
                            onAllow = { viewModel.allowRun(missed) },
                            onDismiss = { viewModel.dismissRun(missed) },
                        )
                    }
                    items(inbox.proposals, key = { "p:" + it.id }) { proposal ->
                        ProposalCard(
                            proposal,
                            source = sources[proposal.sessionId],
                            busy = "proposal:${proposal.id}" in busy,
                            modifier = Modifier.animateItem(),
                            onApprove = { viewModel.approveProposal(proposal) },
                            onReject = { viewModel.rejectProposal(proposal) },
                        )
                    }
                }

                item(key = "filters") {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        item { FilterChip(selected = chosen == null, onClick = { filter = null }, label = { Text("All") }) }
                        items(directories, key = { it.id }) { workspace ->
                            FilterChip(
                                selected = chosen == workspace.id,
                                onClick = { filter = if (chosen == workspace.id) null else workspace.id },
                                label = { Text("${workspace.displayName} · ${workspace.hostId}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            )
                        }
                    }
                }

                if (groups.running.isNotEmpty()) {
                    item(key = "h:running") { SectionHeader("Running", count = groups.running.size) }
                    items(groups.running, key = { it.id }) { session ->
                        SessionRow(session, Modifier.animateItem(), onLongClick = { actions.act(session) }) { actions.open(session) }
                    }
                }

                item(key = "h:recent") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SectionHeader("Recent", Modifier.weight(1f))
                        FilterChip(
                            selected = showDone,
                            onClick = { showDone = !showDone },
                            label = { Text(if (showDone || groups.settled == 0) "Show done" else "Show done (${groups.settled})") },
                            modifier = Modifier.padding(end = 12.dp, top = 8.dp),
                        )
                    }
                }
                if (groups.recent.isEmpty() && !state.loading) item(key = "e:recent") {
                    Text(
                        if (groups.running.isEmpty()) "No sessions here. Start one with New session." else "Nothing else here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).animateItem(),
                    )
                }
                for (row in groups.recent) when (row) {
                    is RecentRow.Single -> item(key = row.key) {
                        SessionRow(row.session, Modifier.animateItem(), onLongClick = { actions.act(row.session) }) { actions.open(row.session) }
                    }
                    is RecentRow.ScheduleRuns -> {
                        val open = expanded[row.scheduleId] == true
                        item(key = row.key) {
                            ScheduleFoldRow(row, open, Modifier.animateItem()) { expanded[row.scheduleId] = !open }
                        }
                        if (open) items(row.sessions, key = { "f:" + it.id }) { session ->
                            SessionRow(session, Modifier.animateItem(), indent = true, onLongClick = { actions.act(session) }) { actions.open(session) }
                        }
                    }
                }
            }
        }
    }

    if (creating) NewSessionSheet(
        state = state.copy(workspaces = directories),
        onCreate = { workspace ->
            creating = false
            viewModel.createSession(workspace.id, actions.open)
        },
        onAddWorkspace = {
            creating = false
            addingWorkspace = true
        },
        onDismiss = { creating = false },
    )
    if (addingWorkspace) AddWorkspaceDialog(
        state = state,
        onAdd = { node, path, name ->
            addingWorkspace = false
            // A new workspace is added to work in it: straight into a session there.
            viewModel.createWorkspace(node, path, name) { workspace -> viewModel.createSession(workspace.id, actions.open) }
        },
        onDismiss = { addingWorkspace = false },
    )
}

/** Every run of one schedule, as one row ("CI check · 4 runs"); it expands to the runs. */
@Composable
private fun ScheduleFoldRow(row: RecentRow.ScheduleRuns, open: Boolean, modifier: Modifier, onToggle: () -> Unit) {
    val newest = row.sessions.first()
    Column(modifier) {
        ListItem(
            modifier = Modifier.clickable(onClick = onToggle).semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
            leadingContent = { Icon(PircIcons.Clock, contentDescription = "Scheduled runs", modifier = Modifier.size(20.dp)) },
            headlineContent = { Text("${row.title} · ${row.sessions.size} runs", maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text("Last ${relativeTime(newest.updatedAt)}", maxLines = 1) },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (row.sessions.any { it.writeLease })
                        Icon(PircIcons.Lock, contentDescription = "Holds the write lease", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    status(newest)?.let { StatusLabel(it) }
                    Icon(PircIcons.ChevronDown, contentDescription = null, modifier = Modifier.size(20.dp).rotate(if (open) 180f else 0f))
                }
            },
        )
        HorizontalDivider(Modifier.padding(start = 16.dp))
    }
}
