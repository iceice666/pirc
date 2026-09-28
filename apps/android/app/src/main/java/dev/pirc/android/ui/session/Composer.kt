package dev.pirc.android.ui.session

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Attachment
import dev.pirc.android.Connection
import dev.pirc.android.Delivery
import dev.pirc.android.SessionViewModel
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.THINKING_LEVELS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val THINKING_LABELS = mapOf(
    "off" to "No thinking",
    "minimal" to "Minimal",
    "low" to "Low",
    "medium" to "Medium",
    "high" to "High",
    "xhigh" to "Extra high",
)

/**
 * The bottom bar: control state, attachments, the message field, model and
 * thinking choices, and send/stop. It rides on the keyboard (the caller
 * applies `imePadding`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Composer(viewModel: SessionViewModel, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val control by viewModel.control.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val draft by viewModel.draft.collectAsStateWithLifecycle()
    val attachments by viewModel.attachments.collectAsStateWithLifecycle()
    val delivery by viewModel.delivery.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val actionError by viewModel.actionError.collectAsStateWithLifecycle()
    val models by viewModel.models.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sheet by remember { mutableStateOf<String?>(null) }

    val active = viewModel.runActive(state)
    val stopping = state?.run?.status == "stopping"
    val live = connection == Connection.Live
    val hasControl = control.heldByCurrentClient
    val canSend = hasControl && live && !busy && draft.isNotBlank() && attachments.none { it.uploading }
    val showStop = active && draft.isBlank() && !busy

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        scope.launch {
            for (uri in uris) {
                val image = withContext(Dispatchers.IO) { runCatching { readImage(context, uri) }.getOrNull() }
                if (image != null) viewModel.attach(image.name, image.mimeType, image.bytes)
            }
        }
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.animateContentSize().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            actionError?.let { message ->
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 12.dp)) {
                        Text(message, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        TextButton(onClick = viewModel::dismissActionError) { Text("OK") }
                    }
                }
            }
            AnimatedVisibility(visible = !hasControl) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (control.free) "Getting control…" else "Another device controls this session.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    if (!control.free) TextButton(onClick = viewModel::takeControl) { Text("Take control") }
                }
            }
            if (attachments.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(attachments, key = { it.localId }) { AttachmentThumb(it) { viewModel.removeAttachment(it.localId) } }
            }
            TextField(
                value = draft,
                onValueChange = viewModel::setDraft,
                placeholder = {
                    Text(
                        when {
                            !hasControl -> "Take control to send a message"
                            !active -> "Tell the agent what to work on…"
                            delivery == Delivery.Steer -> "Steer the current run…"
                            else -> "Queue what should happen next…"
                        },
                    )
                },
                maxLines = 6,
                shape = MaterialTheme.shapes.large,
                colors = TextFieldDefaults.colors(
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                ),
                textStyle = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                    Text("＋ Image")
                }
                AssistChip(
                    onClick = { sheet = "model" },
                    enabled = !active,
                    label = { Text(viewModel.selectedModel(state)?.displayName ?: "Model", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.weight(1f, fill = false),
                )
                AssistChip(onClick = { sheet = "thinking" }, label = { Text(THINKING_LABELS[state?.thinkingLevel ?: "medium"] ?: "Thinking") })
                Spacer(Modifier.weight(1f))
                if (showStop) FilledIconButton(
                    onClick = viewModel::stopRun,
                    enabled = hasControl && !stopping,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.size(48.dp),
                ) {
                    if (stopping) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onError)
                    else Text("■", color = MaterialTheme.colorScheme.onError)
                } else FilledIconButton(onClick = viewModel::send, enabled = canSend, modifier = Modifier.size(48.dp)) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("↑", style = MaterialTheme.typography.titleLarge)
                }
            }
            AnimatedVisibility(visible = active) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                        Delivery.entries.forEachIndexed { index, option ->
                            SegmentedButton(
                                selected = delivery == option,
                                onClick = { viewModel.setDelivery(option) },
                                shape = SegmentedButtonDefaults.itemShape(index, Delivery.entries.size),
                            ) { Text(if (option == Delivery.Steer) "Steer now" else "Queue next") }
                        }
                    }
                    if (!showStop) TextButton(onClick = viewModel::stopRun, enabled = hasControl && !stopping) { Text("Stop") }
                }
            }
        }
    }

    when (sheet) {
        "model" -> ModalBottomSheet(onDismissRequest = { sheet = null }) {
            ChoiceList(
                title = "Model",
                items = models,
                label = { it.displayName },
                detail = { it.provider },
                selected = { it == viewModel.selectedModel(state) },
            ) { model: ModelOption ->
                viewModel.selectModel(model)
                sheet = null
            }
        }
        "thinking" -> ModalBottomSheet(onDismissRequest = { sheet = null }) {
            val levels = viewModel.selectedModel(state)?.thinkingLevels ?: THINKING_LEVELS
            ChoiceList(
                title = "Thinking",
                items = levels,
                label = { THINKING_LABELS[it] ?: it },
                detail = { null },
                selected = { it == (state?.thinkingLevel ?: "medium") },
            ) { level: String ->
                viewModel.selectThinking(level)
                sheet = null
            }
        }
    }
}

@Composable
private fun <T> ChoiceList(
    title: String,
    items: List<T>,
    label: (T) -> String,
    detail: (T) -> String?,
    selected: (T) -> Boolean,
    onPick: (T) -> Unit,
) {
    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
    LazyColumn(Modifier.padding(bottom = 24.dp)) {
        items(items) { item ->
            ListItem(
                headlineContent = { Text(label(item)) },
                supportingContent = detail(item)?.let { { Text(it) } },
                trailingContent = if (selected(item)) ({ Text("✓", color = MaterialTheme.colorScheme.primary) }) else null,
                modifier = Modifier.clickable { onPick(item) },
            )
        }
        if (items.isEmpty()) item { Text("Nothing to choose from yet.", modifier = Modifier.padding(24.dp)) }
    }
}

@Composable
private fun AttachmentThumb(attachment: Attachment, onRemove: () -> Unit) {
    val bitmap = remember(attachment.localId) {
        runCatching {
            val options = BitmapFactory.Options().apply { inSampleSize = 4 }
            BitmapFactory.decodeByteArray(attachment.bytes, 0, attachment.bytes.size, options)?.asImageBitmap()
        }.getOrNull()
    }
    Box(Modifier.size(72.dp).clip(MaterialTheme.shapes.medium)) {
        if (bitmap != null) Image(bitmap, contentDescription = attachment.name, contentScale = ContentScale.Crop, modifier = Modifier.size(72.dp))
        if (attachment.uploading) CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), strokeWidth = 2.dp)
        Surface(
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).clickable(onClick = onRemove),
        ) { Text("✕", modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)) }
    }
}
