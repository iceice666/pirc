package dev.pirc.android.ui.files

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pirc.android.core.FileTarget
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.BoldHighlight
import dev.snipme.highlights.model.ColorHighlight
import dev.snipme.highlights.model.SyntaxLanguage
import dev.snipme.highlights.model.SyntaxThemes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val BY_NAME = mapOf(
    "kt" to SyntaxLanguage.KOTLIN, "kts" to SyntaxLanguage.KOTLIN, "kotlin" to SyntaxLanguage.KOTLIN,
    "java" to SyntaxLanguage.JAVA,
    "ts" to SyntaxLanguage.TYPESCRIPT, "tsx" to SyntaxLanguage.TYPESCRIPT, "mts" to SyntaxLanguage.TYPESCRIPT,
    "cts" to SyntaxLanguage.TYPESCRIPT, "typescript" to SyntaxLanguage.TYPESCRIPT,
    "js" to SyntaxLanguage.JAVASCRIPT, "jsx" to SyntaxLanguage.JAVASCRIPT, "mjs" to SyntaxLanguage.JAVASCRIPT,
    "cjs" to SyntaxLanguage.JAVASCRIPT, "javascript" to SyntaxLanguage.JAVASCRIPT, "svelte" to SyntaxLanguage.JAVASCRIPT,
    "vue" to SyntaxLanguage.JAVASCRIPT, "json" to SyntaxLanguage.JAVASCRIPT, "jsonc" to SyntaxLanguage.JAVASCRIPT,
    "py" to SyntaxLanguage.PYTHON, "python" to SyntaxLanguage.PYTHON,
    "rs" to SyntaxLanguage.RUST, "rust" to SyntaxLanguage.RUST,
    "go" to SyntaxLanguage.GO, "golang" to SyntaxLanguage.GO,
    "c" to SyntaxLanguage.C, "h" to SyntaxLanguage.C,
    "cc" to SyntaxLanguage.CPP, "cpp" to SyntaxLanguage.CPP, "cxx" to SyntaxLanguage.CPP, "hpp" to SyntaxLanguage.CPP, "c++" to SyntaxLanguage.CPP,
    "cs" to SyntaxLanguage.CSHARP, "csharp" to SyntaxLanguage.CSHARP,
    "rb" to SyntaxLanguage.RUBY, "ruby" to SyntaxLanguage.RUBY,
    "swift" to SyntaxLanguage.SWIFT, "php" to SyntaxLanguage.PHP, "dart" to SyntaxLanguage.DART,
    "pl" to SyntaxLanguage.PERL, "perl" to SyntaxLanguage.PERL, "coffee" to SyntaxLanguage.COFFEESCRIPT,
    "sh" to SyntaxLanguage.SHELL, "bash" to SyntaxLanguage.SHELL, "zsh" to SyntaxLanguage.SHELL, "fish" to SyntaxLanguage.SHELL,
    "shell" to SyntaxLanguage.SHELL, "console" to SyntaxLanguage.SHELL, "nix" to SyntaxLanguage.SHELL,
)

/** The highlighter's language for a code fence name (`ts`, `bash`, ...) or a file name. */
fun syntaxFor(nameOrPath: String?): SyntaxLanguage? {
    val name = nameOrPath?.trim()?.lowercase() ?: return null
    return BY_NAME[name] ?: BY_NAME[name.substringAfterLast('/').substringAfterLast('.', "")]
        ?: SyntaxLanguage.getByName(name)
}

/** Highlighting a huge file would stall; beyond this it is shown plain. */
private const val HIGHLIGHT_LIMIT = 300_000
/** Minified one-line files: show the start of an overlong line. */
private const val LINE_LIMIT = 2_000

/** One styled range of the whole text. */
private class Span(val start: Int, val end: Int, val style: SpanStyle)

/**
 * [code] split into lines (overlong ones cut at [LINE_LIMIT]) with [spans]
 * assigned to the lines they cover. Slicing one AnnotatedString per line would
 * filter every span for every line; this touches each span once.
 */
