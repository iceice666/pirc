package dev.pirc.android.core

import kotlinx.serialization.Serializable

/**
 * The assistant's memory proposals (plans/assistant.md): changes to the USER
 * entries that wait for the user's approval. Mirrors the web's `memory.ts`;
 * the phone only reviews proposals.
 */
@Serializable
data class MemoryProposal(
    val id: String,
    /** add, replace or remove. */
    val action: String,
    val targetId: String? = null,
    val targetRevision: Int? = null,
    val content: String? = null,
    val quote: String = "",
    val sessionId: String = "",
    /** pending, approved or rejected. */
    val status: String = "pending",
    val createdAt: Long = 0,
    /** The USER entry it changes, as it is now. */
    val target: MemoryTarget? = null,
) {
    val pending get() = status == "pending"

    /** The revision of the changed entry the user was shown, sent with an approval. */
    val shownRevision get() = target?.revision
}

@Serializable
data class MemoryTarget(val id: String, val content: String, val revision: Int)

@Serializable
data class MemoryView(
    val proposals: List<MemoryProposal> = emptyList(),
    /** Names of the chats proposals came from, by id. */
    val sessions: Map<String, String> = emptyMap(),
)

/** "Remember: …", "Change: … → …", "Forget: …" */
fun MemoryProposal.describe(): String = when (action) {
    "add" -> "Remember: ${content.orEmpty()}"
    "replace" -> "Change: ${target?.content ?: "an entry"} → ${content.orEmpty()}"
    "remove" -> "Forget: ${target?.content ?: content.orEmpty()}"
    else -> content.orEmpty()
}
