package dev.pirc.android.core

import android.content.Intent
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Push notifications. The gateway sends the same
 * encrypted Web Push message to browsers and, through the user's UnifiedPush
 * distributor, to this app: a title, a short line, a tag (same tag, same
 * notification) and what to open.
 */
sealed interface PushTarget {
    /** A room (`{roomId}`): most notifications are about one. */
    data class OpenRoom(val roomId: String) : PushTarget

    /** A session, in the engine (`{sessionId}`). */
    data class OpenSession(val sessionId: String) : PushTarget

    /** What pirc remembers, in the engine (`{memory: true}`). */
    data object OpenMemory : PushTarget

    companion object {
        private const val SESSION = "dev.pirc.android.target.session"
        private const val ROOM = "dev.pirc.android.target.room"

        fun from(json: JsonElement?): PushTarget? {
            val target = json as? JsonObject ?: return null
            fun text(key: String) = runCatching { target[key]?.jsonPrimitive?.content }.getOrNull()?.takeIf { it.isNotEmpty() }
            text("roomId")?.let { return OpenRoom(it) }
            text("sessionId")?.let { return OpenSession(it) }
            return if (text("memory") == "true") OpenMemory else null
        }

        /** What a notification's intent asks to open. */
        fun from(intent: Intent?): PushTarget? {
            intent ?: return null
            intent.getStringExtra(ROOM)?.let { return OpenRoom(it) }
            return intent.getStringExtra(SESSION)?.let { OpenSession(it) }
        }

        fun Intent.putTarget(target: PushTarget): Intent = apply {
            when (target) {
                is OpenRoom -> putExtra(ROOM, target.roomId)
                is OpenSession -> putExtra(SESSION, target.sessionId)
                OpenMemory -> Unit
            }
        }
    }
}

/** One notification, as the gateway sent it (`crates/pirc-gateway/src/push.rs`). */
data class PushNote(
    val title: String,
    val body: String,
    val tag: String,
    val target: PushTarget?,
) {
    companion object {
        /** The decrypted message; null when it is not one of the gateway's. */
        fun parse(bytes: ByteArray): PushNote? = runCatching {
            val json = PircJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as JsonObject
            val title = json["title"]?.jsonPrimitive?.content.orEmpty()
            if (title.isBlank()) return null
            PushNote(
                title = title,
                body = json["body"]?.jsonPrimitive?.content.orEmpty(),
                tag = json["tag"]?.jsonPrimitive?.content ?: title,
                target = PushTarget.from(json["target"]),
            )
        }.getOrNull()
    }
}

/** A place that gets the user's notifications (`GET /api/push`). */
@Serializable
data class PushPlace(
    val id: String,
    val kind: String,
    val name: String,
    val host: String,
    val createdAt: Long = 0,
    val lastSuccessAt: Long? = null,
    val failing: Boolean = false,
)

@Serializable
data class PushInfo(val publicKey: String, val subscriptions: List<PushPlace> = emptyList())

@Serializable
internal data class PushSubscribed(val subscription: PushPlace)

@Serializable
internal data class PushTested(val delivered: Int = 0)
