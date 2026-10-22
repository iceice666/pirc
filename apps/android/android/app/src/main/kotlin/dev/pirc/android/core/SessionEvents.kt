package dev.pirc.android.core

import kotlinx.serialization.json.JsonObject

/**
 * What a frame of a session's event stream changes for the engine (plans/
 * rewrite/12-android.md, decision 4): the session shows no transcript, so
 * message and tool events change nothing it shows; the record, the run and
 * the runner are read again when they change.
 */
sealed interface SessionChange {
    data object Deleted : SessionChange
    data class PanelChanged(val sections: List<String>) : SessionChange
    data class Renamed(val name: String) : SessionChange

    /** Run or runner state changed (or the cursor lapsed): read the session again. */
    data object Refresh : SessionChange
    data object None : SessionChange
}

/** Agent lifecycle events: the run started or ended. */
private val RUN_EVENTS = setOf("agent_start", "agent_end", "agent_settled")

/** Events whose effect only a fresh read reports accurately. */
private val REFRESH_EVENTS = setOf(
    "reset",
    "interaction_created",
    "interaction_answered",
    "runner_ready",
    "runner_error",
    "runner_exit",
    "node_offline",
    "node_reconnected",
)

fun sessionChange(frame: JsonObject): SessionChange {
    val type = frame["type"].string
    val data = frame["data"]
    return when {
        type == "session_deleted" -> SessionChange.Deleted
        type == "session_renamed" -> data["name"].string?.let(SessionChange::Renamed) ?: SessionChange.None
        type in REFRESH_EVENTS -> SessionChange.Refresh
        type == "pi_event" -> when (data["type"].string) {
            "panel_changed" -> SessionChange.PanelChanged(data["sections"].array.orEmpty().map { it.text ?: "null" })
            in RUN_EVENTS -> SessionChange.Refresh
            else -> SessionChange.None
        }
        else -> SessionChange.None
    }
}

/** `epoch:sequence` of a frame, where the stream resumes after it. */
fun frameCursor(frame: JsonObject): String = "${frame["epoch"].text ?: "0"}:${frame["sequence"].text ?: "0"}"
