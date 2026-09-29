package dev.pirc.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
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
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.chatHome

/**
 * The assistant's chats: projects (each expands to its chats) and the
 * top-level chats. No engineering detail here (runs, leases, jobs).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatTab(viewModel: AppViewModel, actions: SessionActions) {
    val state by viewModel.sessions.collectAsStateWithLifecycle()
    val online by Connectivity.online.collectAsStateWithLifecycle()
    val home = remember(state.sessions, state.workspaces) { chatHome(state.sessions, state.workspaces) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    var showSettled by rememberSaveable { mutableStateOf(false) }
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior()
    val chats = home.chatsWorkspace
    val canCreate = chats != null && state.online(chats) && online

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = { TopAppBar(title = { HomeTitle("Chat", viewModel) }, scrollBehavior = scroll) },
        floatingActionButton = {
            if (chats != null) ExtendedFloatingActionButton(
                onClick = { if (canCreate) viewModel.createSession(chats.id, actions.open) },
                icon = { Icon(PircIcons.Plus, contentDescription = null) },
                text = { Text("New chat") },
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
                if (!state.loading && chats == null && home.projects.isEmpty()) item(key = "none") {
                    Text(
                        "No assistant chats on this gateway yet. Work sessions are under Work.",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(24.dp),
                    )
                }
                if (home.projects.isNotEmpty()) {
                    item(key = "h:projects") { SectionHeader("Projects") }
                    for (project in home.projects) {
                        val id = project.workspace.id
                        val open = expanded[id] == true
                        item(key = "p:$id") {
                            ProjectRow(
                                title = project.workspace.displayName,
                                count = project.chats.size,
                                open = open,
                                canCreate = state.online(project.workspace) && online,
                                modifier = Modifier.animateItem(),
                                onToggle = { expanded[id] = !open },
                                onCreate = { viewModel.createSession(id, actions.open) },
                            )
                        }
                        if (open) {
                            if (project.chats.isEmpty() && project.settled.isEmpty()) item(key = "pe:$id") {
                                Text(
                                    "No chats in this project yet.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(start = 32.dp, top = 8.dp, bottom = 8.dp).animateItem(),
                                )
                            }
                            items(project.chats + if (showSettled) project.settled else emptyList(), key = { "pc:" + it.id }) { session ->
                                SessionRow(session, Modifier.animateItem(), showLease = false, indent = true, onLongClick = { actions.act(session) }) { actions.open(session) }
                            }
                        }
                    }
                }
                item(key = "h:chats") { SectionHeader("Chats") }
                if (chats != null && home.chats.isEmpty() && !state.loading) item(key = "e:chats") {
                    Text(
                        "No chats yet. Start one with New chat.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
                items(home.chats, key = { it.id }) { session ->
                    SessionRow(session, Modifier.animateItem(), showLease = false, onLongClick = { actions.act(session) }) { actions.open(session) }
                }
                val settled = home.settled.size + home.projects.sumOf { it.settled.size }
                if (settled > 0) {
                    item(key = "settled") {
                        TextButton(onClick = { showSettled = !showSettled }, modifier = Modifier.padding(horizontal = 8.dp).animateItem()) {
                            Text(if (showSettled) "Hide settled" else "$settled settled")
                        }
                    }
                    if (showSettled) items(home.settled, key = { it.id }) { session ->
                        SessionRow(session, Modifier.animateItem(), showLease = false, onLongClick = { actions.act(session) }) { actions.open(session) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectRow(title: String, count: Int, open: Boolean, canCreate: Boolean, modifier: Modifier, onToggle: () -> Unit, onCreate: () -> Unit) {
    Column(modifier) {
        ListItem(
            modifier = Modifier.clickable(onClick = onToggle).semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
            leadingContent = { Icon(PircIcons.Folder, contentDescription = null, modifier = Modifier.size(20.dp)) },
            headlineContent = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text(if (count == 1) "1 chat" else "$count chats") },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onCreate, enabled = canCreate) {
                        Icon(PircIcons.Plus, contentDescription = "New chat in $title", modifier = Modifier.size(20.dp))
                    }
                    Icon(PircIcons.ChevronDown, contentDescription = null, modifier = Modifier.size(20.dp).rotate(if (open) 180f else 0f))
                }
            },
        )
        HorizontalDivider(Modifier.padding(start = 16.dp))
    }
}

/** The list could not load: the last one stays, with a retry. */
@Composable
internal fun ListError(error: String, loading: Boolean, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 16.dp)) {
            Text(error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
            TextButton(onClick = onRetry, enabled = !loading) { Text("Retry") }
        }
    }
}
