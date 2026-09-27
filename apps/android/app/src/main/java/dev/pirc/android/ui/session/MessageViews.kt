package dev.pirc.android.ui.session

import android.content.ClipData
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownHighlightedCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownHighlightedCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.model.rememberMarkdownState
import dev.pirc.android.core.timeline.InlineImage
import dev.pirc.android.core.timeline.Message
import kotlinx.coroutines.launch

/** Markdown with highlighted, copyable code blocks that scroll sideways instead of wrapping. */
@Composable
fun MarkdownText(content: String, modifier: Modifier = Modifier) {
    val components = remember {
        markdownComponents(
            codeFence = { MarkdownHighlightedCodeFence(it.content, it.node, it.typography.code, showHeader = true) },
            codeBlock = { MarkdownHighlightedCodeBlock(it.content, it.node, it.typography.code, showHeader = true) },
        )
    }
    // retainState: while a reply streams, keep the last rendering instead of flashing empty.
    val state = rememberMarkdownState(content, retainState = true)
    Markdown(markdownState = state, components = components, modifier = modifier.fillMaxWidth())
}

@Composable
fun MessageView(message: Message, modifier: Modifier = Modifier) {
    when (message.role) {
        "user" -> UserMessage(message, modifier)
        "assistant" -> AssistantMessage(message, modifier)
        else -> SystemEntry(message, modifier)
    }
}

@Composable
private fun UserMessage(message: Message, modifier: Modifier) {
    Row(modifier.fillMaxWidth().padding(start = 48.dp), horizontalArrangement = Arrangement.End) {
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Images(message.images)
            if (message.content.isNotEmpty()) Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp),
            ) {
                SelectionContainer {
                    Text(message.content, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
                }
            }
            CopyButton(message.content)
        }
    }
}

@Composable
private fun AssistantMessage(message: Message, modifier: Modifier) {
    Column(modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!message.thinking.isNullOrEmpty() || message.thinkingRedacted)
            Thinking(message.thinking.orEmpty(), live = message.isPartial && message.content.isEmpty())
        if (message.content.isNotEmpty()) SelectionContainer { MarkdownText(message.content) }
        Images(message.images)
        for (tool in message.tools) ToolCard(tool)
        if (message.stopReason != null) Surface(
            color = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
            shape = MaterialTheme.shapes.small,
        ) {
            Text(
                if (message.stopReason == "aborted") "Stopped" else message.errorMessage ?: "The turn failed.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        if (message.isPartial && message.content.isEmpty() && message.tools.isEmpty() && message.thinking.isNullOrEmpty()) TypingDots()
        if (!message.isPartial && message.content.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
            CopyButton(message.content)
            message.model?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Thinking(text: String, live: Boolean) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column {
        Text(
            if (live) "Thinking…" else if (open) "Hide thinking" else "Show thinking",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(MaterialTheme.shapes.small).clickable { open = !open }.padding(vertical = 6.dp, horizontal = 4.dp),
        )
        AnimatedVisibility(visible = open) {
            SelectionContainer {
                Text(
                    text.ifEmpty { "The model's reasoning is redacted." },
                    style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun SystemEntry(message: Message, modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    if (message.systemKind == "notice") {
        val accent = when (message.level) {
            "error" -> colors.error
            "warning" -> colors.tertiary
            else -> colors.outline
        }
        Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(3.dp).height(20.dp).background(accent, RoundedCornerShape(2.dp)))
            SelectionContainer {
                Text(message.content, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 10.dp))
            }
        }
        return
    }
    var open by rememberSaveable { mutableStateOf(false) }
    val bash = message.systemKind == "bash"
    Surface(color = colors.surfaceContainerLow, shape = MaterialTheme.shapes.medium, modifier = modifier.fillMaxWidth().animateContentSize()) {
        Column {
            Row(
                Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (bash) "$ ${message.label.orEmpty()}" else message.label.orEmpty(),
                    style = if (bash) MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.labelLarge,
                    color = if (message.level == "warning") colors.tertiary else colors.onSurface,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
                message.meta?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant, maxLines = 1) }
            }
            AnimatedVisibility(visible = open) {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (bash) CodePane("Output", androidx.compose.ui.text.AnnotatedString(message.content))
                    else if (message.content.isNotEmpty()) SelectionContainer { MarkdownText(message.content) }
                    Images(message.images)
                    for (tool in message.tools) ToolCard(tool)
                }
            }
        }
    }
}

@Composable
private fun Images(images: List<InlineImage>) {
    for (image in images) {
        val bitmap = remember(image.base64) {
            runCatching {
                val bytes = Base64.decode(image.base64, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()
        } ?: continue
        Image(
            bitmap,
            contentDescription = "Attached image",
            contentScale = ContentScale.Fit,
            modifier = Modifier.widthIn(max = 280.dp).heightIn(max = 320.dp).clip(MaterialTheme.shapes.medium),
        )
    }
}

@Composable
private fun CopyButton(text: String) {
    if (text.isEmpty()) return
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    TextButton(onClick = {
        scope.launch {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("pirc message", text)))
            copied = true
        }
    }) { Text(if (copied) "Copied" else "Copy", style = MaterialTheme.typography.labelMedium) }
}

@Composable
private fun TypingDots() {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 8.dp)) {
        repeat(3) { index ->
            val alpha by transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = index * 150), RepeatMode.Reverse),
                label = "dot$index",
            )
            Box(Modifier.size(8.dp).alpha(alpha).background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
        }
    }
}
