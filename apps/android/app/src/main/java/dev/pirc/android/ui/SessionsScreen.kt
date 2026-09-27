package dev.pirc.android.ui

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.background
import dev.pirc.android.AppViewModel
import dev.pirc.android.core.Session
import dev.pirc.android.core.WorkspaceGroup

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(viewModel: AppViewModel, onOpen: (Session) -> Unit) {
    val state by viewModel.sessions.collectAsStateWithLifecycle()
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior()
    var menu by remember { mutableStateOf(false) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Sessions")
                        pairing?.let {
                            Text(
                                it.baseUrl.substringAfter("://"),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                actions = {
                    TextButton(onClick = { menu = true }) { Text("More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Unpair this phone") }, onClick = {
                            menu = false
                            viewModel.unpair()
                        })
                    }
                },
                scrollBehavior = scroll,
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.loading,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                state.error?.let { error ->
                    item(key = "error") {
                        Text(
                            error,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(16.dp).animateItem(),
                        )
                    }
                }
                if (!state.loading && state.error == null && state.groups.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            "No sessions yet. Start one from the web for now.",
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(24.dp).animateItem(),
                        )
                    }
                }
                state.groups.forEach { group ->
                    stickyHeader(key = "h:${group.workspaceId}") { GroupHeader(group) }
                    items(group.open, key = { it.id }) { session ->
                        SessionRow(session, Modifier.animateItem()) { onOpen(session) }
                    }
                    if (group.settled.isNotEmpty()) {
                        val open = expanded[group.workspaceId] == true
                        item(key = "s:${group.workspaceId}") {
                            TextButton(
                                onClick = { expanded[group.workspaceId] = !open },
                                modifier = Modifier.padding(horizontal = 8.dp).animateItem(),
                            ) { Text(if (open) "Hide settled" else "${group.settled.size} settled") }
                        }
                        if (open) items(group.settled, key = { it.id }) { session ->
                            SessionRow(session, Modifier.animateItem()) { onOpen(session) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupHeader(group: WorkspaceGroup) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier.size(8.dp).clip(CircleShape).background(
                    if (group.online) Color(0xFF3FA66B) else MaterialTheme.colorScheme.outline,
                ),
            )
            Text(group.title, style = MaterialTheme.typography.titleSmall)
            Text(
                group.node,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SessionRow(session: Session, modifier: Modifier, onClick: () -> Unit) {
    Column(modifier) {
        ListItem(
            modifier = Modifier.clickable(onClick = onClick),
            headlineContent = {
                Text(session.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
            },
            supportingContent = {
                Text(
                    buildString {
                        if (session.pinned) append("Pinned · ")
                        append(DateUtils.getRelativeTimeSpanString(session.updatedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS))
                    },
                )
            },
            trailingContent = { status(session)?.let { StatusLabel(it) } },
        )
        HorizontalDivider(Modifier.padding(start = 16.dp))
    }
}

private data class Status(val label: String, val attention: Boolean)

private fun status(session: Session): Status? = when (session.runStatus) {
    "queued", "running" -> Status("Running", false)
    "stopping" -> Status("Stopping", false)
    "waiting_input" -> Status("Needs input", true)
    "failed" -> Status("Failed", true)
    else -> if (session.runnerState == "failed") Status("Offline", true) else null
}

@Composable
private fun StatusLabel(status: Status) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = if (status.attention) colors.errorContainer else colors.secondaryContainer,
        contentColor = if (status.attention) colors.onErrorContainer else colors.onSecondaryContainer,
    ) {
        Text(status.label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}
