package dev.pirc.android.ui.panels

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Loadable
import dev.pirc.android.PanelsViewModel
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Commit
import dev.pirc.android.core.GIT_LABELS
import dev.pirc.android.core.GitFile
import dev.pirc.android.core.PircApi
import dev.pirc.android.ui.PircIcons
import java.io.IOException

/** Branch and changes, or the commit history. */
@Composable
fun GitPane(
    viewModel: PanelsViewModel,
    onOpenDiff: (GitFile, staged: Boolean) -> Unit,
    onOpenCommit: (Commit) -> Unit,
) {
    val status by viewModel.git.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    var view by rememberSaveable { mutableStateOf("changes") }

    PullToRefreshBox(isRefreshing = false, onRefresh = { viewModel.refresh() }, modifier = Modifier.fillMaxSize()) {
        when (val current = status) {
            Loadable.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is Loadable.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            is Loadable.Ready -> if (!current.value.repo) {
                Text("This workspace is not a Git repository.", modifier = Modifier.padding(24.dp))
            } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                val git = current.value
                item {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(git.branch ?: "detached HEAD", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace))
                            git.upstream?.let { Text("→ $it", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            if (git.ahead > 0) Chip("↑${git.ahead}")
                            if (git.behind > 0) Chip("↓${git.behind}")
                        }
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            listOf("changes" to "Changes (${git.files.size})", "history" to "History").forEachIndexed { index, (key, label) ->
                                SegmentedButton(
                                    selected = view == key,
                                    onClick = { view = key },
                                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                                ) { Text(label) }
                            }
                        }
                    }
                }
                if (view == "changes") {
                    val staged = git.files.filter { it.staged }
                    val unstaged = git.files.filter { it.unstaged }
                    if (staged.isEmpty() && unstaged.isEmpty()) item { Text("No changes.", modifier = Modifier.padding(24.dp)) }
                    for ((title, list, isStaged) in listOf(Triple("Staged", staged, true), Triple("Changes", unstaged, false))) {
                        if (list.isEmpty()) continue
                        item(key = "h:$title") { SectionTitle(title) }
                        items(list, key = { "$title:${it.path}" }) { file ->
                            FileChange(file, isStaged) { onOpenDiff(file, isStaged) }
                        }
                    }
                    if (git.truncated) item { Text("Showing the first 5,000 files.", modifier = Modifier.padding(16.dp)) }
                } else {
                    items(history.commits, key = { it.sha }) { commit -> CommitRow(commit) { onOpenCommit(commit) } }
                    item {
                        when {
                            history.loading -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                            history.error != null -> Text(history.error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                            history.more -> TextButton(onClick = viewModel::loadMoreHistory, modifier = Modifier.padding(8.dp)) { Text("Load more") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
internal fun Chip(text: String, color: Color = MaterialTheme.colorScheme.secondaryContainer) {
    Surface(color = color, shape = MaterialTheme.shapes.small) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
    }
}

private val Added = Color(0xFF2E9E5B)
private val Removed = Color(0xFFD1453B)
private val Changed = Color(0xFFC08A1E)

@Composable
private fun FileChange(file: GitFile, staged: Boolean, onClick: () -> Unit) {
    val code = if (staged) file.index else file.worktree
    val color = when (code) {
        "A", "?" -> Added
        "D" -> Removed
        else -> Changed
    }
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        leadingContent = {
            Text(code, color = color, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.width(20.dp))
        },
        headlineContent = { Text(file.path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                listOfNotNull(
                    file.path.substringBeforeLast('/', "").ifEmpty { null },
                    file.origPath?.let { "from $it" },
                    GIT_LABELS[code],
                ).joinToString(" · "),
                maxLines = 1,
                overflow = TextOverflow.StartEllipsis,
            )
        },
    )
}

@Composable
private fun CommitRow(commit: Commit, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = { Text(commit.subject, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                "${commit.short} · ${commit.author} · ${DateUtils.getRelativeTimeSpanString(commit.time)}" +
                    commit.refs.take(2).joinToString("") { " · $it" },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
    )
    HorizontalDivider(Modifier.padding(start = 16.dp))
}

/** A loadable value for a detail screen, with its own retry. */
@Composable
private fun <T> rememberLoad(vararg keys: Any, onUnauthorized: (ApiException) -> Unit, fetch: suspend () -> T): Loadable<T> {
    val state by produceState<Loadable<T>>(Loadable.Loading, *keys) {
        value = try {
            Loadable.Ready(fetch())
        } catch (error: IOException) {
            if (error is ApiException && error.unauthorized) onUnauthorized(error)
            Loadable.Failed(error.message ?: "Could not load this.")
        }
    }
    return state
}

/** One file's changes (staged or in the worktree). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffScreen(api: PircApi, sessionId: String, path: String, staged: Boolean, untracked: Boolean, onUnauthorized: (ApiException) -> Unit, onBack: () -> Unit) {
    val diff = rememberLoad(path, staged, onUnauthorized = onUnauthorized) { api.gitDiff(sessionId, path, staged, untracked) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            (if (staged) "Staged · " else "") + path,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.StartEllipsis,
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (diff) {
                Loadable.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                is Loadable.Failed -> Text(diff.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
                is Loadable.Ready -> DiffView(diff.value.diff, diff.value.truncated)
            }
        }
    }
}

/** A commit: its message and its diff. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommitScreen(api: PircApi, sessionId: String, sha: String, onUnauthorized: (ApiException) -> Unit, onBack: () -> Unit) {
    val commit = rememberLoad(sha, onUnauthorized = onUnauthorized) { api.gitShow(sessionId, sha) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(sha.take(10), style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (commit) {
                Loadable.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                is Loadable.Failed -> Text(commit.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
                is Loadable.Ready -> DiffView(commit.value.diff, commit.value.truncated) {
                    item {
                        Column(Modifier.width(360.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(commit.value.message.trim(), style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "${commit.value.author} · ${DateUtils.getRelativeTimeSpanString(commit.value.time)}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (commit.value.refs.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                commit.value.refs.forEach { Chip(it) }
                            }
                        }
                    }
                }
            }
        }
    }
}
