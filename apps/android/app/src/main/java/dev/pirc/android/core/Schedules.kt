package dev.pirc.android.core

import kotlinx.serialization.Serializable
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Scheduled tasks, held by the gateway (docs/history/cron.md): a prompt that runs in
 * a new session at set times. Runs the gateway could not start on time are
 * `missed` and wait for the user to allow them. Mirrors the web's `schedules.ts`.
 */
@Serializable
data class ScheduleRun(
    val id: String,
    val scheduleId: String,
    val dueAt: Long,
    /** missed, skipped, dismissed, running, waiting_input, completed or failed. */
    val status: String,
    val sessionId: String? = null,
    /** The session's name, while it exists. */
    val session: String? = null,
    val result: String? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val createdAt: Long = 0,
) {
    val missed get() = status == "missed"
}

@Serializable
data class ScheduleWorkspace(
    val id: String,
    val name: String,
    val kind: String? = null,
    val node: String? = null,
    val online: Boolean = false,
)

@Serializable
data class ModelRef(val provider: String, val id: String)

@Serializable
data class Schedule(
    val id: String,
    val title: String,
    val prompt: String,
    val workspaceId: String,
    val workspace: ScheduleWorkspace,
    val cron: String? = null,
    val runAt: Long? = null,
    val timezone: String,
    val model: ModelRef? = null,
    val thinking: String? = null,
    /** Which runs push a notification: all, problems or none. */
    val notify: String = "all",
    /** active, paused or done. */
    val status: String,
    val nextRunAt: Long? = null,
    /** The chat whose assistant proposed it; null when the user made it. */
    val createdBySession: String? = null,
    val lastRun: ScheduleRun? = null,
    /** Runs waiting for the user: missed ones and ones waiting for an answer. */
    val attention: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
) {
    val active get() = status == "active"
    val paused get() = status == "paused"
}

/** What the form sends. [at] is wall time in [timezone] (`2026-10-01T09:00`). */
data class ScheduleInput(
    val workspaceId: String,
    val title: String,
    val prompt: String,
    val cron: String?,
    val at: String?,
    val timezone: String,
    val model: ModelRef?,
    val thinking: String?,
    val notify: String = "all",
)

@Serializable
internal data class SchedulesResponse(val schedules: List<Schedule>, val timezone: String = "UTC")

@Serializable
data class ScheduleDetail(val schedule: Schedule, val runs: List<ScheduleRun> = emptyList())

@Serializable
internal data class ScheduleResponse(val schedule: Schedule)

@Serializable
internal data class RunResponse(val run: ScheduleRun)

/** Every level a schedule may ask for (the gateway also takes `max`). */
val SCHEDULE_THINKING_LEVELS = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

val RUN_LABELS = mapOf(
    "missed" to "Missed",
    "skipped" to "Skipped",
    "dismissed" to "Dismissed",
    "running" to "Running",
    "waiting_input" to "Waiting for you",
    "completed" to "Completed",
    "failed" to "Failed",
)

fun runLabel(status: String) = RUN_LABELS[status] ?: status

/** Which runs of a schedule notify, for the form. */
val NOTIFY_CHOICES = listOf(
    "all" to "Every run",
    "problems" to "Only when it fails, is missed or needs me",
    "none" to "Never",
)

/** Common repeats for the form. */
val CRON_PRESETS = listOf(
    "Every hour" to "0 * * * *",
    "Every day at 09:00" to "0 9 * * *",
    "Weekdays at 09:00" to "0 9 * * 1-5",
    "Mondays at 09:00" to "0 9 * * 1",
    "First of the month" to "0 9 1 * *",
)

private fun zone(timezone: String): ZoneId = try {
    ZoneId.of(timezone)
} catch (error: DateTimeException) {
    ZoneId.of("UTC")
}

private val WALL = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
private val INPUT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")

/** `2026-10-01 09:00`, as the clock reads in [timezone]. */
fun formatWall(at: Long, timezone: String): String = WALL.format(Instant.ofEpochMilli(at).atZone(zone(timezone)))

