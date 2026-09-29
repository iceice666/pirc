package dev.pirc.android.ui.session

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Attachment
import dev.pirc.android.Connection
import dev.pirc.android.core.Connectivity
import dev.pirc.android.SessionViewModel
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.THINKING_LEVELS
import dev.pirc.android.ui.PircIcons
import dev.pirc.android.ui.WheelPicker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
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
 * The message card at the bottom, after ChatGPT's: the field on top, then
 * attach, the model and thinking level as one label, and send (stop while a
 * run is active and nothing is typed; a separate stop beside send once text
 * is typed). The caller makes it ride the keyboard.
 */
@OptIn(FlowPreview::class)
@Composable
fun Composer(viewModel: SessionViewModel, modifier: Modifier = Modifier, chat: Boolean = false) {
    // Only the fields shown here: streamed text must not recompose the composer.
    val settings by viewModel.composerSettings.collectAsStateWithLifecycle()
    val control by viewModel.control.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val online by Connectivity.online.collectAsStateWithLifecycle()
    val docks by viewModel.docks.collectAsStateWithLifecycle()
    // The field owns its text, so fast typing and IME composition (Zhuyin,
    // kana) never wait on a round trip; the view model hears about it debounced.
    val field = rememberTextFieldState(viewModel.initialDraft)
    val blank by remember { derivedStateOf { field.text.isBlank() } }
    LaunchedEffect(field) {
        snapshotFlow { field.text.toString() }.debounce(300).collect(viewModel::setDraft)
    }
    LaunchedEffect(field) {
        viewModel.draftResets.collect { text ->
            if (text.isEmpty()) field.clearText() else field.setTextAndPlaceCursorAtEnd(text)
        }
    }
    // Leaving within the debounce window must not lose the last keystrokes.
    DisposableEffect(field) { onDispose { viewModel.setDraft(field.text.toString()) } }
    val attachments by viewModel.attachments.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val actionError by viewModel.actionError.collectAsStateWithLifecycle()
    val models by viewModel.models.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }

    val active = viewModel.runActive(settings)
    val stopping = settings.runStatus == "stopping"
    val hasControl = control.heldByCurrentClient
    val canSend = hasControl && connection == Connection.Live && !busy && !blank && attachments.none { it.uploading }
    val showStop = active && blank
    // Commands need the stream up; taps while reconnecting would only fail.
    val canStop = hasControl && connection == Connection.Live && !stopping
    val model = viewModel.selectedModel(settings)
    val level = viewModel.thinkingLevel(settings)

    // Any file type, not just photos: the system document picker also offers
    // the Photos provider, so it replaces the old image-only picker.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        scope.launch {
            for (uri in uris) {
                val mime = context.contentResolver.getType(uri) ?: ""
                withContext(Dispatchers.IO) {
                    if (mime.startsWith("image/")) runCatching { readImage(context, uri) }.getOrNull()
                        ?.let { viewModel.attach(it.name, it.mimeType, it.bytes) }
                    else runCatching { readFile(context, uri) }.getOrNull()
                        ?.let { viewModel.attach(it.name, it.mimeType, it.bytes) }
                }
            }
        }
    }

    Column(
        // No animateContentSize here: it clips, and would cut off the card's shadow.
        modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        actionError?.let { message ->
            Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 14.dp)) {
                    Text(message, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = viewModel::dismissActionError) { Text("OK") }
                }
            }
        }
        AnimatedVisibility(visible = !online) {
            Text(
                "You're offline. This draft is saved on this phone and is never sent automatically.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 8.dp),
            )
        }
        AnimatedVisibility(visible = !hasControl && online) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 8.dp)) {
                Text(
                    if (control.free) "Getting control…" else "Another device controls this session.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (!control.free) TextButton(onClick = viewModel::takeControl) { Text("Take control") }
            }
        }

        DockStack(docks, canAct = hasControl && connection == Connection.Live && !busy, onGoal = viewModel::goalAction)
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
            shadowElevation = 3.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.animateContentSize().padding(6.dp)) {
                if (attachments.isNotEmpty()) LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                ) {
                    items(attachments, key = { it.localId }) { AttachmentThumb(it) { viewModel.removeAttachment(it.localId) } }
                }
                val hint = when {
                    !online -> "Offline draft — it stays on this phone"
                    connection == Connection.Reconnecting || connection == Connection.Stopped -> "Reconnecting… your draft is kept"
                    !hasControl -> "Take control to send a message"
                    !active -> "Message pirc"
                    else -> "Steer the current run"
                }
                BasicTextField(
                    state = field,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 8),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 14.dp, vertical = 12.dp),
                    decorator = { inner ->
                        Box {
                            if (field.text.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            inner()
                        }
                    },
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = { picker.launch(arrayOf("*/*")) },
                        modifier = Modifier.size(48.dp),
                    ) { Icon(PircIcons.Plus, contentDescription = "Attach files", modifier = Modifier.size(26.dp)) }
                    // All the room between the buttons; a long name shrinks to fit instead of being cut.
                    Row(
                        Modifier
                            .weight(1f)
                            .clip(MaterialTheme.shapes.large)
                            .clickable { picking = true }
                            .padding(horizontal = 8.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val nameStyle = MaterialTheme.typography.titleSmall
                        BasicText(
                            model?.displayName ?: "Model",
                            style = nameStyle.copy(color = MaterialTheme.colorScheme.onSurface),
                            maxLines = 1,
                            autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = nameStyle.fontSize),
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Text(
                            " " + (THINKING_LABELS[level] ?: level),
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                    // Typing mid-run turns the main button into Send (a steer); stopping stays one tap away.
                    if (active && !blank) IconButton(onClick = viewModel::stopRun, enabled = canStop && !busy, modifier = Modifier.size(48.dp)) {
                        Icon(PircIcons.Stop, contentDescription = "Stop run", modifier = Modifier.size(22.dp))
                    }
                    SendButton(showStop = showStop, stopping = stopping, busy = busy, canSend = canSend, canStop = canStop,
                        onSend = { viewModel.send(field.text.toString()) }, onStop = viewModel::stopRun)
                }
            }
        }
        // Extension status lines are engineering detail; a chat leaves them out.
        if (!chat) StatusLine(docks.statusLine)
    }

    if (picking) ModelSheet(
        models = models,
        model = model,
        level = level,
        modelLocked = active,
        onDone = { chosenModel, chosenLevel ->
            picking = false
            viewModel.selectSettings(chosenModel, chosenLevel)
        },
        onDismiss = { picking = false },
    )
}

