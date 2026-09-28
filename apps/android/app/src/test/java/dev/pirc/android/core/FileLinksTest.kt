package dev.pirc.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The same cases as the web's `file-links.test.ts`. */
class FileLinksTest {
    @Test
    fun findsThePathOfAFileLink() {
        for ((href, path) in listOf(
            "src/App.svelte" to "src/App.svelte",
            "./src/App.svelte" to "src/App.svelte",
            "/Users/me/code/pirc/README.md" to "/Users/me/code/pirc/README.md",
            "/Users/me/code/pirc/src/a.ts:42" to "/Users/me/code/pirc/src/a.ts",
            "src/a.ts:42:7" to "src/a.ts",
            "src/a.ts#L10-L20" to "src/a.ts",
            "file:///Users/me/a%20b.ts" to "/Users/me/a b.ts",
            "plans/%E8%A8%88%E5%8A%83.md" to "plans/計劃.md",
            "src/c++/a+b.h" to "src/c++/a+b.h",
        )) assertEquals(href, path, parseFileLink(href)?.path)
    }

    @Test
    fun ignoresEverythingElse() {
        for (href in listOf("https://example.com/a.ts", "mailto:a@b.c", "#heading", "//cdn.example/x.js", "", "src/"))
            assertNull(href, parseFileLink(href))
    }

    @Test
    fun resolvesRelativeLinksAgainstABase() {
        assertEquals("docs/README.md", parseFileLink("../README.md", "docs/guide")?.path)
        assertEquals("docs/img/a.png", parseFileLink("img/a.png", "docs")?.path)
        assertEquals("/abs/x.md", parseFileLink("/abs/x.md", "docs")?.path)
    }

    @Test
    fun readsLineRanges() {
        for ((href, target) in listOf(
            "src/a.ts" to FileTarget("src/a.ts"),
            "src/a.ts:42" to FileTarget("src/a.ts", 42),
            "src/a.ts:42:7" to FileTarget("src/a.ts", 42),
            "src/a.ts:10-20" to FileTarget("src/a.ts", 10, 20),
            "src/a.ts#L10" to FileTarget("src/a.ts", 10),
            "src/a.ts#L10-L20" to FileTarget("src/a.ts", 10, 20),
            "src/a.ts#L10C2-L12C4" to FileTarget("src/a.ts", 10, 12),
            "file:///x/a.ts:3" to FileTarget("/x/a.ts", 3),
        )) assertEquals(href, target, parseFileLink(href))
    }

    @Test
    fun linksBarePaths() {
        for ((source, path) in listOf(
            "see src/lib/a.ts:12 now" to "src/lib/a.ts:12",
            "修改了 apps/web/src/App.svelte。" to "apps/web/src/App.svelte",
            "at /Users/me/pirc/README.md." to "/Users/me/pirc/README.md",
            "(../docs/guide.md)" to "../docs/guide.md",
            ".github/workflows/ci.yml" to ".github/workflows/ci.yml",
        )) assertEquals(source, source.replace(path, "[$path]($path)"), linkifyPaths(source))
    }

    @Test
    fun leavesOtherTextAlone() {
        for (source in listOf(
            "visit https://example.com/a/b.html",
            "visit www.example.com/a.html",
            "ratio 1/2.5 and and/or",
            "plain App.svelte",
            "dir src/lib/ only",
            "run `npm test`, `App.svelte`",
            "[src/c.ts](src/d.ts) and <https://x.dev/a/b.md>",
            "```\nsrc/a.ts\n```",
            "    indented/code.ts",
        )) assertEquals(source, source, linkifyPaths(source))
    }

    @Test
    fun linksInlineCodeThatIsAPath() {
        assertEquals("edit [`src/a.ts:3`](src/a.ts:3)", linkifyPaths("edit `src/a.ts:3`"))
        assertEquals("[`src/a.ts`](src/b.ts)", linkifyPaths("[`src/a.ts`](src/b.ts)"))
        assertEquals("~~~\n`src/a.ts`\n~~~\nthen [`src/b.ts`](src/b.ts)", linkifyPaths("~~~\n`src/a.ts`\n~~~\nthen `src/b.ts`"))
    }
}
