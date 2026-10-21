package dev.pirc.android.core

import android.content.Intent
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Push notifications (docs/guides/schedules.md). The gateway sends the same
 * encrypted Web Push message to browsers and, through the user's UnifiedPush
 * distributor, to this app: a title, a short line, a tag (same tag, same
 * notification) and what to open.
 */
sealed interface PushTarget {
    data class OpenSession(val sessionId: String) : PushTarget
    data class OpenSchedules(val scheduleId: String? = null) : PushTarget
    data class OpenCalendar(
        val eventId: String,
        val occurrenceStart: String? = null,
        val date: String? = null,
        val startAt: Long? = null,
    ) : PushTarget
    data object OpenMemory : PushTarget

    companion object {
        private const val SESSION = "dev.pirc.android.target.session"
        private const val SCHEDULES = "dev.pirc.android.target.schedules"
        private const val SCHEDULE = "dev.pirc.android.target.schedule"
        private const val MEMORY = "dev.pirc.android.target.memory"
        private const val CALENDAR = "dev.pirc.android.target.calendar"
        private const val EVENT = "dev.pirc.android.target.event"
        private const val OCCURRENCE_START = "dev.pirc.android.target.occurrence_start"
        private const val EVENT_DATE = "dev.pirc.android.target.event_date"
        private const val EVENT_START_AT = "dev.pirc.android.target.event_start_at"

        fun from(json: JsonElement?): PushTarget? {
            val target = json as? JsonObject ?: return null
            fun text(key: String) = runCatching { target[key]?.jsonPrimitive?.content }.getOrNull()
            fun long(key: String) = runCatching { target[key]?.jsonPrimitive?.longOrNull }.getOrNull()
            fun flag(key: String) = runCatching { target[key]?.jsonPrimitive?.booleanOrNull }.getOrNull() == true
            return when {
                !text("sessionId").isNullOrEmpty() -> OpenSession(text("sessionId")!!)
                flag("calendar") && !text("eventId").isNullOrEmpty() -> OpenCalendar(
                    text("eventId")!!,
                    text("occurrenceStart"),
                    text("date"),
                    long("startAt"),
                )
                flag("schedules") -> OpenSchedules(text("scheduleId"))
                flag("memory") -> OpenMemory
                else -> null
            }
        }

        /** What a notification's intent asks to open. */
        fun from(intent: Intent?): PushTarget? {
            intent ?: return null
            intent.getStringExtra(SESSION)?.let { return OpenSession(it) }
            if (intent.getBooleanExtra(CALENDAR, false)) {
                intent.getStringExtra(EVENT)?.takeIf { it.isNotBlank() }?.let {
                    return OpenCalendar(
                        it,
                        intent.getStringExtra(OCCURRENCE_START),
                        intent.getStringExtra(EVENT_DATE),
                        intent.getLongExtra(EVENT_START_AT, Long.MIN_VALUE).takeUnless { value -> value == Long.MIN_VALUE },
                    )
                }
            }
            if (intent.getBooleanExtra(SCHEDULES, false)) return OpenSchedules(intent.getStringExtra(SCHEDULE))
            if (intent.getBooleanExtra(MEMORY, false)) return OpenMemory
            return null
        }

        fun Intent.putTarget(target: PushTarget): Intent = apply {
            when (target) {
                is OpenSession -> putExtra(SESSION, target.sessionId)
                is OpenCalendar -> {
                    putExtra(CALENDAR, true)
                    putExtra(EVENT, target.eventId)
                    target.occurrenceStart?.let { putExtra(OCCURRENCE_START, it) }
                    target.date?.let { putExtra(EVENT_DATE, it) }
                    target.startAt?.let { putExtra(EVENT_START_AT, it) }
                }
                is OpenSchedules -> {
                    putExtra(SCHEDULES, true)
                    target.scheduleId?.let { putExtra(SCHEDULE, it) }
                }
                OpenMemory -> putExtra(MEMORY, true)
            }
        }
    }
}

/** One interaction's out-of-band notification state. The epoch is the
 * interaction row's epoch, not the daemon event-stream epoch. */
data class PushInteraction(
    val kind: String,
    val sessionId: String,
    val interactionId: String,
    val interactionEpoch: String,
) {
    val isResolved: Boolean get() = kind == "interaction_answered"
    val isCreated: Boolean get() = kind == "interaction_created"
}

/** One notification, as the gateway sent it. */
data class PushNote(
    val title: String,
    val body: String,
    val tag: String,
    val target: PushTarget?,
    val kind: String? = null,
    val sessionId: String? = null,
    val interactionId: String? = null,
    val interactionEpoch: String? = null,
) {
    /** Null for legacy/session notices and malformed or unknown event kinds. */
    val interaction: PushInteraction?
        get() {
            val eventKind = kind?.takeIf { it == "interaction_created" || it == "interaction_answered" } ?: return null
            val session = sessionId?.takeIf { it.isNotBlank() } ?: return null
            val id = interactionId?.takeIf { it.isNotBlank() } ?: return null
            val epoch = interactionEpoch?.takeIf { it.isNotBlank() } ?: return null
            if (epoch != "0" && !epoch.matches(Regex("[1-9][0-9]*"))) return null
            return PushInteraction(eventKind, session, id, epoch)
        }
    val isInteractionRefresh: Boolean get() = kind == "interaction_refresh" && !sessionId.isNullOrBlank()

    companion object {
        /** The decrypted message; null when it is not one of the gateway's. */
        fun parse(bytes: ByteArray): PushNote? = runCatching {
            val json = PircJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as JsonObject
            val kind = json["kind"]?.jsonPrimitive?.content
            val interactionControl = kind in setOf("interaction_answered", "interaction_refresh")
            val title = json["title"]?.jsonPrimitive?.content.orEmpty()
            if (title.isBlank() && !interactionControl) return null
            PushNote(
                title = title,
                body = json["body"]?.jsonPrimitive?.content.orEmpty(),
                tag = json["tag"]?.jsonPrimitive?.content ?: title,
                target = PushTarget.from(json["target"]),
                kind = kind,
                sessionId = json["sessionId"]?.jsonPrimitive?.content,
                interactionId = json["interactionId"]?.jsonPrimitive?.content,
                interactionEpoch = json["interactionEpoch"]?.jsonPrimitive?.content,
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
