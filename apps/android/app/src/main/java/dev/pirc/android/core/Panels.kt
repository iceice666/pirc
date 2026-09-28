package dev.pirc.android.core

import kotlinx.serialization.Serializable

/*
 * The side-panel data the web shows next to a session (`panel-api.ts`):
 * Git, background tasks and teammates, observational memory, terminals.
 * Everything is read from the session's node through the gateway.
 */

// ---- Git ----

@Serializable
data class GitFile(val path: String, val origPath: String? = null, val index: String = " ", val worktree: String = " ") {
    val staged get() = index != " " && index != "?"
    val unstaged get() = worktree != " "
    val untracked get() = worktree == "?"
}

/** `repo` false: the workspace is not a Git repository (the other fields are absent). */
@Serializable
data class GitStatus(
    val repo: Boolean,
    val root: String? = null,
    val branch: String? = null,
    val upstream: String? = null,
    val ahead: Int = 0,
    val behind: Int = 0,
    val files: List<GitFile> = emptyList(),
    val truncated: Boolean = false,
)

@Serializable
data class Diff(val diff: String, val truncated: Boolean = false)

@Serializable
data class Commit(
    val sha: String,
    val short: String,
    val author: String,
    val email: String = "",
    /** Epoch milliseconds. */
    val time: Long,
    val refs: List<String> = emptyList(),
    val subject: String,
)

@Serializable
data class CommitPage(val commits: List<Commit>, val more: Boolean = false)

@Serializable
data class CommitDetail(
    val sha: String,
    val author: String,
    val email: String = "",
    val time: Long,
    val refs: List<String> = emptyList(),
    val message: String,
    val diff: String,
    val truncated: Boolean = false,
)

val GIT_LABELS = mapOf(
    "M" to "Modified", "A" to "Added", "D" to "Deleted", "R" to "Renamed",
    "C" to "Copied", "U" to "Conflict", "T" to "Type changed", "?" to "Untracked",
)

/** One rendered line of a unified diff; see [parseDiff]. */
data class DiffLine(val kind: Kind, val text: String, val old: Int? = null, val new: Int? = null) {
    enum class Kind { File, Meta, Hunk, Add, Del, Context }
}

/** File headers, hunk headers and +/- lines with their line numbers (a port of the web's DiffView). */
fun parseDiff(text: String): List<DiffLine> {
    val lines = ArrayList<DiffLine>()
    var oldNo = 0
    var newNo = 0
    var inHunk = false
    val hunk = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)")
    for (raw in text.split('\n')) {
        when {
            raw.startsWith("diff --git ") -> {
                inHunk = false
                lines += DiffLine(DiffLine.Kind.File, Regex(" b/(.*)$").find(raw)?.groupValues?.get(1) ?: raw.removePrefix("diff --git "))
            }
            raw.startsWith("@@") -> {
                inHunk = true
                val match = hunk.find(raw)
                oldNo = match?.groupValues?.get(1)?.toIntOrNull() ?: 0
                newNo = match?.groupValues?.get(2)?.toIntOrNull() ?: 0
                lines += DiffLine(DiffLine.Kind.Hunk, raw)
            }
            !inHunk -> if (raw.isNotEmpty() && !raw.startsWith("index ") && !raw.startsWith("--- ") && !raw.startsWith("+++ "))
                lines += DiffLine(DiffLine.Kind.Meta, raw)
            raw.startsWith("+") -> lines += DiffLine(DiffLine.Kind.Add, raw.substring(1), new = newNo++)
            raw.startsWith("-") -> lines += DiffLine(DiffLine.Kind.Del, raw.substring(1), old = oldNo++)
            raw.startsWith("\\") -> lines += DiffLine(DiffLine.Kind.Meta, raw)
            else -> lines += DiffLine(DiffLine.Kind.Context, raw.drop(1), old = oldNo++, new = newNo++)
        }
    }
    // The final newline leaves an empty context line.
    while (lines.lastOrNull()?.let { it.kind == DiffLine.Kind.Context && it.text.isEmpty() } == true) lines.removeAt(lines.lastIndex)
    return lines
}

// ---- panel state: background tasks, teammates, memory ----

