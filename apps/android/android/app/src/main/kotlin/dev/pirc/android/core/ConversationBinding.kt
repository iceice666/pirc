package dev.pirc.android.core

import kotlinx.serialization.Serializable

/** Legacy association adapter, not permission to switch folders or project grants. */
@Serializable
data class ConversationBinding(
    val version: Int,
    val membership: ConversationMembership,
    val execution: ConversationExecution,
) {
    fun validate(workspaceId: String) {
        require(version == 1 && workspaceId.isNotEmpty() &&
            membership.revision in 1..MAX_REVISION &&
            membership.legacyWorkspaceId == workspaceId &&
            execution.generation in 1..MAX_REVISION &&
            execution.workspaceId == workspaceId &&
            (execution.nodeId == null || execution.nodeId.isNotEmpty()) &&
            execution.modeId.isNotEmpty()) { "Unsupported or inconsistent conversation binding" }
    }
    private companion object { const val MAX_REVISION = 9_007_199_254_740_991L }
}

@Serializable
data class ConversationMembership(val revision: Long, val legacyWorkspaceId: String)

@Serializable
data class ConversationExecution(
    val generation: Long,
    val workspaceId: String,
    val nodeId: String? = null,
    val modeId: String,
)
