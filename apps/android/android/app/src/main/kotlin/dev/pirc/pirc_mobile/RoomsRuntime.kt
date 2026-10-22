package dev.pirc.pirc_mobile

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.rooms.RoomEffect
import dev.pirc.android.core.rooms.RoomSignal
import dev.pirc.android.core.rooms.RoomStream
import dev.pirc.android.core.rooms.RoomsView
import dev.pirc.android.core.rooms.appendMessage
import dev.pirc.android.core.rooms.byActivity
import dev.pirc.android.core.rooms.current
import dev.pirc.android.core.rooms.facePresenceFrom
import dev.pirc.android.core.rooms.mergeRoom
import dev.pirc.android.core.rooms.reduce
import dev.pirc.android.core.rooms.replaceMessage
import dev.pirc.android.core.rooms.thinkingFrom
import dev.pirc.android.core.rooms.upsertFace
import dev.pirc.android.core.urlSegment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Messages per page, like the web. */
internal const val ROOM_PAGE = 50

/** At most one typing signal this often (the gateway's signals last 6 s). */
internal const val TYPING_THROTTLE_MS = 3_000L

/**
 * The rooms' domain (plans/rewrite/12-android.md): what the room pages show,
 * kept here like a session's state used to be. It loads the list and the open
 * room, follows `/api/events?rooms=1` through the shared reducer
 * ([RoomsView.reduce], the port of the web's `room-events.ts`), carries out
 * what each event asks for, and publishes one snapshot ([wire]) to Flutter,
 * which only renders it. Everything runs on [scope]'s single thread; the
 * tokens drop replies that a later call made stale.
 */
