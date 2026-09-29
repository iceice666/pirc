package dev.pirc.android.ui.session

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.pirc.android.ui.PircIcons
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.compositionLocalOf
import dev.pirc.android.core.WriteBlock
import dev.pirc.android.core.writeBlock
import dev.pirc.android.core.FileTarget
import dev.pirc.android.core.parseFileLink
import dev.pirc.android.core.timeline.ToolCall
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val prettyJson = Json { prettyPrint = true }

/** Opens a workspace file in the viewer; provided by the session screen. */
val LocalFileOpener = staticCompositionLocalOf<((FileTarget) -> Unit)?> { null }

/** Plays a browser recording (`.pirc/recordings/<name>.webm`) of the session. */
val LocalRecordingOpener = staticCompositionLocalOf<((String) -> Unit)?> { null }

/**
 * Opens the session a blocked write names, given its name; null when that
 * session is unknown (or is this one). Provided by the session screen.
 */
val LocalWriteBlockOpener = compositionLocalOf<(String) -> (() -> Unit)?> { { null } }

/** The file a call works on (`read`, `write`, `edit`, ...), if its input names one. */
internal fun toolFile(tool: ToolCall): FileTarget? {
    val input = tool.input as? JsonObject ?: return null
    val path = listOf("path", "file_path", "filePath").firstNotNullOfOrNull { key ->
        (input[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    } ?: return null
    return parseFileLink(path)
}

/** Long outputs are cut until the reader asks for all of it. */
private const val OUTPUT_PREVIEW = 4_000

/** The detail that identifies a call at a glance: a command, a path, or the first string argument. */
internal fun toolSummary(tool: ToolCall): String {
    val input = tool.input
    if (input is JsonPrimitive) return input.content
    if (input !is JsonObject) return ""
    for (key in listOf("command", "path", "file_path", "pattern", "query", "url", "description", "name"))
        (input[key] as? JsonPrimitive)?.takeIf { it.isString }?.let { return it.content }
    return input.values.firstNotNullOfOrNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content } ?: ""
}

private fun pretty(input: JsonElement?): String? = when (input) {
    null -> null
    is JsonPrimitive -> input.content
    else -> prettyJson.encodeToString(JsonElement.serializer(), input)
}

@Composable
fun ToolCard(tool: ToolCall, modifier: Modifier = Modifier) {
    var open by rememberSaveable(tool.id) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    Surface(
        color = colors.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { open = !open }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusMark(tool.status)
                Text(tool.title ?: tool.name, style = MaterialTheme.typography.labelLarge)
                Text(
                    toolSummary(tool),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            // A write refused for another session's lease: say who, and link there. No retry.
            writeBlock(tool)?.let { block -> WriteBlockNotice(block, LocalWriteBlockOpener.current(block.holderName)) }
            // A browser recording stays one tap away, even collapsed.
            val playRecording = LocalRecordingOpener.current
            tool.recording?.let { path ->
                if (playRecording != null) TextButton(onClick = { playRecording(path) }, modifier = Modifier.padding(start = 4.dp)) {
                    Text("Play recording ${path.substringAfterLast('/')}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            AnimatedVisibility(visible = open) {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    pretty(tool.input)?.takeIf { it.isNotEmpty() }?.let { CodePane("Input", AnnotatedString(it)) }
                    tool.diff?.let { CodePane("Diff", diffText(it)) }
                    tool.output?.let { output -> OutputPane(output) }
                    // Screenshots and other images a tool returned.
                    if (tool.images.isNotEmpty()) Images(tool.images)
                    if (tool.input == null && tool.output == null && tool.diff == null && tool.images.isEmpty())
                        Text("No details yet.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
                    val opener = LocalFileOpener.current
                    val file = toolFile(tool)
                    if (opener != null && file != null) TextButton(onClick = { opener(file) }) { Text("Open ${file.path.substringAfterLast('/')}") }
                }
            }
        }
    }
}

@Composable
private fun WriteBlockNotice(block: WriteBlock, open: (() -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    Surface(
        color = colors.errorContainer,
        contentColor = colors.onErrorContainer,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
    ) {
        Column(Modifier.padding(start = 12.dp, top = 8.dp, end = 4.dp, bottom = if (open == null) 8.dp else 0.dp)) {
            Text("Write blocked — ${block.holderName} is writing to this workspace", style = MaterialTheme.typography.bodyMedium)
            Text(
                "${block.path} stays locked until that session's run finishes.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.onErrorContainer.copy(alpha = 0.8f),
            )
            if (open != null) TextButton(onClick = open, modifier = Modifier.align(Alignment.End)) {
                Text("Open ${block.holderName}", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
internal fun StatusMark(status: String) {
    val colors = MaterialTheme.colorScheme
    Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
        when (status) {
            "running" -> CircularProgressIndicator(Modifier.size(14.dp).semantics { contentDescription = "Running" }, strokeWidth = 2.dp)
            "failed" -> Icon(PircIcons.Close, contentDescription = "Failed", tint = colors.error, modifier = Modifier.size(16.dp))
            else -> Icon(PircIcons.Check, contentDescription = "Succeeded", tint = colors.primary, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun OutputPane(output: String) {
    var all by rememberSaveable { mutableStateOf(false) }
    val cut = !all && output.length > OUTPUT_PREVIEW
    CodePane("Output", AnnotatedString(if (cut) output.take(OUTPUT_PREVIEW) + "\n…" else output))
    if (cut) TextButton(onClick = { all = true }) { Text("Show all ${output.length} characters") }
}

/** Monospace, never wrapped: scrolls sideways, and at most a screenful tall. */
@Composable
fun CodePane(label: String, text: AnnotatedString, modifier: Modifier = Modifier, maxHeight: Dp = 420.dp) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = MaterialTheme.shapes.small) {
            SelectionContainer {
                Text(
                    text,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp),
                    softWrap = false,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = maxHeight)
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState())
                        .padding(10.dp),
                )
            }
        }
    }
}

private val Added = Color(0xFF2E9E5B)
private val Removed = Color(0xFFD1453B)

internal fun diffText(diff: String): AnnotatedString = buildAnnotatedString {
    diff.lineSequence().forEachIndexed { index, line ->
        if (index > 0) append('\n')
        val color = when {
            line.startsWith("+++") || line.startsWith("---") -> null
            line.startsWith("+") -> Added
            line.startsWith("-") -> Removed
            line.startsWith("@@") -> Color(0xFF6B7FD7)
            else -> null
        }
        if (color == null) append(line) else withStyle(SpanStyle(color = color)) { append(line) }
    }
}