@Composable
private fun SendButton(showStop: Boolean, stopping: Boolean, busy: Boolean, canSend: Boolean, canStop: Boolean, onSend: () -> Unit, onStop: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val enabled = if (showStop) canStop else canSend
    val container by animateColorAsState(if (enabled) colors.onSurface else colors.surfaceContainerHighest, label = "send")
    val content = if (enabled) colors.surface else colors.onSurfaceVariant
    Box(
        Modifier
            .padding(end = 2.dp)
            .size(44.dp)
            .clip(CircleShape)
            .background(container)
            .clickable(enabled = enabled, onClick = if (showStop) onStop else onSend),
        contentAlignment = Alignment.Center,
    ) {
        AnimatedContent(targetState = Triple(showStop, stopping, busy), transitionSpec = { (fadeIn() + scaleIn()) togetherWith (fadeOut() + scaleOut()) }, label = "send-icon") { (stop, isStopping, isBusy) ->
            when {
                isBusy || isStopping -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = content)
                stop -> Icon(PircIcons.Stop, contentDescription = "Stop run", tint = content, modifier = Modifier.size(22.dp))
                else -> Icon(PircIcons.ArrowUp, contentDescription = "Send", tint = content, modifier = Modifier.size(22.dp))
            }
        }
    }
}

/** Model and thinking level on two wheels, like a date picker's day and month. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSheet(
    models: List<ModelOption>,
    model: ModelOption?,
    level: String,
    modelLocked: Boolean,
    onDone: (ModelOption?, String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var modelIndex by remember { mutableIntStateOf(models.indexOf(model).coerceAtLeast(0)) }
    val chosen = models.getOrNull(modelIndex)
    val levels = chosen?.thinkingLevels ?: THINKING_LEVELS
    var chosenLevel by remember { mutableStateOf(level) }
    // Another model may not offer the level: fall back to its nearest one.
    val shownLevel = if (chosenLevel in levels) chosenLevel else levels.lastOrNull { THINKING_LEVELS.indexOf(it) <= THINKING_LEVELS.indexOf(chosenLevel) } ?: levels.first()
    val duplicates = models.groupBy { it.displayName }.filterValues { it.size > 1 }.keys

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Model", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                Button(onClick = { onDone(chosen, shownLevel) }) { Text("Done") }
            }
            if (modelLocked) Text(
                "The model can change after this run. The thinking level applies to the next turn.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (models.isEmpty()) Text("No models yet. The gateway's list is still loading.", style = MaterialTheme.typography.bodyLarge)
            else Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 16.dp)) {
                WheelPicker(
                    items = models,
                    selected = modelIndex,
                    onSelect = { modelIndex = it },
                    label = { if (it.displayName in duplicates) "${it.displayName} · ${it.provider}" else it.displayName },
                    enabled = !modelLocked,
                    modifier = Modifier.weight(3f),
                )
                WheelPicker(
                    items = levels,
                    selected = levels.indexOf(shownLevel),
                    onSelect = { chosenLevel = levels[it] },
                    label = { THINKING_LABELS[it] ?: it },
                    modifier = Modifier.weight(2f),
                )
            }
        }
    }
}

@Composable
private fun AttachmentThumb(attachment: Attachment, onRemove: () -> Unit) {
    val isImage = attachment.kind == "image"
    val bitmap = if (isImage) rememberDecodedImage(attachment.localId, 64.dp, 64.dp) { attachment.bytes } else null
    Box(Modifier.size(64.dp).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
        if (bitmap != null) Image(bitmap, contentDescription = attachment.name, contentScale = ContentScale.Crop, modifier = Modifier.size(64.dp))
        else if (!isImage) Column(
            Modifier.fillMaxWidth().padding(6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(PircIcons.File, contentDescription = null, modifier = Modifier.size(22.dp))
            Text(attachment.name, style = MaterialTheme.typography.labelSmall, maxLines = 2, modifier = Modifier.padding(top = 2.dp))
        }
        if (attachment.uploading) CircularProgressIndicator(Modifier.align(Alignment.Center).size(22.dp), strokeWidth = 2.dp)
        // A small mark, but a 40dp target (most of the thumbnail's corner).
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .size(40.dp)
                .clickable(role = Role.Button, onClick = onRemove),
            contentAlignment = Alignment.TopEnd,
        ) {
            Box(
                Modifier
                    .padding(4.dp)
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)),
                contentAlignment = Alignment.Center,
            ) { Icon(PircIcons.Close, contentDescription = "Remove ${attachment.name}", tint = MaterialTheme.colorScheme.surface, modifier = Modifier.size(14.dp)) }
        }
    }
}
