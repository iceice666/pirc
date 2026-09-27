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
) {
    val pinned get() = pinnedAt != null
    val settled get() = settledAt != null
}

@Serializable
data class Workspace(
    val id: String,
    val hostId: String,
    val displayName: String,
)

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
internal data class SessionsResponse(val sessions: List<Session>)

@Serializable
internal data class WorkspacesResponse(val workspaces: List<Workspace>)

@Serializable
internal data class NodesResponse(val nodes: List<NodeSummary>)

@Serializable
internal data class ErrorBody(val error: ErrorDetail? = null)

@Serializable
internal data class ErrorDetail(val code: String? = null, val message: String? = null)
