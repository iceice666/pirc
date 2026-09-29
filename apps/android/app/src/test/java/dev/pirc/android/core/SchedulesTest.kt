package dev.pirc.android.core

import dev.pirc.android.core.timeline.piMessage
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class SchedulesTest {
    private val server = MockWebServer()
    private lateinit var api: PircApi

    @Before
    fun start() {
        server.start()
        api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "b".repeat(43)))
    }

    @After
    fun stop() = server.close()

    private val scheduleJson = """{"id":"s1","title":"CI check","prompt":"Check CI.","workspaceId":"work:test",
        "workspace":{"id":"work:test","name":"Test","kind":"directory","node":"work","online":false},
        "cron":"0 9 * * 1-5","runAt":null,"timezone":"Asia/Taipei","model":{"provider":"gw","id":"model-a"},
        "thinking":"high","status":"active","nextRunAt":1790730000000,"createdBySession":"chat-1",
        "lastRun":{"id":"r1","scheduleId":"s1","dueAt":1790643600000,"status":"missed","sessionId":null,"session":null,
        "result":"work was offline.","startedAt":null,"finishedAt":null,"createdAt":1790643600000},
        "attention":1,"createdAt":1,"updatedAt":1,"somethingNew":true}"""

    @Test
    fun putsCommonCronShapesInWords() {
        val cases = mapOf(
            "* * * * *" to "Every minute",
            "*/15 * * * *" to "Every 15 minutes",
            "5 * * * *" to "Every hour at :05",
            "0 */4 * * *" to "Every 4 hours at :00",
            "30 9 * * *" to "Every day at 09:30",
            "0 9 * * 1-5" to "Weekdays at 09:00",
            "0 10 * * 0,6" to "Weekends at 10:00",
            "0 9 * * 1,3,7" to "Every Monday, Wednesday, Sunday at 09:00",
            "0 9 1 * *" to "Monthly on day 1 at 09:00",
            "0 9 * 1 *" to "0 9 * 1 *",
            "nonsense" to "nonsense",
        )
        for ((cron, words) in cases) assertEquals(cron, words, describeCron(cron))
    }

    @Test
    fun readsTimesInTheScheduleTimeZone() {
        val at = 1790731800000L // 2026-09-30T01:30:00Z
        assertEquals("2026-09-30 09:30", formatWall(at, "Asia/Taipei"))
        assertEquals("2026-09-30T01:30", wallInput(at, "UTC"))
        assertEquals("Once at 2026-09-30 09:30 (Asia/Taipei)", describeWhen(null, at, "Asia/Taipei"))
        assertEquals("in 3h", until(at, at - 3 * 3_600_000))
        assertEquals("in under a minute", until(at, at - 1_000))
        assertEquals(2026, parseWall("2026-10-01T09:00")!!.year)
        assertNull(parseWall("tomorrow"))
        assertEquals(true, validTimezone("Asia/Taipei"))
        assertEquals(false, validTimezone("Mars/Base"))
    }

    @Test
    fun readsSchedulesAndDescribesThem() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"schedules":[$scheduleJson],"timezone":"UTC"}""").build())
        val schedule = api.schedules().single()
        assertEquals("/api/schedules", server.takeRequest().url.encodedPath)
        assertEquals("Test · work · offline · model-a · thinking high", schedule.where())
        assertEquals(
            "Next 2026-09-30 09:00 (in 1h) · last missed · proposed by your assistant",
            schedule.statusLine(now = 1790730000000 - 3_600_000),
        )
        assertEquals(1, schedule.attention)
        assertEquals(true, schedule.lastRun!!.missed)
    }

    @Test
    fun sendsChangesAsTheGatewayExpects() = runTest {
        repeat(2) { server.enqueue(MockResponse.Builder().body("""{"schedule":$scheduleJson}""").build()) }
        server.enqueue(MockResponse.Builder().code(202).body("""{"run":{"id":"r2","scheduleId":"s1","dueAt":1,"status":"running"}}""").build())
        server.enqueue(MockResponse.Builder().code(204).build())

        api.createSchedule(ScheduleInput("work:test", "CI", "Check CI.", "0 9 * * 1-5", null, "Asia/Taipei", ModelRef("gw", "model-a"), null))
        val create = server.takeRequest()
        assertEquals("POST" to "/api/schedules", create.method to create.url.encodedPath)
        assertEquals(
            PircJson.parseToJsonElement(
                """{"workspaceId":"work:test","title":"CI","prompt":"Check CI.","timezone":"Asia/Taipei","cron":"0 9 * * 1-5","model":{"provider":"gw","id":"model-a"},"thinking":null,"notify":"all"}""",
            ),
            PircJson.parseToJsonElement(create.body!!.utf8()),
        )

        api.setScheduleStatus("s1", "paused")
        val pause = server.takeRequest()
        assertEquals("PATCH" to """{"status":"paused"}""", pause.method to pause.body!!.utf8())

        assertEquals("running", api.runSchedule("s1", "r1").status)
        val run = server.takeRequest()
        assertEquals("/api/schedules/s1/run" to """{"runId":"r1"}""", run.url.encodedPath to run.body!!.utf8())

        api.deleteSchedule("s1")
        assertEquals("DELETE", server.takeRequest().method)
    }

    @Test
    fun labelsWhatTheGatewayPushesIntoSessions() {
        fun label(type: String, details: String) = piMessage(
            PircJson.parseToJsonElement("""{"role":"custom","customType":"$type","content":"x","display":true,"details":$details,"timestamp":1}"""),
        )!!.let { it.label to it.meta }
        assertEquals("Scheduled task" to "CI check", label("scheduled-run", """{"scheduleId":"s1","runId":"r1","title":"CI check"}"""))
        assertEquals("Task from your assistant" to "Fix build", label("assistant-delegation", """{"delegationId":"d1","title":"Fix build"}"""))
        assertEquals("Delegation update" to "d1 · completed", label("assistant-delegation-update", """{"delegationId":"d1","status":"completed"}"""))
    }
}
