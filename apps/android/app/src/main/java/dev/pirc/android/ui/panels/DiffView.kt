package dev.pirc.android.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pirc.android.core.DiffLine
import dev.pirc.android.core.parseDiff

private val AddBg = Color(0x332E9E5B)
private val DelBg = Color(0x33D1453B)

/**
 * A unified diff with old/new line numbers and colored lines, laid out lazily
 * (a big diff has thousands of lines) and scrolling sideways as one block.
 * [header] items go above it in the same list.
 */
@Composable
fun DiffView(diff: String, truncated: Boolean, modifier: Modifier = Modifier, header: LazyListScope.() -> Unit = {}) {
    val lines = remember(diff) { parseDiff(diff) }
    val style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 18.sp)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val charWidth = remember(style) { measurer.measure("0", style).size.width }
    val digits = remember(lines) { (lines.maxOfOrNull { maxOf(it.old ?: 0, it.new ?: 0) } ?: 0).toString().length }
    val number = with(density) { (charWidth * (digits + 1)).toDp() }
    val widest = remember(lines) { lines.maxOfOrNull { it.text.length } ?: 0 }
    val width = with(density) { (charWidth * (widest.coerceAtMost(1_000) + 4)).toDp() } + number * 2
    val colors = MaterialTheme.colorScheme

    Box(modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        SelectionContainer {
            LazyColumn(Modifier.requiredWidth(maxOf(width, 360.dp)).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                header()
                if (lines.isEmpty()) item { Text("No changes.", modifier = Modifier.padding(16.dp)) }
                items(lines) { line ->
                    when (line.kind) {
                        DiffLine.Kind.File -> Text(
                            line.text,
                            style = style.copy(fontWeight = FontWeight.Bold, fontSize = 13.sp),
                            modifier = Modifier.fillMaxWidth().background(colors.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                        DiffLine.Kind.Hunk -> Text(
                            line.text,
                            style = style,
                            color = colors.primary,
                            modifier = Modifier.fillMaxWidth().background(colors.surfaceContainerLow).padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                        DiffLine.Kind.Meta -> Text(line.text, style = style, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
                        else -> Row(
                            Modifier.fillMaxWidth().background(
                                when (line.kind) {
                                    DiffLine.Kind.Add -> AddBg
                                    DiffLine.Kind.Del -> DelBg
                                    else -> Color.Transparent
                                },
                            ),
                        ) {
                            DisableSelection {
                                for (value in listOf(line.old, line.new)) Text(
                                    value?.toString().orEmpty(),
                                    style = style,
                                    color = colors.onSurfaceVariant.copy(alpha = 0.6f),
                                    textAlign = TextAlign.End,
                                    modifier = Modifier.width(number).padding(end = 4.dp),
                                )
                                Text(
                                    when (line.kind) {
                                        DiffLine.Kind.Add -> "+"
                                        DiffLine.Kind.Del -> "-"
                                        else -> " "
                                    },
                                    style = style,
                                    modifier = Modifier.padding(horizontal = 6.dp),
                                )
                            }
                            Text(line.text, style = style, softWrap = false)
                        }
                    }
                }
                if (truncated) item {
                    Text("The diff is cut here.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                }
            }
        }
    }
}
