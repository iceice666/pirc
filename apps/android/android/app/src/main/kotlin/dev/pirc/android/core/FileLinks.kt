package dev.pirc.android.core

import java.net.URLDecoder

/*
 * Workspace file links in chat messages; a port of the web's `file-links.ts`.
 * Agents cite files as Markdown links (`[a](/abs/a.ts:42)`, `[x](src/x.ts#L10)`,
 * `file:///…`) or as bare text and inline code (`src/x.ts:10`). Those open
 * the file viewer instead of a browser.
 */

/** A file to show, optionally at a line range (1-based, inclusive). */
data class FileTarget(val path: String, val line: Int? = null, val endLine: Int? = null)

private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)
private val HASH_LINES = Regex("#L(\\d+)(?:C\\d+)?(?:-L?(\\d+)(?:C\\d+)?)?$", RegexOption.IGNORE_CASE)
private val SUFFIX_LINES = Regex(":(\\d+)(?::\\d+|-(\\d+))?$")

private fun decode(value: String) = try {
    URLDecoder.decode(value.replace("+", "%2B"), Charsets.UTF_8)
} catch (_: IllegalArgumentException) {
    value
}

/** Collapse `.` / `..` segments (never above the start of a relative path). */
private fun normalize(path: String): String {
    val absolute = path.startsWith("/")
    val out = ArrayList<String>()
    for (part in path.split('/')) {
        when {
            part.isEmpty() || part == "." -> Unit
            part == ".." && out.isNotEmpty() && out.last() != ".." -> out.removeAt(out.lastIndex)
            part == ".." && absolute -> Unit
            else -> out += part
        }
    }
    return (if (absolute) "/" else "") + out.joinToString("/")
}

private fun lines(start: String?, end: String?): Pair<Int?, Int?> {
    val line = start?.toIntOrNull()?.takeIf { it > 0 } ?: return null to null
    val endLine = end?.toIntOrNull()?.takeIf { it > line }
    return line to endLine
}

/**
 * The file an `href` points at, or null for web links, anchors and other
 * schemes. `:12`, `:12:3`, `:12-20`, `#L12` and `#L12-L20` become a line
 * range. A relative path resolves against [base] (the workspace root for
 * conversation messages).
 */
fun parseFileLink(href: String?, base: String = ""): FileTarget? {
    var value = href.orEmpty().trim()
    if (value.isEmpty() || value.startsWith("#") || value.startsWith("//")) return null
    if (value.startsWith("file:", ignoreCase = true)) value = value.replace(Regex("^file:(//(localhost)?)?", RegexOption.IGNORE_CASE), "")
    else if (SCHEME.containsMatchIn(value)) return null
    val hash = HASH_LINES.find(value)
    value = decode(value.replace(Regex("[?#].*$"), ""))
    val suffix = SUFFIX_LINES.find(value)
    if (suffix != null) value = value.substring(0, suffix.range.first)
    if (value.isEmpty() || value.endsWith("/")) return null
    val path = normalize(if (value.startsWith("/") || base.isEmpty()) value else "$base/$value")
    if (path.isEmpty() || path == "/") return null
    val (line, endLine) = if (hash != null) lines(hash.groupValues[1], hash.groupValues[2].ifEmpty { null })
    else lines(suffix?.groupValues?.get(1), suffix?.groupValues?.get(2)?.ifEmpty { null })
    return FileTarget(path, line, endLine)
}

/**
 * A path written as plain text: optional `/`, `./` or `../`, at least one
 * directory, and a file name with an extension containing a letter (so `1/2.5`
 * or `and/or` stay text), plus an optional `:line` suffix.
 */
private const val FILE_PATH =
    """(?!www\.)(?:/|(?:\.{1,2}/)+)?(?:[\w@+-][\w@.+-]*/|\.[\w@+-][\w@.+-]*/)+[\w@.+-]*\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*(?::\d+(?:[:-]\d+)?)?"""
private val BARE_PATH = Regex("""(?<![\w@.+\-/:~\\])$FILE_PATH(?![\w/])""")
private val CODE_PATH = Regex("^$FILE_PATH$")

/** Inline code, Markdown links/images and autolinks: spans a bare path must not be linked inside. */
private val PROTECTED = Regex("""(`+)(.+?)\1|!?\[[^\]\n]*]\([^)\n]*\)|<[^>\s]+>|https?://\S+""")
private val FENCE = Regex("""^ {0,3}(`{3,}|~{3,})""")

/**
 * Turn bare paths and inline code that is exactly a path into Markdown links,
 * so the renderer makes them tappable. Code blocks, existing links and URLs
 * are left alone.
 */
fun linkifyPaths(markdown: String): String {
    if ('/' !in markdown) return markdown
    var fence: String? = null
    return markdown.lines().joinToString("\n") { line ->
        val opener = FENCE.find(line)?.groupValues?.get(1)
        when {
            fence != null -> {
                if (opener != null && opener[0] == fence!![0] && opener.length >= fence!!.length) fence = null
                line
            }
            opener != null -> {
                fence = opener
                line
            }
            line.startsWith("    ") || line.startsWith("\t") -> line
            else -> linkifyLine(line)
        }
    }
}

private fun linkifyLine(line: String): String {
    val out = StringBuilder()
    var at = 0
    for (span in PROTECTED.findAll(line)) {
        out.append(linkBare(line.substring(at, span.range.first)))
        val code = span.groupValues[2]
        out.append(
            if (span.value.startsWith("`") && CODE_PATH.matches(code.trim())) "[${span.value}](${code.trim()})"
            else span.value,
        )
        at = span.range.last + 1
    }
    out.append(linkBare(line.substring(at)))
    return out.toString()
}

private fun linkBare(text: String) = BARE_PATH.replace(text) { "[${it.value}](${it.value})" }
