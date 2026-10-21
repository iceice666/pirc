package dev.pirc.android.core.rooms

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * How the room stream changes what the app shows (plans/rewrite/12-android.md,
 * decision 4): the port of the web's `room-events.ts`, one pure step per
 * event, held to the same golden cases (`fixtures/timeline/rooms`).
 * [RoomsView] keeps rooms, messages and faces as the gateway's JSON, so the
 * app sees exactly what the gateway sent; the reducer reads only the fields
 * it needs.
 */
data class RoomsView(
    /** The asking user: their own messages are read. */
    val user: String,
    val currentId: String,
    /** In activity order; archived ones only while open. */
    val rooms: List<JsonObject> = emptyList(),
    /** The open room when it is not in the list (archived, opened by a link). */
    val detached: JsonObject? = null,
    /** The open room's messages, in seq order. */
    val messages: List<JsonObject> = emptyList(),
    val pinned: List<JsonObject> = emptyList(),
    /** Others typing in each room: user → when their signal lapses. */
    val typing: Map<String, Map<String, Long>> = emptyMap(),
    /** Faces thinking in each room now: room → face ids. */
    val thinking: Map<String, List<String>> = emptyMap(),
    val faces: List<JsonObject> = emptyList(),
    /** What each face is doing now: face id → its presence. */
    val facePresence: Map<String, JsonObject> = emptyMap(),
    /** Bumped whenever an open loop changes, for lists that show them. */
    val loopsRevision: Int = 0,
    /** Bumped whenever a wake changes, for lists that show them. */
    val wakesRevision: Int = 0,
    /** The thread open beside the room, and its messages in seq order. */
    val threadId: String? = null,
    val threadMessages: List<JsonObject> = emptyList(),
    /**
     * What each thread's workers did last, from the stream (open or not): a
     * worker's anchor shows it as its progress, updated in place.
     */
    val threadActivity: Map<String, ThreadActivity> = emptyMap(),
)

data class ThreadActivity(val text: String, val at: Long)

/** What an event asks the app to fetch or send after it. */
sealed interface RoomEffect {
    /** A room appeared that the list does not have. */
    data object RefreshList : RoomEffect
    /** Another device read a room: the gateway says how many are unread. */
    data class RefreshRoom(val roomId: String) : RoomEffect
    /** Something new in the open room: read it if the app is in front. */
    data object MarkRead : RoomEffect
    /** A worker started or ended in the open thread. */
    data object RefreshThreadWorkers : RoomEffect
}

data class Reduced(val view: RoomsView, val effects: List<RoomEffect> = emptyList())

// ---- reading the gateway's JSON ----

internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
internal val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

/** JavaScript truthiness of a field, as the web's reducer tests it. */
internal val JsonElement?.truthy: Boolean
    get() = when (this) {
        null, JsonNull -> false
        is JsonPrimitive -> when {
            isString -> content.isNotEmpty()
            booleanOrNull != null -> booleanOrNull!!
            else -> (doubleOrNull ?: 0.0) != 0.0
        }
        else -> true
    }

internal val JsonObject.id: String get() = this["id"].str ?: ""
internal val JsonObject.seq: Long get() = this["seq"].long ?: 0

/** Newest activity first, then the newest room. */
val byActivity: Comparator<JsonObject> = compareByDescending<JsonObject> { it["lastActivityAt"].long ?: 0 }
    .thenByDescending { it["createdAt"].long ?: 0 }

/** A thread message as one line of progress, if it says what a worker does. */
fun activityOf(message: JsonObject): ThreadActivity? {
    if (message["speaker"].str?.startsWith("worker:") != true) return null
    val body = message["body"]
    val raw = when (message["kind"].str) {
        "tool" -> body["summary"].str ?: body["tool"].str ?: ""
        "text" -> body["text"].str ?: ""
        else -> ""
    }
    val text = raw.split('\n').firstOrNull { it.isNotBlank() }?.trim() ?: ""
    if (text.isEmpty()) return null
    return ThreadActivity(
        text = if (text.length > 120) text.take(119) + "…" else text,
        at = message["updatedAt"].long ?: message["createdAt"].long ?: 0,
    )
}

