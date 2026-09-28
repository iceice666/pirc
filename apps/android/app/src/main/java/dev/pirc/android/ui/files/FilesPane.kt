package dev.pirc.android.ui.files

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.FilesViewModel
import dev.pirc.android.Loadable
import dev.pirc.android.core.DirEntry
import dev.pirc.android.ui.PircIcons

/**
 * The session's workspace, one folder at a time (the Files tab). While
 * [active], Back goes up a folder before it leaves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesPane(viewModel: FilesViewModel, active: Boolean, onOpenFile: (String) -> Unit) {
    val path by viewModel.path.collectAsStateWithLifecycle()
    val listing by viewModel.listing.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val parent = viewModel.parent()
    BackHandler(enabled = active && parent != null) { viewModel.open(parent!!) }

    Column(Modifier.fillMaxSize()) {
        val segments = if (path.isEmpty()) emptyList() else path.split('/')
        LazyRow(contentPadding = PaddingValues(horizontal = 8.dp)) {
            item { TextButton(onClick = { viewModel.open("") }) { Text("Workspace") } }
            itemsIndexed(segments) { index, name ->
                TextButton(onClick = { viewModel.open(segments.take(index + 1).joinToString("/")) }) {
                    Text("/ $name", maxLines = 1)
                }
            }
        }
        AnimatedContent(
            targetState = path to listing,
            contentKey = { it.first to (it.second is Loadable.Ready) },
            transitionSpec = { (fadeIn() + slideInHorizontally { it / 8 }) togetherWith (fadeOut() + slideOutHorizontally { -it / 8 }) },
            label = "folder",
        ) { (folder, state) ->
            when (state) {
                Loadable.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                is Loadable.Failed -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(state.message, color = MaterialTheme.colorScheme.error)
                }
                is Loadable.Ready -> PullToRefreshBox(isRefreshing = false, onRefresh = viewModel::reload) {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        items(state.value.entries, key = { it.name }) { entry ->
                            EntryRow(entry, detail = entry.size?.let { Formatter.formatShortFileSize(context, it) }) {
                                val full = if (folder.isEmpty()) entry.name else "$folder/${entry.name}"
                                if (entry.kind == "dir") viewModel.open(full) else onOpenFile(full)
                            }
                        }
                        if (state.value.entries.isEmpty()) item { Text("This folder is empty.", modifier = Modifier.padding(24.dp)) }
                        if (state.value.truncated) item {
                            Text("Only the first entries are shown.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EntryRow(entry: DirEntry, detail: String?, onClick: () -> Unit) {
    val folder = entry.kind == "dir"
    // Sockets, devices and the like cannot be read; the web disables them too.
    val openable = entry.kind != "other"
    ListItem(
        modifier = Modifier.clickable(enabled = openable, onClick = onClick).alpha(if (openable) 1f else 0.5f),
        leadingContent = {
            Icon(
                if (folder) PircIcons.Folder else PircIcons.File,
                contentDescription = null,
                tint = if (folder) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        },
        headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.MiddleEllipsis) },
        trailingContent = detail?.let { { Text(it, style = MaterialTheme.typography.labelMedium) } },
    )
    HorizontalDivider(Modifier.padding(start = 56.dp))
}
