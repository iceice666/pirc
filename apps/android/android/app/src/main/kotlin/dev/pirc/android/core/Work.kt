package dev.pirc.android.core

import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.ToolCall
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The Work tab: sessions grouped by what they need (Needs you, Running,
 * Recent). Ported from the web's `work.ts`; pure, so it is unit tested.
 */

/** A run is open and working (waiting for an answer is "Needs you" instead). */
fun Session.isRunning() = runStatus == "queued" || runStatus == "running" || runStatus == "stopping"

fun Session.needsInput() = runStatus == "waiting_input"

/** Pinned first, then most recently active. */
fun inListOrder(sessions: List<Session>): List<Session> =
    sessions.sortedWith(compareByDescending<Session> { it.pinned }.thenByDescending { it.updatedAt })

data class WorkGroups(
    val running: List<Session>,
    val recent: List<Session>,
    /** Settled sessions left out of [recent]. */
    val settled: Int,
)

/**
 * Work sessions (those [include] accepts: directory workspaces, optionally
 * one) by state. Sessions waiting for an answer are left to Needs you.
 */
fun workGroups(sessions: List<Session>, include: (Session) -> Boolean, showSettled: Boolean): WorkGroups {
    val running = mutableListOf<Session>()
    val rest = mutableListOf<Session>()
    var settled = 0
    for (session in sessions) {
        if (!include(session) || session.needsInput()) continue
        when {
            session.isRunning() -> running += session
            session.settled && !showSettled -> settled++
            else -> rest += session
        }
    }
    return WorkGroups(running.sortedByDescending { it.updatedAt }, inListOrder(rest), settled)
}

// ---- Needs you ----

/** Everything waiting on the user, in one place. */
data class Inbox(
    /** Runs waiting for an answer, in any workspace. */
    val waiting: List<Session> = emptyList(),
) {
    val count get() = waiting.size
    val isEmpty get() = count == 0
}

fun inbox(sessions: List<Session>) = Inbox(
    waiting = sessions.filter { it.needsInput() }.sortedByDescending { it.updatedAt },
)

// ---- Write lease ----

/** A write refused because another session holds the lease (node `grantWrite`). */
data class WriteBlock(val path: String, val holderName: String)

private val WRITE_BLOCKED = Regex("""(\S+) is being written by session "(.+?)" \([^)]*\); wait until its run finishes""")

fun writeBlock(tool: ToolCall): WriteBlock? {
    if (tool.status != "failed") return null
    val match = WRITE_BLOCKED.find(tool.output ?: return null) ?: return null
    return WriteBlock(match.groupValues[1], match.groupValues[2])
}

/** The session named in a refusal: one holding a lease now, else any of that name. */
fun blockingSession(sessions: List<Session>, name: String): Session? =
    sessions.firstOrNull { it.writeLease && it.name == name } ?: sessions.firstOrNull { it.name == name }

// ---- Run cards ----

/** An assistant turn that only called tools: no text, error or images. */
fun Message.toolsOnly() = role == "assistant" && content.isEmpty() && stopReason == null &&
    errorMessage == null && images.isEmpty() && tools.isNotEmpty()

sealed interface TimelineItem {
    data class Single(val message: Message) : TimelineItem

    /** Consecutive tool-only turns (two or more), shown as one run card. */
    data class Run(val messages: List<Message>) : TimelineItem {
        val tools get() = messages.flatMap { it.tools }
    }
}

/** Group consecutive tool-only turns into run cards; everything else stays as it is. */
fun timelineItems(messages: List<Message>): List<TimelineItem> {
    val items = mutableListOf<TimelineItem>()
    var run = mutableListOf<Message>()
    fun flush() {
        if (run.size > 1) items += TimelineItem.Run(run)
        else if (run.isNotEmpty()) items += TimelineItem.Single(run[0])
        run = mutableListOf()
    }
    for (message in messages) {
        if (message.toolsOnly()) run += message
        else {
            flush()
            items += TimelineItem.Single(message)
        }
    }
    flush()
    return items
}

data class RunSummary(
    val count: Int,
    /** running, failed or succeeded. */
    val status: String,
    /** From the first start to the last end, when known and finished. */
    val durationMs: Long?,
    /** File names the tools read or changed, in order, without repeats. */
    val files: List<String>,
)

private val FILE_TOOLS = setOf("read", "edit", "write")

/**
 * The calls behind some tool calls: a `ptc` script stands for the operations
 * it ran (none yet: the script itself), and capability lookups are left out.
 */
fun effectiveTools(tools: List<ToolCall>): List<ToolCall> {
    val calls = tools.flatMap { tool ->
        when {
            tool.name == "ptc_docs" -> emptyList()
            tool.operations.isNotEmpty() -> tool.operations
            else -> listOf(tool)
        }
    }
    return calls.ifEmpty { tools }
}

/** A script's operations in a few words: names in first-use order, with counts. */
fun operationsSummary(operations: List<ToolCall>): String =
    operations.groupingBy { it.name }.eachCount().entries
        .joinToString(", ") { (name, count) -> if (count > 1) "$name ×$count" else name }

fun summarizeRun(tools: List<ToolCall>): RunSummary {
    val status = when {
        tools.any { it.status == "failed" } -> "failed"
        tools.any { it.status == "running" } -> "running"
        else -> "succeeded"
    }
    val starts = tools.mapNotNull { it.startedAt }
    val ends = tools.mapNotNull { it.endedAt }
    val duration = if (starts.isNotEmpty() && ends.isNotEmpty() && status != "running") maxOf(0L, ends.max() - starts.min()) else null
    val files = mutableListOf<String>()
    val calls = effectiveTools(tools)
    for (tool in calls) {
        if (tool.name !in FILE_TOOLS) continue
        val path = ((tool.input as? JsonObject)?.get("path") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
        val name = path.split('/').lastOrNull { it.isNotEmpty() } ?: continue
        if (name !in files) files += name
    }
    return RunSummary(calls.size, status, duration, files)
}

/** "850 ms", "12 s", "3 m 4 s", "1 h 2 m". */
fun formatDuration(ms: Long): String = when {
    ms < 1_000 -> "$ms ms"
    ms < 60_000 -> "${ms / 1_000} s"
    ms < 3_600_000 -> "${ms / 60_000} m ${(ms / 1_000) % 60} s"
    else -> "${ms / 3_600_000} h ${(ms / 60_000) % 60} m"
}