@Serializable
data class BackgroundTask(
    val id: String,
    val command: String,
    val cwd: String = "",
    /** running, stopping, completed, failed, stopped, timed_out. */
    val status: String,
    val pid: Long? = null,
    val exited: Boolean = false,
    val exitCode: Int? = null,
    val signal: String? = null,
    val tty: Boolean = false,
    val notifyOn: String? = null,
    val matches: Int? = null,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val error: String? = null,
) {
    val live get() = status == "running" || status == "stopping"
}

@Serializable
data class BackgroundOutput(val task: BackgroundTask, val output: String)

@Serializable
data class TeamMember(
    val name: String,
    val kind: String? = null,
    /** `team` (persistent) or `subagent` (one-shot). */
    val mode: String? = null,
    val background: Boolean = false,
    val status: String? = null,
    val cwd: String? = null,
    val model: String? = null,
    val thinking: String? = null,
    val lastError: String? = null,
    val task: String? = null,
)

@Serializable
data class TeamTask(
    val id: String,
    val subject: String,
    val description: String = "",
    /** pending, in_progress, completed. */
    val status: String,
    val owner: String? = null,
    val blockedBy: List<String> = emptyList(),
    val blocked: Boolean = false,
    val ready: Boolean = false,
)

@Serializable
data class TeamEvent(
    val id: String,
    val time: String = "",
    val kind: String,
    val from: String? = null,
    val to: String? = null,
    val name: String? = null,
    val body: String? = null,
)

@Serializable
data class Team(
    val agents: List<TeamMember> = emptyList(),
    val tasks: List<TeamTask> = emptyList(),
    val events: List<TeamEvent> = emptyList(),
)

@Serializable
data class Meter(val value: Double, val max: Double) {
    val fraction get() = if (max > 0) (value / max).coerceIn(0.0, 1.0).toFloat() else 0f
}

@Serializable
data class MemoryThresholds(
    val observation: Meter,
    val reflection: Meter,
    val compaction: Meter,
    val visiblePool: Meter,
    val activePool: Meter,
)

@Serializable
data class MemoryCounts(
    val observations: Int = 0,
    val active: Int = 0,
    val dropped: Int = 0,
    val visibleObservations: Int = 0,
    val reflections: Int = 0,
    val visibleReflections: Int = 0,
    val compactions: Int = 0,
)

@Serializable
data class Observation(
    val id: String,
    val content: String,
    val timestamp: String = "",
    /** low, medium, high, critical. */
    val relevance: String = "medium",
    val tokenCount: Int = 0,
    val dropped: Boolean = false,
    val visible: Boolean = true,
)

@Serializable
data class Reflection(
    val id: String,
    val content: String,
    val supportingObservationIds: List<String> = emptyList(),
    val tokenCount: Int = 0,
    val visible: Boolean = true,
)

@Serializable
data class MemoryPanel(
    val enabled: Boolean = false,
    val passive: Boolean = false,
    val thresholds: MemoryThresholds? = null,
    val counts: MemoryCounts = MemoryCounts(),
    val observations: List<Observation> = emptyList(),
    val reflections: List<Reflection> = emptyList(),
    val lastCompactionAt: Long? = null,
)

@Serializable
data class RateLimit(val model: String, val until: Long)

@Serializable
data class MemoryRuntime(
    val phase: String? = null,
    val autoCompacting: Boolean = false,
    val rateLimited: List<RateLimit> = emptyList(),
    val lastErrors: Map<String, String> = emptyMap(),
)

@Serializable
data class PanelState(
    val agentRunning: Boolean = false,
    val memory: MemoryPanel? = null,
    val memoryRuntime: MemoryRuntime? = null,
    val backgroundTasks: List<BackgroundTask> = emptyList(),
    val team: Team = Team(),
)

// ---- terminals ----

@Serializable
data class TerminalInfo(
    val id: String,
    val title: String = "",
    val cwd: String = "",
    val cols: Int = 80,
    val rows: Int = 24,
    val createdAt: Long = 0,
    val exitCode: Int? = null,
    val exited: Boolean = false,
)

@Serializable
internal data class TerminalsResponse(val terminals: List<TerminalInfo>)

@Serializable
internal data class TerminalResponse(val terminal: TerminalInfo)

@Serializable
internal data class TaskResponse(val task: BackgroundTask)
