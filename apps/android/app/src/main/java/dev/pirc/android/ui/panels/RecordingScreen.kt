package dev.pirc.android.ui.panels

import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.ui.PircIcons
import java.io.File
import java.io.IOException

private sealed interface Download {
    data object Loading : Download
    data class Ready(val file: File) : Download
    data class Failed(val message: String) : Download
}

/**
 * Plays a browser recording (`.pirc/recordings/<name>.webm`). The file needs the
 * bearer token, so it is downloaded to the cache first, then shown with the
 * platform's VideoView (WebM/VP9 plays natively).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingScreen(
    api: PircApi,
    sessionId: String,
    path: String,
    onUnauthorized: (ApiException) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val download by produceState<Download>(Download.Loading, sessionId, path) {
        val dir = File(context.cacheDir, "recordings").apply { mkdirs() }
        val file = File(dir, "${sessionId.hashCode().toUInt()}-${path.substringAfterLast('/')}")
        value = try {
            if (!file.exists() || file.length() == 0L) {
                val partial = File(dir, "${file.name}.part")
                api.downloadRecording(sessionId, path, partial)
                partial.renameTo(file)
            }
            Download.Ready(file)
        } catch (error: IOException) {
            if (error is ApiException && error.unauthorized) onUnauthorized(error)
            Download.Failed(error.message ?: "Could not download the recording.")
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(PircIcons.Back, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
            when (val current = download) {
                Download.Loading -> CircularProgressIndicator()
                is Download.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
                is Download.Ready -> AndroidView(
                    modifier = Modifier.fillMaxWidth(),
                    factory = { context ->
                        VideoView(context).apply {
                            setMediaController(MediaController(context).also { it.setAnchorView(this) })
                            setVideoPath(current.file.absolutePath)
                            setOnPreparedListener { start() }
                        }
                    },
                    onRelease = { it.stopPlayback() },
                )
            }
        }
    }
}
