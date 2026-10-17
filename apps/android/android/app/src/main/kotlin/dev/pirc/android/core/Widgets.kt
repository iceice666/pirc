package dev.pirc.android.core

/*
 * Extension widgets the session state carries as plain text, turned back into
 * records for the docks above the composer. Ported from the web client
 * (`apps/web/src/lib/goal.ts`, `todo.ts`, `app.svelte.ts`); change both together.
 */

const val GOAL_WIDGET = "goal"
const val TODO_WIDGET = "local-todo"

/** Widgets with a dock of their own, so not in the status line. */
private val DOCKED_WIDGETS = setOf(GOAL_WIDGET, TODO_WIDGET)

/** Statuses shown elsewhere (the Tasks panel and its count). */
private val SHOWN_ELSEWHERE = setOf("background-task", "agent-team")

/** [phase]: active, paused, blocked or complete. [disarmed]: active but waiting for a resume (restored after a restart). */
data class GoalView(
    val phase: String,
    val disarmed: Boolean,
    val rounds: Int,
    val maxRounds: Int? = null,
    val objective: String,
    val reason: String? = null,
) {
    val running get() = phase == "active" && !disarmed
    val canResume get() = (phase == "paused" || phase == "blocked" || disarmed) && (maxRounds == null || rounds < maxRounds)
    val phaseLabel get() = if (disarmed) "Waiting for resume" else phase.replaceFirstChar { it.uppercase() }
}

private val GOAL_HEADER = Regex("""^GOAL · (active|paused|blocked|complete)( · disarmed)? · (\d+)(?:/(\d+))?$""")

/** `GOAL · <phase>[ · disarmed] · <rounds>[/<max>]`, then the objective, then an optional reason. */
fun parseGoalWidget(lines: List<String>?): GoalView? {
    val header = GOAL_HEADER.find(lines?.firstOrNull() ?: return null) ?: return null
    return GoalView(
        phase = header.groupValues[1],
        disarmed = header.groupValues[2].isNotEmpty(),
        rounds = header.groupValues[3].toInt(),
        maxRounds = header.groupValues[4].takeIf { it.isNotEmpty() }?.toInt(),
        objective = lines.getOrNull(1) ?: "",
        reason = lines.getOrNull(2)?.takeIf { it.isNotEmpty() },
    )
}

/** [status]: pending, in_progress or completed. */
data class TodoItem(val status: String, val text: String, val category: String? = null, val blocked: Boolean = false)

data class TodoList(val items: List<TodoItem>, val done: Int, val total: Int) {
    val active get() = items.filter { it.status == "in_progress" }

    /** The collapsed dock's line: the task in progress, else how far along. */
    val headline: String
        get() {
            val active = active
            return when {
                active.isNotEmpty() -> active.first().text + if (active.size > 1) " +${active.size - 1}" else ""
                total > 0 && done == total -> "All tasks completed"
                else -> "Tasks"
            }
        }
}

private val TODO_HEADER = Regex("""^TODO · (\d+)/(\d+)$""")
private val MARKS = mapOf('✓' to "completed", '▶' to "in_progress", '☐' to "pending")
private val TAGGED = Regex("""^\[([^\]]*)] (.*)$""")
private const val BLOCKED = " (blocked)"

/** A `TODO · done/total` header, then `<mark> [category] label (blocked)` per task (✓ ▶ ☐). */
fun parseTodoWidget(lines: List<String>?): TodoList? {
    if (lines.isNullOrEmpty()) return null
    val header = TODO_HEADER.find(lines.first())
    val items = lines.drop(if (header != null) 1 else 0).mapNotNull { line ->
        // Older runners appended "… N more"; anything unmarked is not a task.
        val status = line.firstOrNull()?.let(MARKS::get) ?: return@mapNotNull null
        var text = line.drop(1).trim()
        var category: String? = null
        TAGGED.find(text)?.let {
            category = it.groupValues[1]
            text = it.groupValues[2]
        }
        val blocked = text.endsWith(BLOCKED)
        if (blocked) text = text.dropLast(BLOCKED.length)
        TodoItem(status, text, category?.takeIf { it.isNotEmpty() }, blocked)
    }
    val done = header?.groupValues?.get(1)?.toInt() ?: items.count { it.status == "completed" }
    val total = header?.groupValues?.get(2)?.toInt() ?: items.size
    return if (total > 0) TodoList(items, done, total) else null
}

/** Under the composer: each other widget's first line, then statuses not shown elsewhere. */
fun statusLine(widgets: Map<String, List<String>>, statuses: Map<String, String>): List<String> =
    widgets.filter { (key, lines) -> key !in DOCKED_WIDGETS && lines.isNotEmpty() }.map { it.value.first() } +
        statuses.filter { (key, text) -> key !in SHOWN_ELSEWHERE && text.isNotEmpty() }.values
