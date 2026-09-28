package dev.pirc.android.ui.files

import android.content.ClipData
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.FileViewModel
import dev.pirc.android.Loadable
import dev.pirc.android.core.FileTarget
import dev.pirc.android.core.parseFileLink
import dev.pirc.android.ui.PircIcons
import dev.pirc.android.ui.session.MarkdownText
import kotlinx.coroutines.launch

/**
 * One workspace file: highlighted source with line numbers (wrapping on
 * request), or rendered Markdown. [target] lines are marked and scrolled to;
 * links in rendered Markdown open other files relative to this one.
 */
private val MARKDOWN_EXTENSIONS = listOf(".md", ".markdown", ".mdx")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileScreen(viewModel: FileViewModel, target: FileTarget?, onOpenFile: (FileTarget) -> Unit, onBack: () -> Unit) {
    val state by viewModel.file.collectAsStateWithLifecycle()
    val markdown = MARKDOWN_EXTENSIONS.any { viewModel.path.endsWith(it, ignoreCase = true) }
    var preview by rememberSaveable { mutableStateOf(markdown && target?.line == null) }
    var wrap by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val file = (state as? Loadable.Ready)?.value
    val copy = { label: String, text: String -> scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(label, text))) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(viewModel.path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            file?.let {
                                listOfNotNull(
                                    it.path.substringBeforeLast('/', "").ifEmpty { null },
                                    Formatter.formatShortFileSize(context, it.size),
                                    DateUtils.getRelativeTimeSpanString(it.modifiedAt.toLong()).toString(),
                                ).joinToString(" · ")
                            } ?: viewModel.path,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.StartEllipsis,
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
                actions = {
                    if (markdown) TextButton(onClick = { preview = !preview }) { Text(if (preview) "Source" else "Preview") }
                    TextButton(onClick = { menu = true }) { Text("More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (!preview) DropdownMenuItem(text = { Text(if (wrap) "Don't wrap lines" else "Wrap lines") }, onClick = {
                            wrap = !wrap
                            menu = false
                        })
                        DropdownMenuItem(text = { Text("Copy path") }, onClick = {
                            copy("path", file?.path ?: viewModel.path)
                            menu = false
                        })
                        file?.content?.let { content ->
                            DropdownMenuItem(text = { Text("Copy contents") }, onClick = {
                                copy(viewModel.path, content)
                                menu = false
                            })
                        }
                        DropdownMenuItem(text = { Text("Reload") }, onClick = {
                            viewModel.load()
                            menu = false
                        })
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (val current = state) {
                Loadable.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                is Loadable.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.align(Alignment.Center).padding(24.dp))
                is Loadable.Ready -> {
                    val content = current.value.content
                    Column(Modifier.fillMaxSize()) {
                        if (current.value.truncated) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                            Text("Only the first 1 MiB is shown.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                        }
                        when {
                            current.value.binary || content == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("Binary file: not shown.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            preview -> {
                                // Relative links in a document resolve against its folder.
                                val folder = current.value.path.substringBeforeLast('/', "")
                                val browser = LocalUriHandler.current
                                val handler = remember(folder, browser) {
                                    object : UriHandler {
                                        override fun openUri(uri: String) {
                                            parseFileLink(uri, folder)?.let(onOpenFile) ?: browser.openUri(uri)
                                        }
                                    }
                                }
                                CompositionLocalProvider(LocalUriHandler provides handler) {
                                    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) { MarkdownText(content, linkPaths = false) }
                                }
                            }
                            else -> CodeView(content, syntaxFor(current.value.path), target, wrap)
                        }
                    }
                }
            }
        }
    }
}
