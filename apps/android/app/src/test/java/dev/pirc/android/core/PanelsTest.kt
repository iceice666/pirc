package dev.pirc.android.core

import dev.pirc.android.controlKey
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanelsTest {
    @Test
    fun parsesAUnifiedDiffLikeTheWeb() {
        val diff = """
            diff --git a/src/a.ts b/src/a.ts
            index 1..2 100644
            --- a/src/a.ts
            +++ b/src/a.ts
            @@ -3,3 +3,4 @@ export
             keep
            -old
            +new
            +more
            \ No newline at end of file
        """.trimIndent() + "\n"
        val lines = parseDiff(diff)
        assertEquals(
            listOf(
                DiffLine(DiffLine.Kind.File, "src/a.ts"),
                DiffLine(DiffLine.Kind.Hunk, "@@ -3,3 +3,4 @@ export"),
                DiffLine(DiffLine.Kind.Context, "keep", 3, 3),
                DiffLine(DiffLine.Kind.Del, "old", old = 4),
                DiffLine(DiffLine.Kind.Add, "new", new = 4),
                DiffLine(DiffLine.Kind.Add, "more", new = 5),
                DiffLine(DiffLine.Kind.Meta, "\\ No newline at end of file"),
            ),
            lines,
        )
    }

    @Test
    fun mapsCtrlChords() {
        assertEquals("\u0003", controlKey("c"))
        assertEquals("\u0003", controlKey("C"))
        assertEquals("\u001b", controlKey("["))
        assertEquals("1", controlKey("1"))
        assertEquals("ab", controlKey("ab"))
    }

    @Test
    fun readsPanelsAndManagesSessions() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "f".repeat(43)))
            server.enqueue(
                MockResponse.Builder().body(
                    """{"repo":true,"root":"/w","branch":"main","upstream":"origin/main","ahead":1,"behind":0,
                       "files":[{"path":"a.ts","index":"M","worktree":" "},{"path":"n.ts","index":"?","worktree":"?"}],"truncated":false}""",
                ).build(),
            )
            server.enqueue(MockResponse.Builder().body("""{"repo":false}""").build())
            server.enqueue(MockResponse.Builder().body("""{"diff":"","truncated":false}""").build())
            server.enqueue(
                MockResponse.Builder().body(
                    """{"agentRunning":true,"memory":{"enabled":true,"passive":false,
                       "thresholds":{"observation":{"value":5,"max":10},"reflection":{"value":0,"max":20},"compaction":{"value":1.5,"max":81},"visiblePool":{"value":0,"max":1},"activePool":{"value":0,"max":1}},
                       "counts":{"observations":2},"observations":[{"id":"o1","content":"x","timestamp":"t","relevance":"high","tokenCount":3,"dropped":false,"visible":true}],
                       "reflections":[],"lastCompactionAt":1790000000000},
                       "memoryRuntime":{"phase":null,"autoCompacting":false,"rateLimited":[],"lastErrors":{}},
                       "backgroundTasks":[{"id":"b1","command":"bun test","cwd":"/w","status":"running","pid":7,"exited":false,"startedAt":"2026-01-01T00:00:00Z","activity":{"x":1}}],
                       "team":{"agents":[{"name":"alpha","mode":"subagent","startedAt":123,"activity":[1]}]}}""",
                ).build(),
            )
            server.enqueue(MockResponse.Builder().code(201).body("""{"session":{"id":"s9","workspaceId":"n:w","name":"New session","createdAt":1,"updatedAt":1}}""").build())
            server.enqueue(MockResponse.Builder().body("""{"session":{"id":"s9","workspaceId":"n:w","name":"Mine","pinnedAt":5,"createdAt":1,"updatedAt":1}}""").build())

            val status = api.gitStatus("s1")
            assertEquals(listOf(true, false), status.files.map { it.staged })
            assertEquals(listOf(false, true), status.files.map { it.untracked })
            assertFalse(api.gitStatus("s1").repo)
            server.takeRequest()
            server.takeRequest()

            api.gitDiff("s1", "src/a b.ts", staged = false, untracked = true)
            val diff = server.takeRequest()
            assertEquals("src/a b.ts", diff.url.queryParameter("path"))
            assertEquals("1", diff.url.queryParameter("untracked"))
            assertEquals(null, diff.url.queryParameter("staged"))

            val panel = api.panelState("s1")
            assertEquals(0.5f, panel.memory!!.thresholds!!.observation.fraction)
            assertTrue(panel.backgroundTasks.single().live)
            assertEquals("alpha", panel.team.agents.single().name)
            server.takeRequest()

            assertEquals("s9", api.createSession("n:w").id)
            assertEquals("""{"workspaceId":"n:w"}""", server.takeRequest().body!!.utf8())
            val renamed = api.updateSession("s9", name = "Mine", pinned = true)
            assertTrue(renamed.pinned)
            val patch = server.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("""{"name":"Mine","pinned":true}""", patch.body!!.utf8())
        }
    }
}
