package dev.pirc.android.core

import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.ToolCall
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkTest {
    private fun session(
        id: String,
        updatedAt: Long = 0,
        runStatus: String? = null,
        workspaceId: String = "n:repo",
        pinned: Boolean = false,
        settled: Boolean = false,
        origin: SessionOrigin? = null,
        name: String = id,
        writeLease: Boolean = false,
    ) = Session(
        id = id, workspaceId = workspaceId, name = name, runStatus = runStatus,
        pinnedAt = if (pinned) 1 else null, settledAt = if (settled) 1 else null,
        updatedAt = updatedAt, origin = origin, writeLease = writeLease,
    )

    private fun scheduled(scheduleId: String, title: String = "Daily") = SessionOrigin("schedule", title, scheduleId = scheduleId, dueAt = 1)

    @Test
    fun decodesTheLiveListFields() {
        val listed = PircJson.decodeFromString(
            SessionsResponse.serializer(),
            """{"sessions":[
              {"id":"a","workspaceId":"n:r","name":"A","runStatus":"running","writeLease":true,
               "origin":{"kind":"schedule","scheduleId":"s1","title":"Daily","dueAt":5}},
              {"id":"b","workspaceId":"n:chats","name":"B",
               "origin":{"kind":"delegation","delegationId":"d1","title":"Fix it","fromSessionId":"c1"}},
              {"id":"c","workspaceId":"n:r","name":"C"}]}""",
        ).sessions
        assertTrue(listed[0].writeLease)
        assertTrue(listed[0].origin!!.schedule)
        assertEquals("s1", listed[0].origin!!.scheduleId)
        assertTrue(listed[1].origin!!.delegation)
        assertEquals("c1", listed[1].origin!!.fromSessionId)
        assertFalse(listed[2].writeLease)
        assertNull(listed[2].origin)
        val workspaces = PircJson.decodeFromString(
            WorkspacesResponse.serializer(),
            """{"workspaces":[{"id":"n:chats","hostId":"n","displayName":"Chats","kind":"chat"},{"id":"n:r","hostId":"n","displayName":"R"}]}""",
        ).workspaces
        assertTrue(workspaces[0].isTopLevelChats)
        assertFalse(workspaces[1].isChat)
    }

    @Test
    fun groupsWorkByState() {
        val sessions = listOf(
            session("run", 5, "running"),
            session("queued", 6, "queued"),
            session("wait", 7, "waiting_input"),
            session("old", 1),
            session("new", 3),
            session("pin", 0, pinned = true),
            session("done", 9, settled = true),
            session("chat", 10, workspaceId = "n:chats"),
        )
        val include = { s: Session -> s.workspaceId != "n:chats" }
        val groups = workGroups(sessions, include, showSettled = false)
        assertEquals(listOf("queued", "run"), groups.running.map { it.id })
        assertEquals(listOf("pin", "new", "old"), groups.recent.map { it.key })
        assertEquals(1, groups.settled)
        val all = workGroups(sessions, include, showSettled = true)
        assertEquals(listOf("pin", "done", "new", "old"), all.recent.map { it.key })
        assertEquals(0, all.settled)
    }

    @Test
    fun foldsRunsOfOneScheduleAtTheNewest() {
        val rows = foldRecent(
            listOf(
                session("a", origin = scheduled("s1", "CI check")),
                session("b"),
                session("c", origin = scheduled("s1", "CI check")),
                session("d", origin = scheduled("s2")),
                session("e", origin = scheduled("s1", "CI check")),
            ),
        )
        assertEquals(3, rows.size)
        val fold = rows[0] as RecentRow.ScheduleRuns
        assertEquals("CI check", fold.title)
        assertEquals(listOf("a", "c", "e"), fold.sessions.map { it.id })
        assertEquals("b", rows[1].key)
        // A schedule with one run is the session itself.
        assertEquals(RecentRow.Single(session("d", origin = scheduled("s2"))), rows[2])
    }

    @Test
    fun keepsAPinnedRunApart() {
        val rows = foldRecent(listOf(session("a", pinned = true, origin = scheduled("s1")), session("b", origin = scheduled("s1")), session("c", origin = scheduled("s1"))))
        assertEquals(listOf("a", "schedule:s1"), rows.map { it.key })
    }

    @Test
    fun collectsTheInbox() {
        val schedule = PircJson.decodeFromString(
            Schedule.serializer(),
            """{"id":"s1","title":"CI","prompt":"p","workspaceId":"n:r","workspace":{"id":"n:r","name":"R"},"timezone":"UTC","status":"active","attention":2}""",
        )
        fun run(id: String, status: String, dueAt: Long) = ScheduleRun(id, "s1", dueAt, status)
        val missed = missedRuns(listOf(ScheduleDetail(schedule, listOf(run("r1", "missed", 1), run("r2", "completed", 2), run("r3", "missed", 3)))))
        assertEquals(listOf("r3", "r1"), missed.map { it.run.id })
        val proposals = listOf(MemoryProposal("p1", "add", content = "x"), MemoryProposal("p2", "add", status = "approved"))
        val inbox = inbox(listOf(session("w", 2, "waiting_input", workspaceId = "n:chats"), session("r", 3, "running")), missed, proposals)
        assertEquals(listOf("w"), inbox.waiting.map { it.id })
        assertEquals(listOf("p1"), inbox.proposals.map { it.id })
        assertEquals(4, inbox.count)
    }

    @Test
    fun buildsTheChatHome() {
        val workspaces = listOf(
            Workspace("n:chats", "n", "Chats", "chat"),
            Workspace("n:trip", "n", "Trip", "chat"),
            Workspace("n:empty", "n", "Alpha", "chat"),
            Workspace("n:repo", "n", "Repo"),
        )
        val home = chatHome(
            listOf(
                session("c1", 1, workspaceId = "n:chats"),
                session("c2", 2, workspaceId = "n:chats"),
                session("c3", 3, workspaceId = "n:chats", settled = true),
                session("t1", 4, workspaceId = "n:trip"),
                session("w1", 9, workspaceId = "n:repo"),
            ),
            workspaces,
        )
        assertEquals("n:chats", home.chatsWorkspace?.id)
        assertEquals(listOf("c2", "c1"), home.chats.map { it.id })
        assertEquals(listOf("c3"), home.settled.map { it.id })
        assertEquals(listOf("Trip", "Alpha"), home.projects.map { it.workspace.displayName })
        assertEquals(listOf("t1"), home.projects[0].chats.map { it.id })
        assertTrue(isChatSession(session("x", workspaceId = "n:trip"), workspaces))
        assertFalse(isChatSession(session("x", workspaceId = "gone:ws"), workspaces))
    }

    @Test
    fun parsesAWriteBlockAndFindsTheHolder() {
        val output = """src/app.ts is being written by session "Fix the build" (node-s-9); wait until its run finishes"""
        val block = writeBlock(ToolCall("t", "edit", status = "failed", output = output))
        assertEquals(WriteBlock("src/app.ts", "Fix the build"), block)
        assertNull(writeBlock(ToolCall("t", "edit", status = "succeeded", output = output)))
        assertNull(writeBlock(ToolCall("t", "edit", status = "failed", output = "ENOENT")))
        val sessions = listOf(session("old", name = "Fix the build"), session("live", name = "Fix the build", writeLease = true))
        assertEquals("live", blockingSession(sessions, "Fix the build")?.id)
        assertEquals("old", blockingSession(sessions.take(1), "Fix the build")?.id)
        assertNull(blockingSession(sessions, "Other"))
    }

    private fun message(id: String, content: String = "", tools: List<ToolCall> = emptyList(), role: String = "assistant") =
        Message(id, role, content, 0, tools = tools)

    private fun tool(id: String, name: String = "bash", status: String = "succeeded", path: String? = null, start: Long? = null, end: Long? = null) =
        ToolCall(id, name, status = status, input = path?.let { buildJsonObject { put("path", JsonPrimitive(it)) } }, startedAt = start, endedAt = end)

    @Test
    fun groupsConsecutiveToolOnlyTurns() {
        val items = timelineItems(
            listOf(
                message("u", "hi", role = "user"),
                message("a1", tools = listOf(tool("1"))),
                message("a2", tools = listOf(tool("2"))),
                message("a3", "done"),
                message("a4", tools = listOf(tool("3"))),
            ),
        )
        assertEquals(4, items.size)
        val run = items[1] as TimelineItem.Run
        assertEquals(listOf("a1", "a2"), run.messages.map { it.id })
        assertEquals(listOf("1", "2"), run.tools.map { it.id })
        assertTrue(items[3] is TimelineItem.Single)
    }

    @Test
    fun summarizesARun() {
        val done = summarizeRun(
            listOf(
                tool("1", "read", path = "src/a.ts", start = 1_000, end = 2_000),
                tool("2", "edit", path = "src/a.ts", start = 2_000, end = 4_500),
                tool("3", "write", path = "docs/b.md/", start = 5_000, end = 13_000),
                tool("4", "bash", path = "ignored.sh"),
                tool("5", "read", path = "c.kt"),
            ),
        )
        assertEquals(RunSummary(5, "succeeded", 12_000, listOf("a.ts", "b.md", "c.kt")), done)
        assertEquals("running", summarizeRun(listOf(tool("1", status = "running", start = 1), tool("2", end = 3))).status)
        assertNull(summarizeRun(listOf(tool("1", status = "running", start = 1), tool("2", end = 3))).durationMs)
        assertEquals("failed", summarizeRun(listOf(tool("1", status = "running"), tool("2", status = "failed"))).status)
        assertEquals("12 s", formatDuration(12_000))
        assertEquals("3 m 4 s", formatDuration(184_000))
    }

    @Test
    fun scriptsStandForTheOperationsTheyRan() {
        val script = ToolCall(
            id = "p",
            name = "ptc",
            status = "succeeded",
            operations = listOf(
                tool("o1", "read", path = "src/a.ts"),
                tool("o2", "edit", path = "src/a.ts"),
                tool("o3", "edit", path = "b.ts"),
            ),
        )
        val docs = ToolCall(id = "d", name = "ptc_docs", status = "succeeded")
        assertEquals(listOf("o1", "o2", "o3"), effectiveTools(listOf(docs, script)).map { it.id })
        assertEquals("read, edit ×2", operationsSummary(script.operations))
        val run = summarizeRun(listOf(docs, script))
        assertEquals(3, run.count)
        assertEquals(listOf("a.ts", "b.ts"), run.files)
        // A script that has not run anything yet is itself the call.
        val fresh = ToolCall(id = "q", name = "ptc")
        assertEquals(listOf(fresh), effectiveTools(listOf(fresh)))
    }

    @Test
    fun reviewsProposals() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "b".repeat(43)))
            server.enqueue(
                MockResponse.Builder().body(
                    """{"usage":{},"user":[],"notes":[],"removed":[],"sessions":{"c1":"Trip"},"proposals":[
                    {"id":"p1","action":"replace","targetId":"e1","targetRevision":2,"content":"Lives in Taipei","quote":"I moved",
                     "sources":{},"sessionId":"c1","status":"pending","createdAt":1,"decidedAt":null,
                     "target":{"id":"e1","content":"Lives in Tokyo","revision":3}}]}""",
                ).build(),
            )
            val view = api.memory()
            assertEquals("Trip", view.sessions["c1"])
            val proposal = view.proposals.single()
            assertEquals(3, proposal.shownRevision)
            assertEquals("Change: Lives in Tokyo → Lives in Taipei", proposal.describe())
            server.takeRequest()

            server.enqueue(MockResponse.Builder().body("""{"proposals":[]}""").build())
            assertTrue(api.approveProposal("p1", 3).proposals.isEmpty())
            val approve = server.takeRequest()
            assertEquals("/api/memory/proposals/p1/approve", approve.url.encodedPath)
            assertEquals("""{"targetRevision":3}""", approve.body?.utf8())

            server.enqueue(MockResponse.Builder().body("""{"proposals":[]}""").build())
            api.rejectProposal("p1")
            assertEquals("/api/memory/proposals/p1/reject", server.takeRequest().url.encodedPath)
        } finally {
            server.close()
        }
    }
}