class RoomsRuntime internal constructor(
    private val scope: CoroutineScope,
    private val api: suspend () -> PircApi,
    /** Tells Flutter: `rooms` (the snapshot) and `roomsThreadWorkers`. */
    private val publish: (type: String, data: Any?) -> Unit,
    private val stream: (PircApi) -> Flow<RoomSignal> = { RoomStream(it).open() },
    private val clock: () -> Long = System::currentTimeMillis,
    /** A room is on screen with the app in front: its notification is read. */
    private val onShowing: (roomId: String) -> Unit = {},
    /** Coalesces bursts of events into one snapshot; 0 publishes at once (tests). */
    private val publishDelayMs: Long = 32,
) {
    private var view: RoomsView? = null
    private var following: Job? = null
    private var connection = "offline"
    private var loading = false
    private var opening = false
    private var error: String? = null
    private var hasMore = false
    private var archived: List<JsonObject>? = null
    private var threadWorkers: List<JsonElement> = emptyList()
    private var threadError: String? = null
    private var visible = false
    private var lastTyping = 0L
    private var loadToken = 0
    private var threadToken = 0
    private var pendingPublish: Job? = null

    val started: Boolean get() = view != null

    /**
     * Load the list and [roomId] (`general` by default), then follow the
     * stream. Starting again only opens the room.
     */
    suspend fun start(roomId: String?) {
        val current = view
        if (current != null) {
            if (roomId != null && roomId != current.currentId) open(roomId)
            else changed()
            return
        }
        view = RoomsView(user = "", currentId = roomId ?: "general")
        loading = true
        changed()
        reload()
        if (view == null) return
        val connected = try {
            api()
        } catch (e: ApiException) {
            error = e.message
            changed()
            return
        }
        following = scope.launch { stream(connected).collect(::signal) }
    }

    /** Stop following and forget everything (unpaired, or another account). */
    fun stop() {
        following?.cancel()
        following = null
        pendingPublish?.cancel()
        pendingPublish = null
        view = null
        connection = "offline"
        loading = false
        opening = false
        error = null
        hasMore = false
        archived = null
        threadWorkers = emptyList()
        threadError = null
        lastTyping = 0
        loadToken++
        threadToken++
        publish("rooms", null)
    }

    /** The app is in front (or not): reads only count while it is. */
    suspend fun setVisible(visible: Boolean) {
        this.visible = visible
        if (visible) markRead()
    }

    private suspend fun signal(signal: RoomSignal) {
        val current = view ?: return
        when (signal) {
            RoomSignal.Connected -> connection = "connected"
            RoomSignal.Reconnecting -> connection = "reconnecting"
            is RoomSignal.Ready -> view = current.copy(
                thinking = thinkingFrom(signal.presence),
                facePresence = signal.faces?.let(::facePresenceFrom) ?: current.facePresence,
            )
            RoomSignal.Reset -> {
                changed()
                reload()
                return
            }
            is RoomSignal.Event -> {
                val reduced = current.reduce(signal.event)
                view = reduced.view
                changed()
                reduced.effects.forEach { effect -> scope.launch { run(effect) } }
                return
            }
            is RoomSignal.Closed -> {
                connection = "stopped"
                error = signal.error.message
            }
        }
        changed()
    }

    private suspend fun run(effect: RoomEffect) = when (effect) {
        RoomEffect.RefreshList -> quietly { refreshList() }
        is RoomEffect.RefreshRoom -> quietly { refreshRoom(effect.roomId) }
        RoomEffect.MarkRead -> markRead()
        RoomEffect.RefreshThreadWorkers -> refreshThreadWorkers()
    }

    /** The list, the open room and the faces, from scratch. */
    suspend fun reload() {
        val before = view ?: return
        try {
            val reply = api().json("GET", "/api/rooms")
            val now = view ?: return
            view = now.copy(user = reply.field("user").string ?: before.user, rooms = objects(reply.field("rooms")).sortedWith(byActivity))
            error = null
            coroutineScope {
                launch { open(now.currentId, clear = false) }
                launch { loadFaces() }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = message(e, "Unable to load rooms.")
        } finally {
            loading = false
            changed()
        }
    }

    /** Show a room: its latest messages, and read them. */
    suspend fun open(roomId: String, clear: Boolean = true) {
        val token = ++loadToken
        var current = view ?: return
        if (current.threadId != null && roomId != current.currentId) closeThread()
        current = view ?: return
        val switching = roomId != current.currentId
        view = current.copy(
            currentId = roomId,
            // Another room: never show the last one's messages under its name.
            messages = if (switching && clear) emptyList() else current.messages,
            pinned = if (switching && clear) emptyList() else current.pinned,
        )
        opening = true
        changed()
        try {
            val connected = api()
            val path = "/api/rooms/${roomId.urlSegment()}"
            val (roomReply, page) = coroutineScope {
                val room = async { connected.json("GET", path) }
                val page = async { connected.json("GET", "$path/messages?limit=$ROOM_PAGE") }
                room.await() to page.await()
            }
            if (token != loadToken) return
            val room = roomReply.field("room") as? JsonObject ?: throw ApiException(502, "bad_reply", "The gateway sent no room.")
            val now = view ?: return
            // Messages of this room that came while loading (or were loaded
            // before a reset) stay; the page has the rest.
            val meanwhile = now.messages.filter { it.field("roomId").string == roomId }
            view = now.copy(detached = if (now.rooms.any { it.field("id").string == room.field("id").string }) null else room)
                .mergeRoom(room)
                .copy(
                    pinned = objects(roomReply.field("pinned")),
                    messages = meanwhile.fold(objects(page.field("messages"))) { list, item -> appendMessage(list, item) },
                )
            hasMore = page.field("hasMore").bool == true
            error = null
            opening = false
            changed()
            markRead()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (token != loadToken) return
            opening = false
            view = view?.copy(messages = emptyList())
            error = if (e is ApiException && e.status == 404) "This room does not exist." else message(e, "Unable to open the room.")
            changed()
        }
    }

    /** The page of messages before the first one shown. */
    suspend fun loadOlder() {
        val current = view ?: return
        val first = current.messages.firstOrNull() ?: return
        if (!hasMore) return
        val roomId = current.currentId
        val page = api().json("GET", "/api/rooms/${roomId.urlSegment()}/messages?before=${first.field("seq").long ?: 0}&limit=$ROOM_PAGE")
        val now = view ?: return
        if (now.currentId != roomId) return
        val known = now.messages.map { it.field("id").string }.toSet()
        view = now.copy(messages = objects(page.field("messages")).filter { it.field("id").string !in known } + now.messages)
        hasMore = page.field("hasMore").bool == true
        changed()
    }

    /**
     * Send at once: stored and shown everywhere straight away. [immediate]
     * (a long press) asks the brain not to wait for more (decision #16).
     * [attachments] are ids from [upload].
     */
    suspend fun send(roomId: String, text: String, attachments: List<String>, immediate: Boolean): Any? {
        val reply = api().json("POST", "/api/rooms/${roomId.urlSegment()}/messages", buildJsonObject {
            put("text", text)
            put("attachments", JsonArray(attachments.map(::JsonPrimitive)))
            put("immediate", immediate)
        })
        val message = reply.field("message") as? JsonObject
        val now = view
        if (message != null && now != null && now.currentId == roomId) {
            view = now.copy(messages = appendMessage(now.messages, message))
            changed()
        }
        lastTyping = 0
        return message.wire()
    }

    /** A file for the next message in [roomId]: its upload, whose `id` goes with [send]. */
    suspend fun upload(roomId: String, bytes: ByteArray, mimeType: String, filename: String): Any? =
        api().uploadToRoom(roomId, bytes, mimeType, filename).wire()

    /** A keystroke in the composer: tell the others, at most every 3 s. */
    fun keystroke(roomId: String) {
        val now = clock()
        if (now - lastTyping < TYPING_THROTTLE_MS) return
        lastTyping = now
        scope.launch { quietly { api().json("POST", "/api/rooms/${roomId.urlSegment()}/typing") } }
    }

    /** Whether [roomId] is on screen now (its pushes are not notified). */
    fun isShowing(roomId: String): Boolean = visible && view?.currentId == roomId

    /** Read the open room up to its newest message, while the app is in front. */
    suspend fun markRead() {
        if (visible) view?.currentId?.let(onShowing)
        val room = view?.current ?: return
        val lastSeq = room.field("lastSeq").long ?: 0
        if (!visible || (room.field("readSeq").long ?: 0) >= lastSeq) return
        quietly {
            val reply = api().json("POST", "/api/rooms/${room.field("id").string.orEmpty().urlSegment()}/read", buildJsonObject { put("seq", lastSeq) })
            (reply.field("room") as? JsonObject)?.let(::merge)
        }
    }

    suspend fun createRoom(name: String): String? {
        val reply = api().json("POST", "/api/rooms", buildJsonObject { put("name", name) })
        val id = reply.field("room").field("id").string
        refreshList()
        if (id != null) open(id)
        return id
    }

    /** The archived rooms, newest activity first. */
    suspend fun loadArchived() {
        val reply = api().json("GET", "/api/rooms?archived=1")
        archived = objects(reply.field("rooms")).filter { it.field("archivedAt").long != null }.sortedWith(byActivity)
        changed()
    }

    suspend fun setArchived(roomId: String, archived: Boolean) {
        val reply = api().json("PATCH", "/api/rooms/${roomId.urlSegment()}", buildJsonObject { put("archived", archived) })
        val room = reply.field("room") as? JsonObject
        refreshList()
        if (this.archived != null) loadArchived()
        val now = view ?: return
        if (roomId == now.currentId && room != null) {
            view = now.copy(detached = if (now.rooms.any { it.field("id").string == roomId }) null else room)
            changed()
        }
    }

    /** Rename a room or change what it follows (`name`, `sourceScope`). */
    suspend fun update(roomId: String, patch: JsonObject): Any? {
        val reply = api().json("PATCH", "/api/rooms/${roomId.urlSegment()}", patch)
        val room = reply.field("room") as? JsonObject
        room?.let(::merge)
        return room.wire()
    }

    /** Move the conversation (with its `topic`'s open loops) and follow it. */
    suspend fun moveTo(toRoomId: String, topic: String?) {
        val from = view?.currentId ?: return
        api().json("POST", "/api/rooms/${from.urlSegment()}/move", buildJsonObject {
            put("toRoomId", toRoomId)
            if (!topic.isNullOrBlank()) put("topic", topic)
        })
        open(toRoomId)
    }

    suspend fun pin(roomId: String, messageId: String, pinned: Boolean) {
        val reply = api().json(
            "POST",
            "/api/rooms/${roomId.urlSegment()}/messages/${messageId.urlSegment()}/pin",
            buildJsonObject { put("pinned", pinned) },
        )
        val message = reply.field("message") as? JsonObject ?: return
        view = view?.replaceMessage(message)
        changed()
    }

    /** A face saved from the app; its event says the same a moment later. */
    fun faceSaved(face: JsonObject) {
        val now = view ?: return
        view = now.copy(faces = upsertFace(now.faces, face))
        changed()
    }

    /** The faces (hidden ones too: old messages still name them) and what they do. */
    suspend fun loadFaces() = quietly {
        val reply = api().json("GET", "/api/faces?hidden=1")
        val now = view ?: return@quietly
        view = now.copy(
            faces = objects(reply.field("faces")),
            facePresence = facePresenceFrom(objects(reply.field("presence"))),
        )
        changed()
    }

    /** Open a thread beside the room: its messages, live from then on. */
    suspend fun openThread(threadId: String) {
        val token = ++threadToken
        view = view?.copy(threadId = threadId) ?: return
        threadError = null
        changed()
        try {
            val reply = api().json("GET", "/api/threads/${threadId.urlSegment()}")
            if (token != threadToken) return
            val messages = objects(reply.field("messages"))
            val now = view ?: return
            // Events that came meanwhile are kept.
            val known = messages.map { it.field("id").string }.toSet()
            val later = now.threadMessages.filter { it.field("threadId").string == threadId && it.field("id").string !in known }
            view = now.copy(threadMessages = (messages + later).sortedBy { it.field("seq").long ?: 0 })
            threadWorkers = (reply.field("workers") as? JsonArray).orEmpty()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (token != threadToken) return
            view = view?.copy(threadMessages = emptyList())
            threadWorkers = emptyList()
            threadError = message(e, "Unable to open the thread.")
        }
        changed()
    }

    fun closeThread() {
        threadToken++
        view = view?.copy(threadId = null, threadMessages = emptyList())
        threadWorkers = emptyList()
        threadError = null
        changed()
    }

    private suspend fun refreshThreadWorkers() {
        val threadId = view?.threadId ?: return
        quietly {
            val reply = api().json("GET", "/api/threads/${threadId.urlSegment()}")
            if (threadId == view?.threadId) {
                threadWorkers = (reply.field("workers") as? JsonArray).orEmpty()
                publish("roomsThreadWorkers", threadId)
                changed()
            }
        }
    }

    private fun merge(room: JsonObject) {
        view = view?.mergeRoom(room)
        changed()
    }

    private suspend fun refreshRoom(roomId: String) {
        val reply = api().json("GET", "/api/rooms/${roomId.urlSegment()}")
        (reply.field("room") as? JsonObject)?.let(::merge)
    }

    private suspend fun refreshList() {
        val reply = api().json("GET", "/api/rooms")
        val now = view ?: return
        view = now.copy(rooms = objects(reply.field("rooms")).sortedWith(byActivity))
        changed()
    }

    /** Publish the snapshot soon, once for a burst of changes. */
    private fun changed() {
        if (view == null) return
        if (publishDelayMs <= 0) {
            publish("rooms", wire())
            return
        }
        if (pendingPublish?.isActive == true) return
        pendingPublish = scope.launch {
            delay(publishDelayMs)
            if (view != null) publish("rooms", wire())
        }
    }

    /** Everything the room pages show, as Flutter reads it. */
    fun wire(): Map<String, Any?>? {
        val view = view ?: return null
        return mapOf(
            "user" to view.user,
            "currentId" to view.currentId,
            "current" to view.current.wire(),
            "rooms" to view.rooms.map { it.wire() },
            "archived" to archived?.map { it.wire() },
            "messages" to view.messages.map { it.wire() },
            "pinned" to view.pinned.map { it.wire() },
            "hasMore" to hasMore,
            "loading" to loading,
            "opening" to opening,
            "error" to error,
            "connection" to connection,
            "typing" to view.typing,
            "thinking" to view.thinking,
            "faces" to view.faces.map { it.wire() },
            "facePresence" to view.facePresence.mapValues { it.value.wire() },
            "loopsRevision" to view.loopsRevision,
            "wakesRevision" to view.wakesRevision,
            "threadId" to view.threadId,
            "threadMessages" to view.threadMessages.map { it.wire() },
            "threadWorkers" to threadWorkers.map { it.wire() },
            "threadError" to threadError,
            "threadActivity" to view.threadActivity.mapValues { mapOf("text" to it.value.text, "at" to it.value.at) },
        )
    }

    /** The view as the reducer sees it (tests). */
    internal fun viewForTest(): RoomsView? = view
}

private suspend fun quietly(block: suspend () -> Unit) {
    try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        // Kept as it was: the next event, reset or reload tries again.
    }
}

private fun message(error: Exception, fallback: String) = error.message?.takeIf { it.isNotBlank() } ?: fallback

private fun JsonElement?.field(key: String): JsonElement? = (this as? JsonObject)?.get(key)
private val JsonElement?.string: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
private val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.booleanOrNull
private fun objects(value: JsonElement?) = (value as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
