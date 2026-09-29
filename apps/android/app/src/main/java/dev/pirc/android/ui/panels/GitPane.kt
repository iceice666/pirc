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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.LifecycleStartEffect
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.GitView
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
    val view by viewModel.gitView.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = viewModel::pullRefresh, modifier = Modifier.fillMaxSize()) {
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
                            // Long branch names ellipsize; the ahead/behind chips keep their width.
                            Text(
                                git.branch ?: "detached HEAD",
                                style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            git.upstream?.let {
                                Text(
                                    "→ $it",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                            }
                            if (git.ahead > 0) Chip("↑${git.ahead}")
                            if (git.behind > 0) Chip("↓${git.behind}")
                        }
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            listOf(GitView.Changes to "Changes (${git.files.size})", GitView.History to "History").forEachIndexed { index, (key, label) ->
                                SegmentedButton(
                                    selected = view == key,
                                    onClick = { viewModel.showGit(key) },
                                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                                ) { Text(label) }
                            }
                        }
                    }
                }
                if (view == GitView.Changes) {
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

/**
 * A value for a detail screen. [reload] keeps what is shown until the new
 * value arrives ([refreshing] meanwhile); a failed reload keeps it too.
 */
private class DetailLoad<T>(
    private val scope: CoroutineScope,
    private val onUnauthorized: (ApiException) -> Unit,
    private val fetch: suspend () -> T,
) {
    var state by mutableStateOf<Loadable<T>>(Loadable.Loading)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var stale by mutableStateOf<String?>(null)
        private set
    private var job: Job? = null
    private var again = false

    fun reload(pulled: Boolean = false) {
        // A change during a load may be missed by it: load once more after.
        if (job?.isActive == true) {
            again = true
            return
        }
        again = false
        val shown = state is Loadable.Ready
        if (!shown) state = Loadable.Loading
        refreshing = pulled && shown
        job = scope.launch {
            try {
                state = Loadable.Ready(fetch())
                stale = null
            } catch (error: IOException) {
                if (error is ApiException && error.unauthorized) onUnauthorized(error)
                val message = error.message ?: "Could not load this."
                if (shown) stale = message else state = Loadable.Failed(message)
            } finally {
                refreshing = false
                job = null
                if (again) reload()
            }
        }
    }
}

@Composable
private fun <T> rememberDetail(vararg keys: Any, onUnauthorized: (ApiException) -> Unit, fetch: suspend () -> T): DetailLoad<T> {
    val scope = rememberCoroutineScope()
    val load = remember(*keys) { DetailLoad(scope, onUnauthorized, fetch) }
    LaunchedEffect(load) { load.reload() }
    return load
}

/** A detail screen's body: pull to refresh, Retry after a failure, a note when a reload failed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> DetailBody(load: DetailLoad<T>, modifier: Modifier, content: @Composable (T) -> Unit) {
    PullToRefreshBox(isRefreshing = load.refreshing, onRefresh = { load.reload(pulled = true) }, modifier = modifier) {
        when (val state = load.state) {
            Loadable.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            is Loadable.Failed -> Column(Modifier.padding(24.dp).verticalScroll(rememberScrollState())) {
                Text(state.message, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { load.reload() }) { Text("Retry") }
            }
            is Loadable.Ready -> Column {
                load.stale?.let {
                    Text(
                        "May be out of date: $it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
                content(state.value)
            }
        }
    }
}

/**
 * One file's changes (staged or in the worktree). Live while shown: it
 * reloads whenever the session's Git status does (as the web's Git tab).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffScreen(api: PircApi, panels: PanelsViewModel, path: String, staged: Boolean, untracked: Boolean, onUnauthorized: (ApiException) -> Unit, onBack: () -> Unit) {
    val sessionId = panels.sessionId
    val diff = rememberDetail(path, staged, onUnauthorized = onUnauthorized) { api.gitDiff(sessionId, path, staged, untracked) }
    LifecycleStartEffect(panels) {
        panels.start()
        onStopOrDispose { panels.stop() }
    }
    LaunchedEffect(panels, diff) {
        // Skip the load already counted: only a newer one means the file may have changed.
        panels.gitLoads.drop(1).collect { diff.reload() }
    }
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
        DetailBody(diff, Modifier.fillMaxSize().padding(padding)) { DiffView(it.diff, it.truncated) }
    }
}

/** A commit: its message and its diff. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommitScreen(api: PircApi, sessionId: String, sha: String, onUnauthorized: (ApiException) -> Unit, onBack: () -> Unit) {
    val commit = rememberDetail(sha, onUnauthorized = onUnauthorized) { api.gitShow(sessionId, sha) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(sha.take(10), style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        DetailBody(commit, Modifier.fillMaxSize().padding(padding)) { detail ->
            DiffView(detail.diff, detail.truncated) {
                item {
                    Column(Modifier.width(360.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(detail.message.trim(), style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "${detail.author} · ${DateUtils.getRelativeTimeSpanString(detail.time)}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (detail.refs.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            detail.refs.forEach { Chip(it) }
                        }
                    }
                }
            }
        }
    }
}