/** One event of the stream: `{type, roomId, epoch, sequence, data, timestamp}`. */
fun RoomsView.reduce(event: JsonObject): Reduced {
    val roomId = event["roomId"].str ?: ""
    val data = event["data"]
    return when (event["type"].str) {
        "brain_presence" -> {
            val face = data["face"].str ?: return Reduced(this)
            val others = thinking[roomId].orEmpty().filter { it != face }
            Reduced(copy(thinking = thinking + (roomId to if (data["state"].str == "thinking") others + face else others)))
        }
        "room_message" -> {
            val message = data["message"] as? JsonObject ?: return Reduced(this)
            val messageRoom = message["roomId"].str
            val open = messageRoom == currentId
            var next = this
            if (open) next = next.copy(messages = appendMessage(messages, message))
            val speaker = message["speaker"].str
            val sender = message["user"].str
            val mine = speaker == "user" && sender == user
            if (!mine) next = next.copy(rooms = bumpUnread(next.rooms, messageRoom ?: "", message.seq))
            if (speaker == "user" && sender != null) next = next.copy(typing = stopTyping(next.typing, messageRoom ?: "", sender))
            Reduced(next, if (open) listOf(RoomEffect.MarkRead) else emptyList())
        }
        "room_message_updated" -> {
            val message = data["message"] as? JsonObject ?: return Reduced(this)
            Reduced(replaceMessage(message))
        }
        "room_changed" -> {
            val room = data["room"] as? JsonObject ?: return Reduced(this)
            if (rooms.none { it.id == room.id } && !room["archivedAt"].truthy) {
                Reduced(this, listOf(RoomEffect.RefreshList))
            } else {
                Reduced(mergeRoom(room))
            }
        }
        "room_read" -> {
            if (data["user"].str != user) return Reduced(this)
            val room = rooms.firstOrNull { it.id == roomId }
            val readSeq = data["readSeq"].long ?: 0
            // Another device read it: the count is the gateway's to say.
            if (room != null && readSeq > (room["readSeq"].long ?: 0)) {
                Reduced(this, listOf(RoomEffect.RefreshRoom(room.id)))
            } else {
                Reduced(this)
            }
        }
        "room_typing" -> {
            val who = data["user"].str ?: return Reduced(this)
            val until = data["expiresAt"].long ?: return Reduced(this)
            Reduced(copy(typing = typing + (roomId to typing[roomId].orEmpty() + (who to until))))
        }
        "loop_changed" -> Reduced(copy(loopsRevision = loopsRevision + 1))
        "wake_changed" -> Reduced(copy(wakesRevision = wakesRevision + 1))
        "face_changed" -> {
            val face = data["face"] as? JsonObject ?: return Reduced(this)
            Reduced(copy(faces = upsertFace(faces, face)))
        }
        "face_presence" -> {
            val presence = data as? JsonObject ?: return Reduced(this)
            val faceId = presence["faceId"].str ?: return Reduced(this)
            Reduced(copy(facePresence = facePresence + (faceId to presence)))
        }
        "thread_message", "thread_message_updated" -> {
            val message = data["message"] as? JsonObject ?: return Reduced(this)
            val threadOf = data["threadId"].str ?: return Reduced(this)
            val activity = activityOf(message)
            val latest = threadActivity[threadOf]
            var next = this
            if (activity != null && (latest == null || activity.at >= latest.at)) {
                next = next.copy(threadActivity = threadActivity + (threadOf to activity))
            }
            if (threadOf != threadId) return Reduced(next)
            Reduced(
                next.copy(threadMessages = upsertBySeq(threadMessages, message)),
                // A worker started or ended: its list says so.
                if (message["kind"].str == "line") listOf(RoomEffect.RefreshThreadWorkers) else emptyList(),
            )
        }
        else -> Reduced(this)
    }
}

/** A new message of the open room, once, in seq order. */
fun appendMessage(messages: List<JsonObject>, message: JsonObject): List<JsonObject> {
    if (messages.any { it.id == message.id }) return messages
    val last = messages.lastOrNull()
    return if (last == null || message.seq > last.seq) messages + message
    else (messages + message).sortedBy { it.seq }
}

/** A message changed: in place, and among the pins while it is pinned. */
fun RoomsView.replaceMessage(message: JsonObject): RoomsView {
    val others = pinned.filter { it.id != message.id }
    return copy(
        messages = messages.map { if (it.id == message.id) message else it },
        pinned = if (message["pinnedAt"].truthy && message["roomId"].str == currentId) others + message else others,
    )
}

/** Someone else's new message: unread until read. A replayed one counts once. */
fun bumpUnread(rooms: List<JsonObject>, roomId: String, seq: Long): List<JsonObject> = rooms.map { room ->
    if (room.id == roomId && seq > (room["readSeq"].long ?: 0) && seq > (room["lastSeq"].long ?: 0)) {
        JsonObject(room + mapOf(
            "unread" to JsonPrimitive((room["unread"].long ?: 0) + 1),
            "lastSeq" to JsonPrimitive(seq),
        ))
    } else room
}

fun stopTyping(typing: Map<String, Map<String, Long>>, roomId: String, user: String): Map<String, Map<String, Long>> =
    typing + (roomId to typing[roomId].orEmpty() - user)

/** A room's shared fields changed: keep the user's own (reads, unread). */
fun RoomsView.mergeRoom(room: JsonObject): RoomsView {
    fun keep(old: JsonObject) = JsonObject(old + room)
    val nextRooms = if (rooms.any { it.id == room.id }) {
        rooms.map { if (it.id == room.id) keep(it) else it }
            .filter { !it["archivedAt"].truthy || it.id == currentId }
            .sortedWith(byActivity)
    } else rooms
    return copy(rooms = nextRooms, detached = detached?.let { if (it.id == room.id) keep(it) else it })
}

fun upsertFace(faces: List<JsonObject>, face: JsonObject): List<JsonObject> =
    if (faces.any { it.id == face.id }) faces.map { if (it.id == face.id) face else it } else faces + face

/** A thread message, new or changed, in seq order. */
fun upsertBySeq(messages: List<JsonObject>, message: JsonObject): List<JsonObject> =
    (messages.filter { it.id != message.id } + message).sortedBy { it.seq }

/** Where faces think as the stream (re)starts: the `ready` frame's `presence`. */
fun thinkingFrom(presence: List<JsonObject>): Map<String, List<String>> {
    val thinking = linkedMapOf<String, List<String>>()
    for (item in presence) {
        val face = item["face"].str ?: continue
        val room = item["roomId"].str ?: continue
        thinking[room] = thinking[room].orEmpty() + face
    }
    return thinking
}

/** What each face is doing as the stream (re)starts: the `ready` frame's `faces`. */
fun facePresenceFrom(presence: List<JsonObject>): Map<String, JsonObject> =
    presence.mapNotNull { item -> item["faceId"].str?.let { it to item } }.toMap()

/** Who else is typing in a room at [now]. */
fun RoomsView.typingIn(roomId: String, now: Long): List<String> =
    typing[roomId].orEmpty().filter { (who, until) -> who != user && until > now }.keys.toList()

/** The open room: from the list, or the detached one. */
val RoomsView.current: JsonObject? get() = rooms.firstOrNull { it.id == currentId } ?: detached
