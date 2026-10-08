package dev.pirc.android.core

import android.content.Intent
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Push notifications (docs/history/cron.md, phase 4). The gateway sends the same
 * encrypted Web Push message to browsers and, through the user's UnifiedPush
 * distributor, to this app: a title, a short line, a tag (same tag, same
 * notification) and what to open.
 */
sealed interface PushTarget {
    data class OpenSession(val sessionId: String) : PushTarget
    data class OpenSchedules(val scheduleId: String? = null) : PushTarget
    data object OpenMemory : PushTarget

    companion object {
        private const val SESSION = "dev.pirc.android.target.session"
        private const val SCHEDULES = "dev.pirc.android.target.schedules"
        private const val SCHEDULE = "dev.pirc.android.target.schedule"
        private const val MEMORY = "dev.pirc.android.target.memory"

        fun from(json: JsonElement?): PushTarget? {
            val target = json as? JsonObject ?: return null
            fun text(key: String) = runCatching { target[key]?.jsonPrimitive?.content }.getOrNull()
            fun flag(key: String) = runCatching { target[key]?.jsonPrimitive?.booleanOrNull }.getOrNull() == true
            return when {
                !text("sessionId").isNullOrEmpty() -> OpenSession(text("sessionId")!!)
                flag("schedules") -> OpenSchedules(text("scheduleId"))
                flag("memory") -> OpenMemory
                else -> null
            }
        }

        /** What a notification's intent asks to open. */
        fun from(intent: Intent?): PushTarget? {
            intent ?: return null
            intent.getStringExtra(SESSION)?.let { return OpenSession(it) }
            if (intent.getBooleanExtra(SCHEDULES, false)) return OpenSchedules(intent.getStringExtra(SCHEDULE))
            if (intent.getBooleanExtra(MEMORY, false)) return OpenMemory
            return null
        }

        fun Intent.putTarget(target: PushTarget): Intent = apply {
            when (target) {
                is OpenSession -> putExtra(SESSION, target.sessionId)
                is OpenSchedules -> {
                    putExtra(SCHEDULES, true)
                    target.scheduleId?.let { putExtra(SCHEDULE, it) }
                }
                OpenMemory -> putExtra(MEMORY, true)
            }
        }
    }
}

/** One notification, as the gateway sent it. */
data class PushNote(val title: String, val body: String, val tag: String, val target: PushTarget?) {
    companion object {
        /** The decrypted message; null when it is not one of the gateway's. */
        fun parse(bytes: ByteArray): PushNote? = runCatching {
            val json = PircJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as JsonObject
            val title = json["title"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return null
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
