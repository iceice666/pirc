package dev.pirc.android.core

import dev.pirc.android.core.timeline.QueueItem
import dev.pirc.android.core.timeline.get
import dev.pirc.android.core.timeline.number
import dev.pirc.android.core.timeline.text
import dev.pirc.android.core.timeline.truthy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Who may act on a session. Only the lease holder can send commands or answer questions. */
data class ControlLease(
    val holderClientId: String? = null,
    val heldByCurrentClient: Boolean = false,
    /** The lease exists but its TTL has passed; anyone may acquire it. */
    val expired: Boolean = false,
    val generation: Long? = null,
    val expiresAt: Long? = null,
) {
    val free get() = holderClientId == null || expired

    companion object {
        /** A `{lease}` reply (or the lease itself), as seen by [clientId]. */
        fun from(raw: JsonElement?, clientId: String): ControlLease {
            val lease = raw["lease"] ?: raw.takeIf { it["clientId"] != null } ?: return ControlLease()
            val holder = lease["clientId"].text
            val expired = lease["expired"].truthy
            return ControlLease(
                holderClientId = holder,
                heldByCurrentClient = holder == clientId && !expired,
                expired = expired,
                generation = lease["generation"].number,
                expiresAt = lease["expiresAt"].number,
            )
        }
    }
}

/** What the node did with a command: `accepted`, `rejected`, `outcome_unknown`, ... */
data class CommandReceipt(val commandId: String, val status: String, val message: String?) {
    val accepted get() = status == "accepted"
}

data class Upload(val id: String, val mimeType: String, val byteSize: Long, val kind: String = "image")

sealed interface InteractionAnswer {
    data class Text(val value: String) : InteractionAnswer
    data class Choices(val values: List<String>) : InteractionAnswer
    data class Confirm(val value: Boolean) : InteractionAnswer
    data object Cancel : InteractionAnswer

    /** The agent RPC's answer shape, as the web sends it. */
    fun rpc() = buildJsonObject {
        when (this@InteractionAnswer) {
            Cancel -> put("cancelled", true)
            is Confirm -> put("confirmed", value)
            is Text -> put("value", value)
            is Choices -> {
                put("value", values.joinToString(", "))
                put("values", JsonArray(values.map(::JsonPrimitive)))
            }
        }
    }
}

val THINKING_LEVELS = listOf("off", "minimal", "low", "medium", "high", "xhigh")

data class ModelOption(
    val id: String,
    val provider: String,
    val displayName: String,
    val contextWindow: Long?,
    val thinkingLevels: List<String>,
) {
    val key get() = "$provider/$id"
}

@Serializable
internal data class RawModel(
    val id: String,
    val provider: String,
    val name: String? = null,
    val contextWindow: Long? = null,
    val reasoning: Boolean = false,
) {
    fun option() = ModelOption(id, provider, name ?: id, contextWindow, if (reasoning) THINKING_LEVELS else listOf("off"))
}

@Serializable
internal data class ModelsResponse(val models: List<RawModel> = emptyList())

/** Command payloads, as the node validates them (see the web's `api.command`). */
object Commands {
    fun message(kind: String, text: String, uploadIds: List<String>) = buildJsonObject {
        put("type", kind)
        put("message", text)
        if (uploadIds.isNotEmpty()) put("uploadIds", JsonArray(uploadIds.map(::JsonPrimitive)))
    }

    fun setModel(provider: String, modelId: String) = buildJsonObject {
        put("type", "set_model")
        put("provider", provider)
        put("modelId", modelId)
    }

    fun setThinking(level: String) = buildJsonObject {
        put("type", "set_thinking")
        put("level", level)
    }

    /** Deliver a queued message now, interrupting the current model call or tool. */
    fun sendNow(item: QueueItem) = buildJsonObject {
        put("type", "send_now")
        put("queue", if (item.kind == "follow_up") "followUp" else "steering")
        put("index", item.index)
        put("message", item.content)
    }

    fun simple(type: String) = buildJsonObject { put("type", type) }
}

/** The part of the API that [syncControl] needs. */
interface ControlApi {
    suspend fun control(): ControlLease
    suspend fun acquire(): ControlLease
    suspend fun heartbeat(generation: Long): ControlLease
}

/** A 409 means the node rejected the lease; anything else may be a transient blip. */
private fun rejected(error: Throwable) = error is ApiException && error.status == 409

/**
 * Keep this client's lease alive, and pick control back up when nobody else
 * holds a live lease; a port of the web's `syncControl`. Never forces: a lease
 * another device keeps renewing is left alone. Returns the lease to show, or
 * null to keep the current one (transient failure; the next sync retries
 * before the TTL runs out). A dead device token still throws.
 */
suspend fun syncControl(api: ControlApi, current: ControlLease, mayAcquire: Boolean): ControlLease? {
    val lease: ControlLease
    try {
        if (current.heldByCurrentClient && current.generation != null) {
            try {
                return api.heartbeat(current.generation)
            } catch (error: java.io.IOException) {
                if (error is ApiException && error.unauthorized) throw error
                if (!rejected(error)) return null
                // Expired or superseded: look at who holds it now.
            }
        }
        lease = api.control()
    } catch (error: java.io.IOException) {
        if (error is ApiException && error.unauthorized) throw error
        return null
    }
    if (lease.heldByCurrentClient || !lease.free || !mayAcquire) return lease
    return try {
        api.acquire()
    } catch (error: java.io.IOException) {
        if (error is ApiException && error.unauthorized) throw error
        // Lost a race with another client: report whoever holds it now.
        if (rejected(error)) runCatching { api.control() }.getOrDefault(lease) else lease
    }
}
