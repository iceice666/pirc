package dev.pirc.pirc_mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/*
 * The domain half of the Flutter channel (plans/rewrite/12-android.md,
 * decision 2): calls about sessions and rooms. GatewayBridge keeps the
 * transport and the platform (pairing, documents, media, pickers, push) and
 * hands every other method here.
 */

/** [domainCall]'s answer for a method that is not a domain call. */
internal object NotDomain

/** Files sent with a message: at most this many bytes each. */
internal const val MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** The arguments of one channel call, read strictly. */
internal class CallArgs(private val args: Map<*, *>) {
    fun str(key: String): String = args[key] as? String ?: throw IllegalArgumentException("$key is required")
    fun optionalString(key: String): String? {
        val value = args[key] ?: return null
        return value as? String ?: throw IllegalArgumentException("$key must be a string")
    }
    fun bool(key: String): Boolean = args[key] as? Boolean ?: throw IllegalArgumentException("$key must be a boolean")
    fun requiredLong(key: String): Long = (args[key] as? Number)?.toLong() ?: throw IllegalArgumentException("$key must be a number")
    fun strings(key: String): List<String> {
        val value = args[key] ?: return emptyList()
        val list = value as? List<*> ?: throw IllegalArgumentException("$key must be a list")
        return list.map { it as? String ?: throw IllegalArgumentException("$key must hold strings") }
    }
    fun bytes(key: String): ByteArray = args[key] as? ByteArray ?: throw IllegalArgumentException("$key must be bytes")
    fun map(key: String): Map<*, *> = args[key] as? Map<*, *> ?: throw IllegalArgumentException("$key must be a map")
    operator fun get(key: String): Any? = args[key]
}

/** A session or room call from Flutter, or [NotDomain]. */
internal suspend fun GatewayRuntime.domainCall(method: String, args: CallArgs, contextId: String?): Any? = when (method) {
    // ---- rooms ----
    "roomsStart" -> { rooms.start(args.optionalString("roomId")); rooms.wire() }
    "roomsStop" -> { rooms.stop(); null }
    "roomsVisible" -> { rooms.setVisible(args.bool("visible")); null }
    "roomsReload" -> { rooms.reload(); null }
    "roomsOpen" -> { rooms.open(args.str("roomId")); null }
    "roomsOlder" -> { rooms.loadOlder(); null }
    "roomsSend" -> rooms.send(
        args.str("roomId"), args.str("text"), args.strings("attachments"), args["immediate"] == true,
    )
    "roomsUpload" -> {
        val bytes = args.bytes("bytes")
        require(bytes.size <= MAX_ATTACHMENT_BYTES) { "Files are limited to 8 MiB" }
        withContext(Dispatchers.IO) {
            rooms.upload(args.str("roomId"), bytes, args.str("mimeType"), args.str("name"))
        }
    }
    "roomsTyping" -> { rooms.keystroke(args.str("roomId")); null }
    "roomsCreate" -> rooms.createRoom(args.str("name"))
    "roomsArchived" -> { rooms.loadArchived(); null }
    "roomsSetArchived" -> { rooms.setArchived(args.str("roomId"), args.bool("archived")); null }
    "roomsUpdate" -> rooms.update(args.str("roomId"), args.map("patch").json() as JsonObject)
    "roomsMove" -> { rooms.moveTo(args.str("toRoomId"), args.optionalString("topic")); null }
    "roomsPin" -> { rooms.pin(args.str("roomId"), args.str("messageId"), args.bool("pinned")); null }
    "roomsFaceSaved" -> { rooms.faceSaved(args.map("face").json() as JsonObject); null }
    "roomsFaces" -> { rooms.loadFaces(); null }
    "roomsOpenThread" -> { rooms.openThread(args.str("threadId")); null }
    "roomsCloseThread" -> { rooms.closeThread(); null }

    // ---- sessions ----
    "watch" -> { sessions.watch(args.str("sessionId"), contextId, args.optionalString("watchTag")); local.draft(args.str("sessionId")) }
    "setWatchVisibility" -> sessions.setWatchVisibility(
        contextId,
        args.bool("visible"),
        args.requiredLong("visibilityRevision"),
        args.optionalString("watchTag"),
    )
    "unwatch" -> { sessions.unwatch(contextId, args.optionalString("watchTag")); null }
    "refresh" -> sessions.snapshot(args.str("sessionId")).wire()
    "draft" -> { local.saveDraft(args.str("sessionId"), args.str("text")); null }
    "control" -> sessions.lease(args.str("sessionId"), args["acquire"] == true, args["force"] == true)
    "commandStatus" -> sessions.unknownCommand(args.str("sessionId"))
    "command" -> sessions.command(args.str("sessionId"), args.map("payload"), args.str("commandId"))
    "acknowledgeCommand" -> { sessions.acknowledgeCommand(args.str("sessionId")); null }
    "answer" -> sessions.answer(args.str("sessionId"), args.str("interactionId"), args.str("epoch"), args.str("pairingStamp"), args.map("answer"))
    "reconcileAnswer" -> sessions.reconcileAnswer(args.str("sessionId"), args.str("interactionId"), args.str("epoch"), args.str("pairingStamp"))
    "answerRelayed" -> sessions.answerRelayed(args.str("sessionId"), args.str("interactionId"), args.str("pairingStamp"), args.bool("confirmed"))
    "stopDelegation" -> sessions.stopDelegation(args.str("delegationId"))
    "uploadAttachment" -> {
        val sessionId = args.str("sessionId")
        val name = args.str("name")
        val mimeType = args.str("mimeType")
        val bytes = args["bytes"] as? ByteArray ?: throw IllegalArgumentException("bytes 必須是 Uint8List")
        require(bytes.size <= MAX_ATTACHMENT_BYTES) { "附件上限 8 MiB" }
        withContext(Dispatchers.IO) {
            val uploaded = api().upload(sessionId, bytes, mimeType, name)
            mapOf("id" to uploaded.id, "name" to name, "kind" to uploaded.kind, "mimeType" to mimeType, "size" to bytes.size)
        }
    }
    else -> NotDomain
}
