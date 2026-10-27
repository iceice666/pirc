package dev.pirc.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

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
    companion object { private const val MAX_REVISION = 9_007_199_254_740_991L }
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

/** Validate captured client intent before queueing; malformed input never becomes legacy mode. */
fun commandBinding(value: JsonElement): ConversationBinding = try {
    PircJson.decodeFromJsonElement(ConversationBinding.serializer(), value).also {
        it.validate(it.execution.workspaceId)
    }
} catch (error: IllegalArgumentException) {
    throw ApiException(400, "invalid_input", "Invalid conversation environment; reload before sending.", error)
}