private fun lines(code: String, spans: List<Span>): List<AnnotatedString> {
    val starts = ArrayList<Int>().apply {
        add(0)
        for (index in code.indices) if (code[index] == '\n') add(index + 1)
        // A final newline does not start another line.
        if (size > 1 && last() == code.length) removeAt(size - 1)
    }
    val lineSpans = arrayOfNulls<MutableList<Span>>(starts.size)
    for (span in spans) {
        if (span.end <= span.start) continue
        var line = starts.binarySearch(span.start).let { if (it >= 0) it else -it - 2 }.coerceAtLeast(0)
        while (line < starts.size && starts[line] < span.end) {
            (lineSpans[line] ?: ArrayList<Span>().also { lineSpans[line] = it }).add(span)
            line++
        }
    }
    return starts.mapIndexed { line, start ->
        val end = if (line + 1 < starts.size) starts[line + 1] - 1 else code.length
        val cut = minOf(end, start + LINE_LIMIT)
        buildAnnotatedString {
            append(code, start, cut)
            lineSpans[line]?.forEach { span ->
                val from = maxOf(span.start, start) - start
                val to = minOf(span.end, cut) - start
                if (to > from) addStyle(span.style, from, to)
            }
            if (cut < end) append(" …")
        }
    }
}

/**
 * [code] as lines with syntax colors, all computed off the main thread: first
 * plain (empty until then), then highlighted unless the file is huge.
 */
@Composable
fun rememberHighlightedLines(code: String, language: SyntaxLanguage?): List<AnnotatedString> {
    val dark = isSystemInDarkTheme()
    val highlighted by produceState(emptyList<AnnotatedString>(), code, language, dark) {
        value = withContext(Dispatchers.Default) { lines(code, emptyList()) }
        if (code.length > HIGHLIGHT_LIMIT) return@produceState
        value = withContext(Dispatchers.Default) {
            val highlights = Highlights.Builder()
                .theme(SyntaxThemes.default(darkMode = dark))
                .code(code)
                .let { if (language != null) it.language(language) else it }
                .build()
                .getHighlights()
            val spans = highlights.map { highlight ->
                val style = when (highlight) {
                    is ColorHighlight -> SpanStyle(color = Color(highlight.rgb).copy(alpha = 1f))
                    is BoldHighlight -> SpanStyle(fontWeight = FontWeight.Bold)
                }
                Span(highlight.location.start.coerceIn(0, code.length), highlight.location.end.coerceIn(0, code.length), style)
            }
            lines(code, spans)
        }
    }
    return highlighted
}

/**
 * A source file with line numbers, lazily laid out line by line. Without
 * [wrap], lines never wrap: the whole file scrolls sideways together. The
 * [target] lines are marked and scrolled into view.
 */
@Composable
fun CodeView(content: String, language: SyntaxLanguage?, target: FileTarget?, wrap: Boolean, modifier: Modifier = Modifier) {
    val lines = rememberHighlightedLines(content, language)
    val style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val charWidth = remember(style) { measurer.measure("0", style).size.width }
    val digits = lines.size.toString().length
    val gutter = with(density) { (charWidth * (digits + 1)).toDp() } + 12.dp
    val widest = remember(lines) { lines.maxOfOrNull { it.length } ?: 0 }
    val codeWidth = with(density) { (charWidth * (widest + 2)).toDp() }
    val list = rememberLazyListState()
    val marked = target?.line?.let { first -> first..(target.endLine ?: first) }
    val markColor = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f)

    LaunchedEffect(target, lines.size) {
        val line = target?.line ?: return@LaunchedEffect
        list.scrollToItem((line - 4).coerceIn(0, (lines.size - 1).coerceAtLeast(0)))
    }

    Box(modifier.fillMaxSize().then(if (wrap) Modifier else Modifier.horizontalScroll(rememberScrollState()))) {
        SelectionContainer {
            LazyColumn(
                state = list,
                contentPadding = PaddingValues(vertical = 8.dp),
                modifier = if (wrap) Modifier.fillMaxSize() else Modifier.requiredWidth(gutter + codeWidth).fillMaxSize(),
            ) {
                itemsIndexed(lines) { index, line ->
                    val number = index + 1
                    Row(Modifier.fillMaxWidth().then(if (marked != null && number in marked) Modifier.background(markColor) else Modifier)) {
                        DisableSelection {
                            Text(
                                number.toString(),
                                style = style,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                textAlign = TextAlign.End,
                                modifier = Modifier.width(gutter).padding(end = 12.dp),
                            )
                        }
                        Text(line, style = style, softWrap = wrap, modifier = if (wrap) Modifier.weight(1f).padding(end = 8.dp) else Modifier)
                    }
                }
            }
        }
    }
}
