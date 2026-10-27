package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

/** One native connection's authenticated principal; neither Web nor a management grant is needed. */
internal class NativeFirstSend(
    directory: File,
    private val capture: suspend (String) -> PircApi,
    private val validate: (String) -> Unit,
) {
    private data class Account(val stamp: String, val owner: String, val scope: String, val api: FirstSendApi, val enabled: Boolean, val connection: PircApi)
    private var account: Account? = null
    private var revision = 0L
    private val store = FirstSendDraftStore(directory)
    fun clear() { revision++; account = null }
    suspend fun capabilities(stamp: String): Any? {
        val ticket = ++revision
        val api = capture(stamp)
        val value = FirstSendApi(api).request("GET", "/api/conversation-submissions/capabilities")?.jsonObject
            ?: throw ApiException(502, "bad_reply", "Missing first-send capabilities")
        validate(stamp)
        if (ticket != revision) throw ApiException(409, "account_changed", "First-send account changed")
        val owner = value["ownerUser"]?.jsonPrimitive?.contentOrNull
        val enabled = value["version"]?.jsonPrimitive?.intOrNull == 1 && value["canSubmit"]?.jsonPrimitive?.booleanOrNull == true
        account = if (!owner.isNullOrBlank() && value["canFenceAccount"]?.jsonPrimitive?.booleanOrNull == true)
            account?.takeIf { it.stamp == stamp && it.owner == owner && it.connection === api && it.enabled == enabled }
                ?: Account(stamp, owner, FirstSendDraftStore.scope(api.pairing.baseUrl, owner), FirstSendApi(api), enabled, api)
            else null
        return JsonObject(value + (account?.let { mapOf("draftScope" to JsonPrimitive(it.scope)) } ?: emptyMap())).wire()
    }
    private fun current(stamp: String, owner: String): Account {
        validate(stamp)
        return account?.takeIf { it.stamp == stamp && it.owner == owner }
            ?: throw ApiException(409, "account_changed", "Authenticate the original first-send account before accessing its draft")
    }
    private fun recheck(captured: Account) {
        validate(captured.stamp)
        if (account !== captured) throw ApiException(409, "account_changed", "First-send account changed")
    }
    suspend fun drafts(stamp: String, owner: String, args: Map<*, *>): Any? {
        val captured = current(stamp, owner)
        val result = withContext(Dispatchers.IO) {
            val id = args["operationId"] as? String
            val expected = (args["expectedRevision"] as? Number)?.toLong()
            when (args["action"]) {
                "list" -> store.list(captured.scope).map { it.wire() }
                "get" -> store.get(captured.scope, requireNotNull(id)).wire()
                "put" -> {
                    val supplied = args["record"].json() as? JsonObject ?: error("Missing draft record")
                    require(!supplied.flag("frozen") && !supplied.flag("prepareAttempted") && supplied.preparation() == null) {
                        "First-message status is managed by the native submission flow"
                    }
                    val before = store.get(captured.scope, requireNotNull(id))
                    check(before == null || (!before.flag("frozen") && !before.flag("prepareAttempted"))) {
                        "Frozen first-message input cannot be edited"
                    }
                    val record = JsonObject(supplied.filterKeys { it in setOf("workspaceId", "message", "model", "thinking", "files") } +
                        mapOf("frozen" to JsonPrimitive(false), "prepareAttempted" to JsonPrimitive(false)))
                    val files = (args["files"] as? List<*>).orEmpty().map { raw ->
                        val file = raw as? Map<*, *> ?: error("Invalid attachment")
                        (file["id"] as? String ?: error("Missing attachment identity")) to
                            (file["bytes"] as? ByteArray ?: error("Attachment bytes must be Uint8List"))
                    }
                    require(files.map { it.first }.distinct().size == files.size)
                    store.put(captured.scope, owner, requireNotNull(id), expected, record, files.toMap()).wire()
                }
                "delete" -> {
                    val row = store.get(captured.scope, requireNotNull(id))
                    check(row == null || !row.flag("prepareAttempted") || row.phase() == "admitted" ||
                        (row.phase() == "cancelled" && row.preparation()?.flag("cleanupPending") != true)) {
                        "Keep the original first message until its outcome or deletion is confirmed"
                    }
                    store.remove(captured.scope, id, requireNotNull(expected)); null
                }
                else -> error("Invalid draft storage action")
            }
        }
        recheck(captured)
        return result
    }
    private suspend fun upload(stamp: String, owner: String, operationId: String, fileId: String): Any? {
        val captured = current(stamp, owner)
        val (_, bytes) = withContext(Dispatchers.IO) { store.attachment(captured.scope, operationId, fileId) }
        recheck(captured)
        val result = captured.api.request("PUT", "/api/conversation-submissions/${operationId.urlSegment()}/attachments/${fileId.urlSegment()}", owner, bytes = bytes).wire()
        recheck(captured)
        return result
    }

    private fun JsonObject.string(key: String) = get(key)?.jsonPrimitive?.contentOrNull
    private fun JsonObject.flag(key: String) = get(key)?.jsonPrimitive?.booleanOrNull == true
    private fun JsonObject.preparation() = get("preparation") as? JsonObject
    private fun JsonObject.phase() = preparation()?.string("state")
    private fun JsonObject.admission() = preparation()?.get("messageAdmission") as? JsonObject
    private suspend fun local(captured: Account, id: String): JsonObject {
        recheck(captured)
        return withContext(Dispatchers.IO) { store.get(captured.scope, id) }
            ?: error("This draft is no longer available")
    }
    private suspend fun change(captured: Account, id: String, action: (JsonObject) -> JsonObject): JsonObject {
        recheck(captured)
        return withContext(Dispatchers.IO) { store.update(captured.scope, captured.owner, id, action) }
            .also { recheck(captured) }
    }
    private fun spec(row: JsonObject): JsonObject = buildJsonObject {
        put("workspaceId", row.getValue("workspaceId")); put("message", row.getValue("message"))
        row["model"]?.takeUnless { it == JsonNull }?.let { put("model", it) }
        row["thinking"]?.takeUnless { it == JsonNull }?.let { put("thinking", it) }
        put("attachments", JsonArray(row.getValue("files").jsonArray.map { raw ->
            JsonObject(raw.jsonObject.filterKeys { it in setOf("id", "name", "mimeType", "byteSize", "sha256") })
        }))
    }
    private suspend fun api(captured: Account, method: String, path: String, body: JsonElement? = null): JsonElement? {
        recheck(captured)
        return captured.api.request(method, path, captured.owner, body).also { recheck(captured) }
    }
    private fun path(id: String) = "/api/conversation-submissions/${id.urlSegment()}"
    private suspend fun receipt(captured: Account, id: String, value: JsonObject): JsonObject {
        require(value.string("operationId") == id) { "The server returned a different first-message operation" }
        return change(captured, id) { row ->
            val previous = row.preparation()
            require(row["workspaceId"] == value["workspaceId"] && (previous == null || previous["sessionId"] == value["sessionId"])) {
                "The original conversation binding changed"
            }
            val keep = (previous?.string("state") == "cancelled" && (value.string("state") != "cancelled" || (!previous.flag("cleanupPending") && value.flag("cleanupPending")))) ||
                (previous?.string("state") == "admitted" && value.string("state") !in setOf("admitted", "cancelled")) ||
                (previous?.flag("accepted") == true && !value.flag("accepted")) ||
                (row.admission()?.flag("stopConfirmed") == true && value.string("state") != "cancelled" &&
                    (value["messageAdmission"] as? JsonObject)?.flag("stopConfirmed") != true)
            val result = if (keep) previous!! else value
            JsonObject((row - "error") + mapOf("preparation" to result, "uncertain" to JsonPrimitive(result.string("state") == "outcome_unknown")) +
                if (result.string("state") == "cancelled") mapOf("message" to JsonPrimitive(""), "files" to JsonArray(emptyList())) else emptyMap())
        }
    }
    private suspend fun check(captured: Account, id: String): JsonObject {
        val row = local(captured, id)
        if (!row.flag("frozen")) return row
        try {
            val suffix = if (row.preparation()?.flag("accepted") == true) "/receipt" else ""
            val result = api(captured, "GET", path(id) + suffix)?.jsonObject?.get("preparation")?.jsonObject
                ?: throw ApiException(502, "bad_reply", "Missing first-message receipt")
            return receipt(captured, id, result)
        } catch (error: ApiException) {
            if (error.status != 404 || row.preparation() != null) throw error
            return change(captured, id) { JsonObject((it - "error") + ("uncertain" to JsonPrimitive(false))) }
        }
    }
    suspend fun check(stamp: String, owner: String, id: String): Any? = check(current(stamp, owner), id).wire()
    private suspend fun prepare(captured: Account, id: String, cancelling: Boolean = false): JsonObject {
        val row = change(captured, id) { before ->
            check(cancelling || !before.flag("cancelRequested")) { "This draft is being cancelled" }
            JsonObject(before + ("prepareAttempted" to JsonPrimitive(true)))
        }
        val result = api(captured, "POST", "/api/conversation-submissions/prepare", buildJsonObject {
            put("expectedOwner", captured.owner); put("operationId", id); put("submission", spec(row))
        })?.jsonObject?.get("preparation")?.jsonObject ?: throw ApiException(502, "bad_reply", "Missing preparation receipt")
        return receipt(captured, id, result)
    }
    private suspend fun active(captured: Account, id: String) {
        check(!local(captured, id).flag("cancelRequested")) { "This draft is being cancelled" }
    }
    private suspend fun action(captured: Account, id: String, kind: String, body: JsonElement? = null): JsonObject {
        active(captured, id)
        val value = api(captured, "POST", path(id) + "/$kind", body)?.jsonObject?.get("preparation")?.jsonObject
            ?: throw ApiException(502, "bad_reply", "Missing first-message action receipt")
        return receipt(captured, id, value)
    }
    private suspend fun acquire(captured: Account, session: String, clientId: String, force: Boolean = false): Long {
        val value = api(captured, "POST", "/api/sessions/${session.urlSegment()}/control/acquire", buildJsonObject {
            put("clientId", clientId); put("force", force)
        })?.jsonObject?.get("lease")?.jsonObject
        check(value?.string("clientId") == clientId) { "Another device has control; take control explicitly before continuing" }
        return value["generation"]?.jsonPrimitive?.longOrNull?.takeIf { it > 0 }
            ?: error("Missing control generation")
    }
    /** Only an explicit user Send/Continue invokes this; checking never calls it. */
    suspend fun submit(stamp: String, owner: String, id: String, expectedRevision: Long?, clientId: String): Any? {
        val captured = current(stamp, owner)
        check(captured.enabled) { "Durable first Send is not enabled by this Gateway" }
        change(captured, id) { before ->
            check(!before.flag("cancelRequested")) { "This draft is being cancelled" }
            if (!before.flag("frozen")) {
                check(before["revision"]?.jsonPrimitive?.longOrNull == expectedRevision) { "This draft changed in another window" }
                require(!before.string("message").isNullOrBlank() || before.getValue("files").jsonArray.isNotEmpty()) { "The first message is empty" }
            }
            JsonObject(before + ("frozen" to JsonPrimitive(true)))
        }
        try {
            var row = check(captured, id)
            if (row.preparation() == null) row = prepare(captured, id)
            if (row.phase() == "preparing") {
                for (file in row.getValue("files").jsonArray) {
                    active(captured, id)
                    upload(stamp, owner, id, file.jsonObject.getValue("id").jsonPrimitive.content)
                }
                row = action(captured, id, "accept")
            }
            if (row.phase() == "accepted") row = action(captured, id, "materialize")
            if (row.phase() == "ready") {
                active(captured, id)
                val generation = acquire(captured, row.preparation()!!.getValue("sessionId").jsonPrimitive.content, clientId)
                row = action(captured, id, "dispatch", buildJsonObject { put("clientId", clientId); put("generation", generation) })
            }
            return row.wire()
        } catch (error: Exception) {
            // If even this status write fails, the prior immutable input and
            // prepare-attempt marker still survive; never fall back or replay.
            try { change(captured, id) { before -> JsonObject(before + mapOf(
                "error" to JsonPrimitive(error.message ?: "First-message result is unconfirmed"),
                "uncertain" to JsonPrimitive(before.flag("prepareAttempted") && !(error is ApiException && error.status in 400..499)),
            )) } } catch (_: Exception) { /* Preserve the earlier committed record. */ }
            throw error
        }
    }
    suspend fun cancel(stamp: String, owner: String, id: String, deleteAccepted: Boolean = false): Any? {
        val captured = current(stamp, owner)
        val row = change(captured, id) { JsonObject(it + mapOf("cancelRequested" to JsonPrimitive(true)) +
            if (deleteAccepted) mapOf("deleteAcceptedRequested" to JsonPrimitive(true)) else emptyMap()) }
        if ((!row.flag("frozen") || !row.flag("prepareAttempted")) && row.preparation() == null) {
            withContext(Dispatchers.IO) { store.remove(captured.scope, id, row.getValue("revision").jsonPrimitive.long) }
            recheck(captured)
            return null
        }
        if (row.phase() == "cancelled") return check(captured, id).wire()
        var checked = check(captured, id)
        if (checked.preparation() == null) checked = prepare(captured, id, cancelling = true)
        if (checked.preparation()?.flag("accepted") == true && !checked.flag("deleteAcceptedRequested"))
            throw ApiException(409, "confirmation_required", "This first message was already accepted. Confirm conversation and memory deletion, or keep it and use Stop.")
        val target = if (checked.preparation()?.flag("accepted") == true)
            "/api/sessions/${checked.preparation()!!.getValue("sessionId").jsonPrimitive.content.urlSegment()}" else path(id)
        api(captured, "DELETE", target)
        return check(captured, id).wire()
    }
    suspend fun takeControl(stamp: String, owner: String, id: String, clientId: String): Long {
        val captured = current(stamp, owner)
        val row = local(captured, id)
        check(row.preparation()?.flag("accepted") == true && row.phase() !in setOf("accepted", "cancelled")) { "The Node session is not ready for control" }
        return acquire(captured, row.preparation()!!.getValue("sessionId").jsonPrimitive.content, clientId, force = true)
    }
    suspend fun stop(stamp: String, owner: String, id: String, clientId: String): Any? {
        val captured = current(stamp, owner)
        val before = check(captured, id)
        check(before.preparation()?.flag("accepted") == true && before.phase() !in setOf("accepted", "cancelled")) { "The Node session is not ready for Stop; check again" }
        val row = change(captured, id) { JsonObject(it + ("stopCommandId" to (it["stopCommandId"] ?: JsonPrimitive(UUID.randomUUID().toString())))) }
        val session = row.preparation()!!.getValue("sessionId").jsonPrimitive.content
        val generation = acquire(captured, session, clientId)
        val command = row.getValue("stopCommandId").jsonPrimitive.content
        var missing = false
        try {
            val receipt = api(captured, "GET", "/api/sessions/${session.urlSegment()}/commands/${command.urlSegment()}")?.jsonObject?.get("command")?.jsonObject
            check(receipt?.string("status") == "accepted") { "Stop is still unconfirmed; check before retrying" }
        } catch (error: ApiException) { if (error.status == 404) missing = true else throw error }
        if (missing) {
            val result = api(captured, "POST", "/api/sessions/${session.urlSegment()}/commands", buildJsonObject {
                put("commandId", command); put("clientId", clientId); put("generation", generation)
                put("payload", buildJsonObject { put("type", "stop") })
            })?.jsonObject?.get("command")?.jsonObject
            check(result?.string("status") == "accepted") { "Stop is still unconfirmed; check before retrying" }
        }
        return check(captured, id).wire()
    }
    suspend fun release(stamp: String, owner: String, id: String): Any? = change(current(stamp, owner), id) {
        check(it.admission()?.flag("stopConfirmed") == true) { "Stop is still unconfirmed" }
        JsonObject(it + ("released" to JsonPrimitive(true)))
    }.wire()
    suspend fun adopt(stamp: String, owner: String, session: String): Any? {
        val captured = current(stamp, owner)
        val pending = api(captured, "GET", "/api/conversation-submissions/session/${session.urlSegment()}")?.jsonObject?.get("preparation")?.jsonObject
            ?: throw ApiException(502, "bad_reply", "Missing pending first-message intent")
        require(pending.flag("accepted") && pending.string("sessionId") == session)
        val submission = pending["submission"]?.jsonObject ?: error("Missing accepted first-message input")
        val id = pending.string("operationId") ?: error("Missing first-message identity")
        val old = withContext(Dispatchers.IO) { store.get(captured.scope, id) }
        if (old != null) return receipt(captured, id, pending).wire()
        val row = JsonObject((submission - "attachments") + mapOf(
            "files" to submission.getValue("attachments"), "frozen" to JsonPrimitive(true),
            "prepareAttempted" to JsonPrimitive(true), "preparation" to pending,
        ))
        return withContext(Dispatchers.IO) { store.put(captured.scope, owner, id, null, row) }.also { recheck(captured) }.wire()
    }
}