/** The wall time the form edits (`2026-10-01T09:00`) for [at] in [timezone]. */
fun wallInput(at: Long, timezone: String): String = INPUT.format(Instant.ofEpochMilli(at).atZone(zone(timezone)))

/** A form's wall time back to a `LocalDateTime`, or null when it is not one. */
fun parseWall(value: String): LocalDateTime? = runCatching { LocalDateTime.parse(value.trim(), INPUT) }.getOrNull()

/** A valid IANA time zone. */
fun validTimezone(value: String) = runCatching { ZoneId.of(value.trim()) }.isSuccess && value.isNotBlank()

private val DAYS = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
private val PLAIN = Regex("""^\d{1,2}$""")
private val EVERY = Regex("""^\*/(\d+)$""")

private fun two(value: String) = value.padStart(2, '0')

/** A cron expression in words when it is a common shape ("Weekdays at 09:00"), else the expression. */
fun describeCron(expression: String): String {
    val fields = expression.trim().split(Regex("\\s+"))
    if (fields.size != 5) return expression
    val (minute, hour, day, month, weekday) = fields
    if (hour == "*" && day == "*" && month == "*" && weekday == "*") {
        if (minute == "*") return "Every minute"
        EVERY.find(minute)?.let { return "Every ${it.groupValues[1]} minutes" }
        if (PLAIN.matches(minute)) return "Every hour at :${two(minute)}"
        return expression
    }
    if (!PLAIN.matches(minute) || month != "*") return expression
    EVERY.find(hour)?.let { if (day == "*" && weekday == "*") return "Every ${it.groupValues[1]} hours at :${two(minute)}" }
    if (!PLAIN.matches(hour)) return expression
    val time = "${two(hour)}:${two(minute)}"
    if (day == "*" && weekday == "*") return "Every day at $time"
    if (day == "*") {
        if (weekday == "1-5") return "Weekdays at $time"
        if (weekday == "0,6" || weekday == "6,0") return "Weekends at $time"
        val days = weekday.split(',')
        if (days.all { Regex("^[0-7]$").matches(it) })
            return "Every ${days.joinToString(", ") { DAYS[it.toInt() % 7] }} at $time"
        return expression
    }
    if (weekday == "*" && PLAIN.matches(day)) return "Monthly on day ${day.toInt()} at $time"
    return expression
}

/** When a schedule runs, for people. */
fun describeWhen(cron: String?, runAt: Long?, timezone: String): String = when {
    cron != null -> "${describeCron(cron)} ($timezone)"
    runAt != null -> "Once at ${formatWall(runAt, timezone)} ($timezone)"
    else -> "Never"
}

/** "in 5m", "in 3h", "in 2d" (the next run). */
fun until(at: Long, now: Long = System.currentTimeMillis()): String {
    val delta = at - now
    return when {
        delta < 60_000 -> "in under a minute"
        delta < 3_600_000 -> "in ${Math.round(delta / 60_000.0)}m"
        delta < 86_400_000 -> "in ${Math.round(delta / 3_600_000.0)}h"
        else -> "in ${Math.round(delta / 86_400_000.0)}d"
    }
}

/** "pirc · work · offline · model-a · thinking high" */
fun Schedule.where(): String = listOfNotNull(
    workspace.name,
    workspace.node,
    "offline".takeIf { !workspace.online },
    model?.id,
    thinking?.let { "thinking $it" },
    when (notify) {
        "none" -> "no notifications"
        "problems" -> "notifies on problems"
        else -> null
    },
).joinToString(" · ")

/** "Next 2026-09-30 09:00 (in 3h) · last completed · proposed by your assistant" */
fun Schedule.statusLine(now: Long = System.currentTimeMillis()): String = listOfNotNull(
    if (active && nextRunAt != null) "Next ${formatWall(nextRunAt, timezone)} (${until(nextRunAt, now)})" else "No next run",
    lastRun?.let { "last ${runLabel(it.status).lowercase()}" },
    "proposed by your assistant".takeIf { createdBySession != null },
).joinToString(" · ")
