package dev.pirc.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Configured policies only; this response never proves Node enforcement. */
@Serializable
data class ConversationEnvironment(
    val version: Int,
    val sessionId: String,
    val binding: ConversationBinding,
    val project: ProjectMembership,
    val modePolicy: ConfiguredModePolicy? = null,
    val workspacePolicy: ConfiguredWorkspacePolicy,
    val enforcement: String,
) {
    init {
        binding.validate(binding.execution.workspaceId)
        require(version == 1 && sessionId.isNotEmpty() && enforcement == "not_tracked")
        require(project.revision in 1..MAX_POLICY_REVISION &&
            project.resolution in setOf("unresolved", "none", "member", "mode_unavailable"))
        require(project.workspaceId == null || project.workspaceId == binding.membership.legacyWorkspaceId)
        require(project.resolution != "none" || project.workspaceId == null)
        require(project.resolution != "member" || project.workspaceId != null)
        modePolicy?.let {
            require(it.revision in 1..MAX_POLICY_REVISION)
            require(it.definition == null || it.definition["id"]?.jsonPrimitive?.content == binding.execution.modeId)
        }
        require(project.resolution != "mode_unavailable" || modePolicy?.definition == null)
        require(project.resolution !in setOf("member", "none") || modePolicy?.definition != null)
        require(workspacePolicy.revision in 1..MAX_POLICY_REVISION)
        val cap = workspacePolicy.capabilities
        require(cap["version"] == JsonPrimitive(1))
        require(listOf("delegation", "memory_search", "remote_recall", "schedules", "web_search").all {
            cap[it] == JsonPrimitive(true) || cap[it] == JsonPrimitive(false)
        })
        require(cap["delegation_approval"] in listOf("always", "untrusted", "never").map(::JsonPrimitive))
    }
    fun validateSession(expected: String) { require(sessionId == expected) }
}

private const val MAX_POLICY_REVISION = 9_007_199_254_740_991L

@Serializable
data class ProjectMembership(val revision: Long, val workspaceId: String? = null, val resolution: String)
@Serializable
data class ConfiguredModePolicy(val revision: Long, val definition: JsonObject? = null)
@Serializable
data class ConfiguredWorkspacePolicy(val revision: Long, val capabilities: JsonObject)
