package dev.pirc.android.core

import kotlinx.serialization.Serializable

/** A session as the gateway lists it (`GET /api/sessions`). */
@Serializable
data class Session(
    val id: String,
    val workspaceId: String,
    val name: String,
    val runnerState: String = "stopped",
    val runStatus: String? = null,
    val pinnedAt: Long? = null,
    val settledAt: Long? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** The session holds a write lease on its workspace (only while a run is open). */
    val writeLease: Boolean = false,
    /** What started it other than the user: a scheduled run or a delegated task. */
    val origin: SessionOrigin? = null,
) {
    val pinned get() = pinnedAt != null
    val settled get() = settledAt != null

    /** How an update will look once the gateway applies it (shown until its reply arrives). */
    fun edited(name: String? = null, pinned: Boolean? = null, settled: Boolean? = null, now: Long = System.currentTimeMillis()) = copy(
        name = name ?: this.name,
        pinnedAt = if (pinned == null) pinnedAt else if (pinned) pinnedAt ?: now else null,
        settledAt = if (settled == null) settledAt else if (settled) settledAt ?: now else null,
    )
}

/**
 * `schedule` ([scheduleId], [dueAt]) or `delegation` ([delegationId], [fromSessionId]:
 * the assistant chat that delegated it). [title] names the schedule or the task.
 */
@Serializable
data class SessionOrigin(
    val kind: String,
    val title: String = "",
    val scheduleId: String? = null,
    val dueAt: Long? = null,
    val delegationId: String? = null,
    val fromSessionId: String? = null,
) {
    val schedule get() = kind == "schedule" && scheduleId != null
    val delegation get() = kind == "delegation"
}

@Serializable
data class Workspace(
    val id: String,
    val hostId: String,
    val displayName: String,
    /** `chat`: the assistant's chats or a chat project; else a directory (older gateways send none). */
    val kind: String = "directory",
) {
    val isChat get() = kind == "chat"

    /** A chat node's top-level chats (outside any project). */
    val isTopLevelChats get() = isChat && id == "$hostId:chats"
}

@Serializable
data class NodeWorkspace(val id: String, val displayName: String)

@Serializable
data class NodeSummary(
    val id: String,
    val connectedAt: Long = 0,
    val lastSeenAt: Long = 0,
    val workspaces: List<NodeWorkspace> = emptyList(),
)

@Serializable
data class DirEntry(
    val name: String,
    /** `dir`, `file`, `symlink` or `other`. */
    val kind: String,
    val size: Long? = null,
)

/** One directory of the workspace; [path] is workspace-relative ("" is the root). */
@Serializable
data class DirListing(val path: String, val entries: List<DirEntry>, val truncated: Boolean = false)

/** A workspace file, cut at 1 MiB ([truncated]); binary files come without [content]. */
@Serializable
data class FileContent(
    val path: String,
    val size: Long,
    val modifiedAt: Double = 0.0,
    val binary: Boolean = false,
    val truncated: Boolean = false,
    val content: String? = null,
)

@Serializable
internal data class SessionsResponse(val sessions: List<Session>)

@Serializable
internal data class WorkspacesResponse(val workspaces: List<Workspace>)

@Serializable
internal data class NodesResponse(val nodes: List<NodeSummary>)

@Serializable
internal data class ErrorBody(val error: ErrorDetail? = null)

@Serializable
internal data class ErrorDetail(val code: String? = null, val message: String? = null)
