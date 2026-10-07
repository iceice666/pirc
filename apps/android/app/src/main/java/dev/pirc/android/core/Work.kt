package dev.pirc.android.core

import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.ToolCall
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The Chat and Work tabs (plans/ui-redesign.md): chats and projects of the
 * assistant's chat workspaces; every other session grouped by what it needs
 * (Needs you, Running, Recent), with repeated runs of one schedule folded
 * into one row. Ported from the web's `work.ts`; pure, so it is unit tested.
 */

/** A run is open and working (waiting for an answer is "Needs you" instead). */
fun Session.isRunning() = runStatus == "queued" || runStatus == "running" || runStatus == "stopping"

fun Session.needsInput() = runStatus == "waiting_input"

/** Pinned first, then most recently active. */
fun inListOrder(sessions: List<Session>): List<Session> =
    sessions.sortedWith(compareByDescending<Session> { it.pinned }.thenByDescending { it.updatedAt })

/** A row of Recent: one session, or every run of one schedule. */
sealed interface RecentRow {
    val key: String

    data class Single(val session: Session) : RecentRow {
        override val key get() = session.id
    }

    /** [sessions] newest first. */
    data class ScheduleRuns(val scheduleId: String, val title: String, val sessions: List<Session>) : RecentRow {
        override val key get() = "schedule:$scheduleId"
    }
}

/**
 * Sessions in list order, with every session a schedule started folded into one
 * row where its newest run appears. A pinned run stays a row of its own, and a
 * schedule with a single run reads better as the session itself.
 */
fun foldRecent(sessions: List<Session>): List<RecentRow> {
    val rows = mutableListOf<Any>()
    val folds = LinkedHashMap<String, MutableList<Session>>()
    val titles = HashMap<String, String>()
    for (session in sessions) {
        val origin = session.origin
        val scheduleId = origin?.scheduleId
        if (origin == null || !origin.schedule || scheduleId == null || session.pinned) {
            rows += RecentRow.Single(session)
            continue
        }
        val fold = folds[scheduleId]
        if (fold != null) fold += session
        else {
            folds[scheduleId] = mutableListOf(session)
            titles[scheduleId] = origin.title
            rows += scheduleId
        }
    }
    return rows.map { row ->
        if (row is RecentRow) row
        else {
            val id = row as String
            val runs = folds.getValue(id)
            if (runs.size == 1) RecentRow.Single(runs[0]) else RecentRow.ScheduleRuns(id, titles.getValue(id), runs)
        }
    }
}

data class WorkGroups(
    val running: List<Session>,
    val recent: List<RecentRow>,
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
    return WorkGroups(running.sortedByDescending { it.updatedAt }, foldRecent(inListOrder(rest)), settled)
}

/** Sessions of a workspace the list does not know count as work (directory) sessions. */
fun isChatSession(session: Session, workspaces: List<Workspace>) =
    workspaces.firstOrNull { it.id == session.workspaceId }?.isChat == true

// ---- Needs you ----

/** A scheduled run the gateway could not start on time; it waits to be allowed or dismissed. */
data class MissedRun(val schedule: Schedule, val run: ScheduleRun)

/** Missed runs of the schedules' details, newest first. */
fun missedRuns(details: List<ScheduleDetail>): List<MissedRun> =
    details.flatMap { detail -> detail.runs.filter { it.missed }.map { MissedRun(detail.schedule, it) } }
        .distinctBy { it.run.id }
        .sortedByDescending { it.run.dueAt }

/** Everything waiting on the user, in one place. */
data class Inbox(
    /** Runs waiting for an answer, in any workspace (chats too). */
    val waiting: List<Session> = emptyList(),
    val missed: List<MissedRun> = emptyList(),
    val proposals: List<MemoryProposal> = emptyList(),
) {
    val count get() = waiting.size + missed.size + proposals.size
    val isEmpty get() = count == 0
}

fun inbox(sessions: List<Session>, missed: List<MissedRun>, proposals: List<MemoryProposal>) = Inbox(
    waiting = sessions.filter { it.needsInput() }.sortedByDescending { it.updatedAt },
    missed = missed,
    proposals = proposals.filter { it.pending }.sortedByDescending { it.createdAt },
)

// ---- Chat ----

/** A chat project: a chat workspace other than the top-level chats. */
data class ChatProject(val workspace: Workspace, val chats: List<Session>, val settled: List<Session>) {
    val lastActivity get() = (chats + settled).maxOfOrNull { it.updatedAt } ?: 0
}

data class ChatHome(
    /** Where a new top-level chat goes (the first chat node's). */
    val chatsWorkspace: Workspace?,
    val chats: List<Session>,
    val settled: List<Session>,
    val projects: List<ChatProject>,
)

/**
 * The Chat tab: top-level chats (pinned first, then by activity; settled apart)
 * and projects (most recently active first, empty ones by name).
 */
fun chatHome(sessions: List<Session>, workspaces: List<Workspace>): ChatHome {
    val chatWorkspaces = workspaces.filter { it.isChat }
    val topLevel = chatWorkspaces.filter { it.isTopLevelChats }
    val topIds = topLevel.map { it.id }.toSet()
    val byWorkspace = sessions.groupBy { it.workspaceId }
    val top = topIds.flatMap { byWorkspace[it].orEmpty() }
    val (settled, open) = top.partition { it.settled }
    val projects = chatWorkspaces.filter { it.id !in topIds }.map { workspace ->
        val (done, active) = byWorkspace[workspace.id].orEmpty().partition { it.settled }
        ChatProject(workspace, inListOrder(active), done.sortedByDescending { it.updatedAt })
    }.sortedWith(compareByDescending<ChatProject> { it.lastActivity }.thenBy { it.workspace.displayName.lowercase() })
    return ChatHome(topLevel.firstOrNull(), inListOrder(open), settled.sortedByDescending { it.updatedAt }, projects)
}

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
