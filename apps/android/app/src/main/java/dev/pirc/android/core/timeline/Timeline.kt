package dev.pirc.android.core.timeline

import dev.pirc.android.core.Session
import kotlinx.serialization.json.JsonElement

/*
 * The chat timeline, ported from the web client (`apps/web/src/lib/types.ts`).
 * Timestamps are epoch milliseconds. The shared fixtures in `fixtures/timeline`
 * pin this port to the web implementation; change both together.
 */

/** An image inline in a message or tool result; `base64` is the raw data. */
data class InlineImage(val mimeType: String, val base64: String)

data class ToolCall(
    val id: String,
    val name: String,
    val title: String? = null,
    /** `running`, `succeeded` or `failed`. */
    val status: String = "running",
    val input: JsonElement? = null,
    val output: String? = null,
    /** Unified diff reported by edit-style tools. */
    val diff: String? = null,
    val images: List<InlineImage> = emptyList(),
    val startedAt: Long? = null,
    val endedAt: Long? = null,
)

/** Fields of a tool that an event changes; `null` keeps the current value. */
data class ToolUpdate(
    val id: String,
    val name: String? = null,
    val title: String? = null,
    val status: String? = null,
    val input: JsonElement? = null,
    val output: String? = null,
    val diff: String? = null,
    val images: List<InlineImage>? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
)

data class Message(
    val id: String,
    /** `user`, `assistant` or `system`. */
    val role: String,
    val content: String,
    val createdAt: Long,
    /** When a streamed assistant message finished; orders notices raised meanwhile. */
    val completedAt: Long? = null,
    val isPartial: Boolean = false,
    val thinking: String? = null,
    val thinkingRedacted: Boolean = false,
    /** `error` or `aborted` when the turn did not finish normally. */
    val stopReason: String? = null,
    val errorMessage: String? = null,
    val model: String? = null,
    val tools: List<ToolCall> = emptyList(),
    val images: List<InlineImage> = emptyList(),
    /** For system entries: notice, compaction, branch, bash, custom, team, background. */
    val systemKind: String? = null,
    /** For notices and bash runs: info, warning, error. */
    val level: String? = null,
    val label: String? = null,
    val meta: String? = null,
)

data class RunState(
    val id: String?,
    val status: String,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val failureReason: String? = null,
)

/** `index` counts the user messages of its queue; `send_now` addresses the message by it. */
data class QueueItem(val id: String, val kind: String, val content: String, val index: Int)

data class InteractionOption(val value: String, val label: String, val description: String? = null)

data class Interaction(
    val id: String,
    val runnerEpoch: String,
    /** `select`, `confirm`, `input` or `editor`. */
    val kind: String,
    val title: String,
    val description: String? = null,
    val expiresAt: Long? = null,
    val status: String = "pending",
    val options: List<InteractionOption> = emptyList(),
    val multiple: Boolean = false,
    val placeholder: String? = null,
    val initialValue: String? = null,
)

/** One session as a client sees it: snapshot plus every event applied since. */
data class SessionState(
    val session: Session,
    val runnerStatus: String,
    val run: RunState?,
    val messages: List<Message>,
    val interactions: List<Interaction>,
    val queue: List<QueueItem>,
    val cursor: String,
    val runnerEpoch: String,
    val selectedModelId: String? = null,
    val selectedModelProvider: String? = null,
    val thinkingLevel: String? = null,
    val widgets: Map<String, List<String>> = emptyMap(),
    val statuses: Map<String, String> = emptyMap(),
    /** The events can no longer be applied (epoch changed, reset): fetch a new snapshot. */
    val needsSnapshot: Boolean = false,
)
