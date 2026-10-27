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
    private data class Account(val stamp: String, val owner: String, val scope: String, val api: FirstSendApi, val enabled: Boolean, val pendingStop: Boolean, val canRetry: Boolean, val canRetire: Boolean, val requireContract: Boolean, val connection: PircApi)
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
        val compatible = value["version"]?.jsonPrimitive?.intOrNull == 1 && value["clientContract"]?.jsonPrimitive?.intOrNull == 2 && value["requiredClientContract"]?.jsonPrimitive?.intOrNull == 2 && value.flag("canStopBeforeAllocation")
        val alreadyRequired = account?.takeIf { it.stamp == stamp && it.connection === api }?.requireContract == true
        val blocked = (alreadyRequired || "clientContract" in value || "requiredClientContract" in value || value.flag("canSubmit")) && !compatible
        val requireContract = alreadyRequired || compatible || blocked
        val enabled = compatible && value.flag("canSubmit")
        val pendingStop = value["version"]?.jsonPrimitive?.intOrNull == 1 && value["canStopBeforeAllocation"]?.jsonPrimitive?.booleanOrNull == true
        val canRetry = compatible && value.flag("canRetryFirstMessage")
        val canRetire = compatible && value.flag("canRetireFirstMessageRetry")
        account = if (!owner.isNullOrBlank() && value["canFenceAccount"]?.jsonPrimitive?.booleanOrNull == true)
            account?.takeIf { it.stamp == stamp && it.owner == owner && it.connection === api && it.enabled == enabled && it.pendingStop == pendingStop && it.canRetry == canRetry && it.canRetire == canRetire && it.requireContract == requireContract }
                ?: Account(stamp, owner, FirstSendDraftStore.scope(api.pairing.baseUrl, owner), FirstSendApi(api), enabled, pendingStop, canRetry, canRetire, requireContract, api)
            else null
        return JsonObject(value + mapOf("canSubmit" to JsonPrimitive(enabled), "firstSendUpgradeRequired" to JsonPrimitive(blocked)) + (account?.let { mapOf("draftScope" to JsonPrimitive(it.scope)) } ?: emptyMap())).wire()
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
        val result = try { withContext(Dispatchers.IO) {
            val id = args["operationId"] as? String
            val expected = (args["expectedRevision"] as? Number)?.toLong()
            when (args["action"]) {
                "list" -> store.list(captured.scope).map { it.wire() }
                "get" -> store.get(captured.scope, requireNotNull(id)).wire()
                "open" -> store.openEditor(captured.scope, requireNotNull(id))?.let { (row, bytes) ->
                    mapOf("record" to row.wire(), "files" to bytes.map { (fileId, content) ->
                        mapOf("id" to fileId, "bytes" to content)
                    })
                }
                "put" -> {
                    val supplied = args["record"].json() as? JsonObject ?: error("Missing draft record")
                    require(!supplied.flag("frozen") && !supplied.flag("prepareAttempted") && supplied.preparation() == null) {
                        "First-message status is managed by the native submission flow"
                    }
                    val before = store.get(captured.scope, requireNotNull(id))
                    if (before != null && (before.flag("frozen") || before.flag("prepareAttempted"))) throw DraftWriteConflict("Frozen first-message input cannot be edited")
                    val record = JsonObject(supplied.filterKeys { it in setOf("workspaceId", "message", "model", "thinking", "files") } +
                        mapOf("frozen" to JsonPrimitive(false), "prepareAttempted" to JsonPrimitive(false)) +
                        (before?.get("recoveredFrom")?.let { mapOf("recoveredFrom" to it) } ?: emptyMap()))
                    val files = (args["files"] as? List<*>).orEmpty().map { raw ->
                        val file = raw as? Map<*, *> ?: error("Invalid attachment")
                        (file["id"] as? String ?: error("Missing attachment identity")) to
                            (file["bytes"] as? ByteArray ?: error("Attachment bytes must be Uint8List"))
                    }
                    require(files.map { it.first }.distinct().size == files.size)
                    store.put(captured.scope, owner, requireNotNull(id), expected, record, files.toMap()).wire()
                }
                "recover" -> {
                    val supplied = args["record"].json() as? JsonObject ?: error("Missing draft record")
                    val source = args["sourceOperationId"] as? String ?: error("Missing source draft identity")
                    val files = (args["files"] as? List<*>).orEmpty().map { raw ->
                        val file = raw as? Map<*, *> ?: error("Invalid attachment")
                        (file["id"] as? String ?: error("Missing attachment identity")) to
                            (file["bytes"] as? ByteArray ?: error("Attachment bytes must be Uint8List"))
                    }
                    require(files.map { it.first }.distinct().size == files.size)
                    store.recover(captured.scope, owner, source, requireNotNull(id), expected, supplied, files.toMap()).wire()
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
        } } catch (error: DraftWriteConflict) { throw ApiException(409, "draft_changed", error.message ?: "This draft changed in another window") }
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
    private fun JsonObject.mapped(): Boolean {
        val p = preparation() ?: return false
        return p.flag("accepted") && phase() != "cancelled" &&
            if ("nodeMapped" in p) p.flag("nodeMapped") else phase() != "accepted"
    }
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
    private suspend fun receipt(captured: Account, id: String, value: JsonObject, retired: JsonObject? = null): JsonObject {
        require(value.string("operationId") == id) { "The server returned a different first-message operation" }
        return change(captured, id) { row ->
            val previous = row.preparation()
            require(row["workspaceId"] == value["workspaceId"] && (previous == null || previous["sessionId"] == value["sessionId"])) {
                "The original conversation binding changed"
            }
            val result = mergeFirstPreparation(previous, value)
            val saved = row["retryAttempt"] as? JsonObject
            val retiredMatches = saved != null && retired != null && listOf("retryId", "previousCommandId", "previousAttemptNumber").all { saved[it] == retired[it] }
            val retry = if (retiredMatches) JsonObject(saved + mapOf("resolved" to JsonPrimitive(true), "notReserved" to JsonPrimitive(true))) else saved
            val resolved = retry != null && (result.string("state") == "cancelled" || firstAttemptNumber(result) > retry.getValue("previousAttemptNumber").jsonPrimitive.long)
            JsonObject((row - "error") + mapOf("preparation" to result, "uncertain" to JsonPrimitive(result.string("state") != "cancelled" && (result.string("state") == "outcome_unknown" || (retry != null && !retry.flag("resolved") && !resolved)))) +
                (if (resolved || retiredMatches) mapOf("retryAttempt" to JsonObject(retry!! + ("resolved" to JsonPrimitive(true)))) else emptyMap()) +
                if (result.string("state") == "cancelled") mapOf("message" to JsonPrimitive(""), "files" to JsonArray(emptyList())) else emptyMap())
        }
    }
    private suspend fun check(captured: Account, id: String): JsonObject {
        val row = local(captured, id)
        if (!row.flag("frozen")) return row
        try {
            val retry = row["retryAttempt"] as? JsonObject
            if (retry != null && !retry.flag("resolved")) {
                try {
                    val value = api(captured, "GET", path(id) + "/retries/${retry.getValue("retryId").jsonPrimitive.content.urlSegment()}")?.jsonObject
                        ?: throw ApiException(502, "bad_reply", "Missing retry receipt")
                    return retryReceipt(captured, id, retry, value)
                } catch (error: ApiException) { if (error.status != 404) throw error }
                // Missing nonce does not prove that a pending request cannot arrive.
            }
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
            check(cancelling || before.string("stopCommandId") == null) { "Stop was requested. Check the result before continuing." }
            check(cancelling || !before.flag("cancelRequested")) { "This draft is being cancelled" }
            JsonObject(before + ("prepareAttempted" to JsonPrimitive(true)))
        }
        val result = api(captured, "POST", "/api/conversation-submissions/prepare", buildJsonObject {
            put("expectedOwner", captured.owner); put("operationId", id); put("submission", spec(row))
        })?.jsonObject?.get("preparation")?.jsonObject ?: throw ApiException(502, "bad_reply", "Missing preparation receipt")
        return receipt(captured, id, result)
    }
    private suspend fun active(captured: Account, id: String, allowStopped: Boolean = false) {
        val row = local(captured, id)
        check(!row.flag("cancelRequested")) { "This draft is being cancelled" }
        check(allowStopped || row.string("stopCommandId") == null) { "Stop was requested. Check the result before continuing." }
    }
    private suspend fun action(captured: Account, id: String, kind: String, body: JsonElement? = null, allowStopped: Boolean = false): JsonObject {
        active(captured, id, allowStopped)
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
    private suspend fun retryReceipt(captured: Account, id: String, attempt: JsonObject, value: JsonObject): JsonObject {
        val retired = firstRetryRetired(attempt, value)
        return receipt(captured, id, value.getValue("preparation").jsonObject, if (retired) attempt else null)
    }
    private fun canRecoverRetry(row: JsonObject): Boolean {
        val retry = row["retryAttempt"] as? JsonObject ?: return false
        val admission = row.admission() ?: return false
        return !retry.flag("resolved") && row.phase() == "admission_failed" && admission.string("outcome") == "not_admitted" && admission.flag("retryEligible") &&
            admission["commandId"] == retry["previousCommandId"] && firstAttemptNumber(row.preparation()) == retry.getValue("previousAttemptNumber").jsonPrimitive.long &&
            !admission.flag("stopRequested") && !admission.flag("stopConfirmed") && !row.flag("cancelRequested") && row.string("stopCommandId") == null
    }
    /** Fences an interrupted local retry; a later user Retry remains a separate action. */
    suspend fun recoverRetry(stamp: String, owner: String, id: String, clientId: String): Any? {
        var row = check(current(stamp, owner), id)
        val attempt = row["retryAttempt"] as? JsonObject ?: return row.wire()
        if (attempt.flag("resolved")) return row.wire()
        check(canRecoverRetry(row)) { "Only a pending retry of a rejected first message can be recovered." }
        capabilities(stamp)
        val captured = current(stamp, owner)
        check(captured.canRetire) { "This Gateway cannot recover an interrupted retry." }
        val generation = acquire(captured, row.preparation()!!.getValue("sessionId").jsonPrimitive.content, clientId)
        row = local(captured, id)
        val current = row["retryAttempt"] as? JsonObject
        check(canRecoverRetry(row) && current != null && current["retryId"] == attempt["retryId"] && current["previousCommandId"] == attempt["previousCommandId"]) { "The first-message attempt changed; check its result." }
        val value = api(captured, "POST", path(id) + "/retries/${attempt.getValue("retryId").jsonPrimitive.content.urlSegment()}/retire", buildJsonObject {
            put("previousCommandId", attempt.getValue("previousCommandId")); put("clientId", clientId); put("generation", generation)
        })?.jsonObject ?: throw ApiException(502, "bad_reply", "Missing retry receipt")
        return retryReceipt(captured, id, attempt, value).wire()
    }
    /** Exact immutable input, a fresh control lease, and a nonce committed before POST. */
    suspend fun retry(stamp: String, owner: String, id: String, clientId: String): Any? {
        val before = current(stamp, owner)
        var row = check(before, id)
        if ((row["retryAttempt"] as? JsonObject)?.let { !it.flag("resolved") } == true) return row.wire()
        val admission = row.admission()
        val command = admission?.string("commandId")
        check(row.phase() == "admission_failed" && admission?.string("outcome") == "not_admitted" && admission.flag("retryEligible") && command != null && !admission.flag("stopRequested") && !admission.flag("stopConfirmed") && !row.flag("cancelRequested") && row.string("stopCommandId") == null) { "Only a confirmed first-message rejection can be retried" }
        capabilities(stamp)
        val captured = current(stamp, owner)
        check(captured.enabled && captured.canRetry) { "This Gateway cannot retry the original first message" }
        val generation = acquire(captured, row.preparation()!!.getValue("sessionId").jsonPrimitive.content, clientId)
        val nonce = UUID.randomUUID().toString(); val number = firstAttemptNumber(row.preparation())
        row = change(captured, id) { latest ->
            check(!latest.flag("cancelRequested") && latest.string("stopCommandId") == null && latest.phase() == "admission_failed" && latest.admission()?.string("commandId") == command && firstAttemptNumber(latest.preparation()) == number && (latest["retryAttempt"] as? JsonObject)?.let { !it.flag("resolved") } != true) { "The first-message attempt changed; check its result" }
            JsonObject((latest - "error") + mapOf("uncertain" to JsonPrimitive(true), "retryAttempt" to buildJsonObject {
                put("retryId", nonce); put("previousCommandId", command); put("previousAttemptNumber", number)
            }))
        }
        try {
            return action(captured, id, "retry", buildJsonObject {
                put("retryId", nonce); put("previousCommandId", command); put("clientId", clientId); put("generation", generation)
            }).wire()
        } catch (error: Exception) {
            // This structured Gateway refusal occurs before reservation/relay.
            val notReserved = error is ApiException && error.status == 409 && error.code == "initial_retry_unsupported"
            try { change(captured, id) { latest ->
                val saved = latest["retryAttempt"] as? JsonObject
                if (saved?.string("retryId") != nonce || saved.flag("resolved") || latest.phase() == "cancelled") latest
                else JsonObject(latest + mapOf("uncertain" to JsonPrimitive(!notReserved), "error" to JsonPrimitive(error.message ?: "First-message result is unconfirmed")) +
                    if (notReserved) mapOf("retryAttempt" to JsonObject(saved + mapOf("resolved" to JsonPrimitive(true), "notReserved" to JsonPrimitive(true)))) else emptyMap())
            } } catch (_: Exception) { /* Keep the prior durable input and nonce. */ }
            throw error
        }
    }
    /** Only an explicit user Send/Continue invokes this; checking never calls it. */
    suspend fun submit(stamp: String, owner: String, id: String, expectedRevision: Long?, clientId: String): Any? {
        val before = current(stamp, owner)
        val saved = local(before, id)
        if (saved.string("stopCommandId") != null || (saved.flag("frozen") && (saved.flag("uncertain") || saved.phase() in setOf("admitted","sending","outcome_unknown","stopping","stopped","admission_failed","cancelled")))) return check(before, id).wire()
        check(before.enabled) { "Durable first Send is not enabled by this Gateway" }
        capabilities(stamp)
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
            try { change(captured, id) { before -> if (firstAttemptNumber(before.preparation()) > firstAttemptNumber(saved.preparation()) || before.phase() in setOf("admitted", "cancelled")) before else JsonObject(before + mapOf(
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
    private suspend fun pendingControl(captured: Account, id: String, clientId: String, force: Boolean = false): JsonObject {
        check(captured.pendingStop) { "This Gateway cannot stop a first message before the Node is ready." }
        active(captured, id, allowStopped = true)
        val value = api(captured, "POST", path(id) + "/stop-control/acquire", buildJsonObject {
            put("clientId", clientId); put("force", force)
        })?.jsonObject ?: error("Missing pending-input control")
        val lease = value["lease"]?.jsonObject
        val generation = lease?.get("generation")?.jsonPrimitive?.longOrNull
        check(value.string("scope") == "pending_first_send_stop" && lease?.string("clientId") == clientId && generation != null && generation > 0) {
            "Another device has control; take control explicitly before continuing"
        }
        return buildJsonObject { put("clientId", clientId); put("generation", generation) }
    }
    suspend fun takeControl(stamp: String, owner: String, id: String, clientId: String): Long {
        val captured = current(stamp, owner)
        val row = check(captured, id)
        check(row.preparation()?.flag("accepted") == true && row.phase() != "cancelled") { "The accepted first message is unavailable." }
        if (row.admission()?.flag("stopRequested") == true) return 0
        if (row.mapped()) return acquire(captured, row.preparation()!!.getValue("sessionId").jsonPrimitive.content, clientId, force = true)
        val held = pendingControl(captured, id, clientId, force = true)
        change(captured, id) { JsonObject(it + ("pendingStopControl" to held)) }
        return held.getValue("generation").jsonPrimitive.long
    }
    suspend fun stop(stamp: String, owner: String, id: String, clientId: String): Any? {
        val captured = current(stamp, owner)
        val before = local(captured, id)
        check(before.preparation()?.flag("accepted") == true && before.phase() != "cancelled") { "The accepted first message is unavailable." }
        change(captured, id) { JsonObject(it + ("stopCommandId" to (it["stopCommandId"] ?: JsonPrimitive(UUID.randomUUID().toString())))) }
        var row = check(captured, id)
        if (row.phase() == "cancelled" || row.admission()?.flag("stopRequested") == true) return row.wire()
        if (!row.mapped()) {
            check(captured.pendingStop) { "This Gateway cannot stop a first message before the Node is ready." }
            val held = row["pendingStopControl"] as? JsonObject ?: pendingControl(captured, id, clientId)
            change(captured, id) { JsonObject(it + ("pendingStopControl" to held)) }
            active(captured, id, allowStopped = true)
            try {
                val result = api(captured, "POST", path(id) + "/stop", held)?.jsonObject?.get("preparation")?.jsonObject
                    ?: error("Missing Stop receipt")
                return receipt(captured, id, result).wire()
            } catch (error: Exception) {
                try { check(captured, id) } catch (_: Exception) { /* Keep durable input and intent. */ }
                throw error
            }
        }
        val session = row.preparation()!!.getValue("sessionId").jsonPrimitive.content
        val generation = acquire(captured, session, clientId)
        val command = row.getValue("stopCommandId").jsonPrimitive.content
        var missing = false
        try {
            val receipt = api(captured, "GET", "/api/sessions/${session.urlSegment()}/commands/${command.urlSegment()}")?.jsonObject?.get("command")?.jsonObject
            check(receipt?.string("status") == "accepted") { "Stop is still unconfirmed; check before retrying" }
        } catch (error: ApiException) { if (error.status == 404) missing = true else throw error }
        if (missing) {
            active(captured, id, allowStopped = true)
            val result = api(captured, "POST", "/api/sessions/${session.urlSegment()}/commands", buildJsonObject {
                put("commandId", command); put("clientId", clientId); put("generation", generation)
                put("payload", buildJsonObject { put("type", "stop") })
            })?.jsonObject?.get("command")?.jsonObject
            check(result?.string("status") == "accepted") { "Stop is still unconfirmed; check before retrying" }
        }
        return check(captured, id).wire()
    }
    suspend fun release(stamp: String, owner: String, id: String): Any? {
        val captured = current(stamp, owner)
        var row = check(captured, id)
        check(row.phase() != "cancelled") { "The accepted first message is unavailable." }
        check(row.admission()?.flag("stopConfirmed") == true) { "Stop is still unconfirmed" }
        if (!row.mapped()) {
            row = action(captured, id, "materialize", allowStopped = true)
            check(row.mapped()) { "Conversation preparation is not yet confirmed. Check the result." }
        }
        return change(captured, id) { JsonObject(it + ("released" to JsonPrimitive(true))) }.wire()
    }
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
