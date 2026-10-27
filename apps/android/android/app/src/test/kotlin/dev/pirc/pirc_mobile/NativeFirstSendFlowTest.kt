package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.*
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeFirstSendFlowTest {
    private class Ledger : Dispatcher() {
        var preparation: JsonObject? = null
        var enabled = true
        var canRetry = true
        var canRetire = true
        var loseRetirement = false
        var retirementTransform: ((JsonObject) -> JsonObject)? = null
        var onRetirement: (() -> Unit)? = null
        val retirements = mutableMapOf<String, JsonObject>()
        var unsupportedRetry = false
        var rejectDispatch = false
        var loseRetry = false
        var dropRetry = false
        var onRetry: ((JsonObject)->Unit)? = null
        var contract: Int? = 2
        var failMaterialize = false
        var losePendingStop = false
        var dropPendingStop = false
        var raceMapping = false
        var pendingScope = "pending_first_send_stop"
        var loseDispatch = false
        var loseStop = false
        var cleanupPending = false
        var stopCommand: String? = null
        var onAccept: (() -> Unit)? = null
        @Volatile var holdAccept: CountDownLatch? = null
        val calls = Collections.synchronizedList(mutableListOf<String>())
        private fun reply(body: JsonElement, code: Int = 200) = MockResponse.Builder().code(code).body(body.toString()).build()
        private fun objectReply(body: String, code: Int = 200) = MockResponse.Builder().code(code).body(body).build()
        private fun update(phase: String, accepted: Boolean = true) {
            preparation = JsonObject(preparation!! + mapOf("state" to JsonPrimitive(phase), "accepted" to JsonPrimitive(accepted)))
        }
        override fun dispatch(request: RecordedRequest): MockResponse {
            val response = synchronized(this) { respond(request) }
            if (request.url.encodedPath.endsWith("/accept")) check(holdAccept?.await(10, TimeUnit.SECONDS) != false)
            return response
        }
        private fun respond(request: RecordedRequest): MockResponse {
            val path = request.url.encodedPath
            calls += "${request.method} $path"
            if (path.endsWith("/capabilities")) {
                val fields = contract?.let { "\"clientContract\":$it,\"requiredClientContract\":2," } ?: ""
                return objectReply("""{"version":1,${fields}"ownerUser":"alice","canFenceAccount":true,"canStopBeforeAllocation":true,"canRetryFirstMessage":$canRetry,"canRetireFirstMessageRetry":$canRetire,"canSubmit":$enabled}""")
            }
            assertEquals("alice", request.headers["x-pirc-account"])
            if (path.contains("/retries/")) {
                val id = path.substringAfter("/retries/").substringBefore('/')
                val retiring = request.method == "POST" && path.endsWith("/retire")
                if (retiring) onRetirement?.invoke()
                val admission = preparation?.get("messageAdmission")?.jsonObject
                if (admission?.get("retryId")?.jsonPrimitive?.contentOrNull == id) return reply(buildJsonObject {
                    put("preparation", preparation!!); put("retry", buildJsonObject {
                        put("retryId", id); put("previousCommandId", "cmd-original"); put("commandId", admission.getValue("commandId")); put("attemptNumber", admission.getValue("attemptNumber")); put("status", "outcome_unknown")
                    })
                })
                if (retiring) {
                    val input = PircJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                    assertEquals("cmd-original", input["previousCommandId"]?.jsonPrimitive?.content)
                    assertEquals("android-fixture", input["clientId"]?.jsonPrimitive?.content)
                    assertEquals(7, input["generation"]?.jsonPrimitive?.int)
                    val proof = buildJsonObject { put("preparation", preparation!!); put("retry", buildJsonObject {
                        put("retryId", id); put("previousCommandId", input.getValue("previousCommandId")); put("status", "not_reserved"); put("retired", true)
                    }) }
                    retirements[id] = proof
                    if (loseRetirement) {loseRetirement=false; return objectReply("{}",503)}
                    return reply(retirementTransform?.invoke(proof) ?: proof)
                }
                return retirements[id]?.let {reply(it)} ?: objectReply("{}",404)
            }
            if (path.endsWith("/retry")) {
                val input=PircJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                onRetry?.invoke(input)
                if(unsupportedRetry) return objectReply("""{"error":{"code":"initial_retry_unsupported","message":"Upgrade Node"}}""",409)
                if(dropRetry){dropRetry=false;return objectReply("{}",503)}
                assertEquals("cmd-original",input["previousCommandId"]?.jsonPrimitive?.content)
                assertEquals("android-fixture",input["clientId"]?.jsonPrimitive?.content)
                assertEquals(7,input["generation"]?.jsonPrimitive?.int)
                update("admitted")
                preparation=JsonObject(preparation!!+("messageAdmission" to buildJsonObject {
                    put("commandId","cmd-next");put("retryId",input.getValue("retryId"));put("attemptNumber",1);put("outcome","admitted");put("stopRequested",false);put("stopConfirmed",false);put("retryEligible",false)
                }))
                if(loseRetry){loseRetry=false;return objectReply("{}",503)}
                return reply(buildJsonObject {put("preparation",preparation!!)})
            }
            if (path.endsWith("/prepare")) {
                val input = PircJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                assertEquals("alice", input["expectedOwner"]!!.jsonPrimitive.content)
                if (preparation == null) preparation = buildJsonObject {
                    put("operationId", input.getValue("operationId")); put("sessionId", "public-session")
                    put("workspaceId", input.getValue("submission").jsonObject.getValue("workspaceId"))
                    put("submission", input.getValue("submission")); put("state", "preparing")
                    put("accepted", false); put("cleanupPending", false); put("nodeMapped", false)
                }
            } else if (path.contains("/attachments/")) {
                assertEquals("application/octet-stream", request.headers["Content-Type"])
                assertEquals("hello", request.body!!.utf8())
                return objectReply("{}")
            } else if (path.endsWith("/accept")) { update("accepted"); onAccept?.invoke() }
            else if (path.endsWith("/materialize")) {
                if (failMaterialize) return objectReply("{}", 503)
                update(if (preparation!!["messageAdmission"]?.jsonObject?.get("stopConfirmed")?.jsonPrimitive?.booleanOrNull == true) "stopped" else "ready")
                preparation = JsonObject(preparation!! + ("nodeMapped" to JsonPrimitive(true)))
            }
            else if (path.endsWith("/stop-control/acquire")) return objectReply("""{"scope":"$pendingScope","lease":{"clientId":"android-fixture","generation":11}}""")
            else if (path.endsWith("/stop") && request.method == "POST") {
                val held = PircJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                assertEquals("android-fixture", held["clientId"]?.jsonPrimitive?.content)
                assertEquals(11, held["generation"]?.jsonPrimitive?.int)
                if (dropPendingStop) { dropPendingStop = false; return objectReply("{}", 503) }
                if (raceMapping) { raceMapping = false; update("ready");preparation=JsonObject(preparation!!+("nodeMapped" to JsonPrimitive(true)));return objectReply("""{"error":{"code":"session_control_required","message":"Use Node control"}}""",409) }
                update("stopping")
                preparation = JsonObject(preparation!! + ("messageAdmission" to buildJsonObject { put("stopRequested", true); put("stopConfirmed", false); put("outcome", "outcome_unknown") }))
                if (losePendingStop) { losePendingStop = false; return objectReply("{}", 503) }
            }
            else if (path.endsWith("/control/acquire")) return objectReply("""{"lease":{"clientId":"android-fixture","generation":7}}""")
            else if (path.endsWith("/dispatch")) {
                update(if(rejectDispatch) "admission_failed" else "admitted")
                if(rejectDispatch) preparation=JsonObject(preparation!!+("messageAdmission" to buildJsonObject {
                    put("commandId","cmd-original");put("attemptNumber",0);put("outcome","not_admitted");put("stopRequested",false);put("stopConfirmed",false);put("retryEligible",true)
                }))
                if (loseDispatch) { loseDispatch = false; return objectReply("{}", 503) }
            } else if (path.endsWith("/commands") && request.method == "POST") {
                val input = PircJson.parseToJsonElement(request.body!!.utf8()).jsonObject
                stopCommand = input.getValue("commandId").jsonPrimitive.content
                val admitted = preparation!!["state"]?.jsonPrimitive?.content == "admitted"
                preparation = JsonObject(preparation!! + mapOf(
                    "state" to JsonPrimitive(if (admitted) "admitted" else "stopped"), "messageAdmission" to buildJsonObject {
                        put("outcome", if (admitted) "accepted" else "outcome_unknown"); put("stopRequested", true); put("stopConfirmed", true)
                    },
                ))
                if (loseStop) { loseStop = false; return objectReply("{}", 503) }
                return objectReply("""{"command":{"status":"accepted"}}""")
            } else if (path.contains("/commands/")) {
                return if (path.endsWith("/$stopCommand")) objectReply("""{"command":{"status":"accepted"}}""") else objectReply("{}", 404)
            } else if (request.method == "DELETE") {
                update("cancelled", preparation!!.getValue("accepted").jsonPrimitive.boolean)
                preparation = JsonObject(preparation!! + ("cleanupPending" to JsonPrimitive(cleanupPending)))
            }
            return preparation?.let { reply(buildJsonObject { put("preparation", it) }) } ?: objectReply("{}", 404)
        }
    }
    private class Fixture : AutoCloseable {
        val parent = Files.createTempDirectory("pirc-first-flow-").toFile()
        val ledger = Ledger()
        val server = MockWebServer().apply { dispatcher = ledger; start() }
        val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "fixture-token"))
        var stamp = "pair-a"
        fun connection(directory: String = "drafts") = NativeFirstSend(File(parent, directory), { requested -> requirePairingStamp(requested, stamp); api }, { requested -> requirePairingStamp(requested, stamp) })
        suspend fun saved(connection: NativeFirstSend, withFile: Boolean = true): Map<*, *> {
            connection.capabilities(stamp)
            val files = if (withFile) listOf(mapOf("id" to "file1", "name" to "note.txt", "mimeType" to "text/plain", "byteSize" to 5)) else emptyList()
            return connection.drafts(stamp, "alice", mapOf("action" to "put", "operationId" to "op", "record" to mapOf(
                "workspaceId" to "node:repo", "message" to "Original", "model" to mapOf("provider" to "fake", "id" to "model"),
                "thinking" to "low", "frozen" to false, "prepareAttempted" to false, "files" to files,
            ), "files" to if (withFile) listOf(mapOf("id" to "file1", "bytes" to "hello".toByteArray())) else emptyList<Any>())) as Map<*, *>
        }
        suspend fun pending(c: NativeFirstSend) {
            saved(c);ledger.failMaterialize=true
            try {c.submit(stamp,"alice","op",1,"android-fixture");fail("must remain accepted")}catch(e:ApiException){assertEquals(503,e.status)}
            ledger.failMaterialize=false;ledger.calls.clear()
        }
        suspend fun row(connection: NativeFirstSend) = connection.drafts(stamp, "alice", mapOf("action" to "get", "operationId" to "op")) as Map<*, *>?
        override fun close() { server.close(); parent.deleteRecursively() }
    }
    private fun prep(row: Any?) = (row as Map<*, *>)["preparation"] as Map<*, *>
    @Test fun retryCommitsNonceBeforeHttpAndRetainsOriginalTextAndFileBytes() = runTest { Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.rejectDispatch=true
        assertEquals("admission_failed",prep(c.submit(f.stamp,"alice","op",1,"android-fixture"))["state"])
        f.ledger.calls.clear()
        f.ledger.onRetry={input->
            val file=f.parent.walkTopDown().single {it.name=="record.json"}
            val row=PircJson.parseToJsonElement(file.readText()).jsonObject.getValue("record").jsonObject
            assertEquals(input["retryId"],row.getValue("retryAttempt").jsonObject["retryId"])
            assertEquals("cmd-original",row.getValue("retryAttempt").jsonObject["previousCommandId"]?.jsonPrimitive?.content)
            assertEquals(true,row["uncertain"]?.jsonPrimitive?.boolean)
        }
        val result=c.retry(f.stamp,"alice","op","android-fixture") as Map<*,*>
        assertEquals("admitted",prep(result)["state"]);assertEquals("public-session",prep(result)["sessionId"])
        assertEquals("Original",result["message"]);assertEquals(true,(result["retryAttempt"] as Map<*,*>)["resolved"])
        assertFalse(f.ledger.calls.any {it.endsWith("/prepare")||it.endsWith("/accept")||it.endsWith("/materialize")||it.contains("/attachments/")||it.endsWith("/dispatch")})
        assertEquals(1,f.parent.walkTopDown().count {it.name=="record.json"})
        assertTrue(f.parent.walkTopDown().filter {it.isFile && it.name.startsWith("blob-")}.all {String(it.readBytes())=="hello"})
    }}
    @Test fun retryLostReplyReopensPrivateJournalAndOnlyQueriesItsNonce() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.rejectDispatch=true;c.submit(f.stamp,"alice","op",1,"android-fixture")
        f.ledger.loseRetry=true
        try {c.retry(f.stamp,"alice","op","android-fixture");fail("lost")}catch(e:ApiException){assertEquals(503,e.status)}
        val saved=f.row(c)!!;val nonce=(saved["retryAttempt"] as Map<*,*>)["retryId"]
        val reopened=f.connection();reopened.capabilities(f.stamp);f.ledger.calls.clear()
        assertEquals("admitted",prep(reopened.check(f.stamp,"alice","op"))["state"])
        assertEquals(listOf("GET /api/conversation-submissions/op/retries/$nonce"),f.ledger.calls)
        assertEquals(true,(f.row(reopened)!!["retryAttempt"] as Map<*,*>)["resolved"])
    }}
    @Test fun retryNotReceivedRemainsUnknownAndRepeatedExplicitRetryNeverReposts() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.rejectDispatch=true;c.submit(f.stamp,"alice","op",1,"android-fixture")
        f.ledger.dropRetry=true
        try {c.retry(f.stamp,"alice","op","android-fixture");fail("lost")}catch(_:ApiException){}
        val reopened=f.connection();reopened.capabilities(f.stamp);f.ledger.calls.clear()
        val result=reopened.retry(f.stamp,"alice","op","android-fixture") as Map<*,*>
        assertEquals(true,result["uncertain"]);assertFalse(f.ledger.calls.any {it.startsWith("POST")})
        assertEquals(2,f.ledger.calls.size)
        assertTrue(f.ledger.calls[0].contains("/retries/"));assertEquals("GET /api/conversation-submissions/op/receipt",f.ledger.calls[1])
    }}
    @Test fun freshRetryCapabilitiesAreRequiredBeforeControlOrJournalMutation() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.rejectDispatch=true;c.submit(f.stamp,"alice","op",1,"android-fixture")
        f.ledger.canRetry=false;f.ledger.calls.clear()
        try {c.retry(f.stamp,"alice","op","android-fixture");fail("unsupported")}catch(_:IllegalStateException){}
        assertNull(f.row(c)!!["retryAttempt"]);assertFalse(f.ledger.calls.any {it.startsWith("POST")})
    }}
    @Test fun explicitUnsupportedNodeRefusalDoesNotLeaveAPermanentUnknownRetry() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.rejectDispatch=true;c.submit(f.stamp,"alice","op",1,"android-fixture")
        f.ledger.unsupportedRetry=true
        try {c.retry(f.stamp,"alice","op","android-fixture");fail("unsupported")}catch(e:ApiException){assertEquals("initial_retry_unsupported",e.code)}
        val saved=f.row(c)!!;assertEquals(false,saved["uncertain"]);assertEquals(true,(saved["retryAttempt"] as Map<*,*>)["notReserved"])
        f.ledger.unsupportedRetry=false
        assertEquals("admitted",prep(c.retry(f.stamp,"alice","op","android-fixture"))["state"])
    }}
    private suspend fun interrupted(f: Fixture): NativeFirstSend {
        val c=f.connection(); f.saved(c); f.ledger.rejectDispatch=true
        c.submit(f.stamp,"alice","op",1,"android-fixture")
        f.ledger.dropRetry=true
        try {c.retry(f.stamp,"alice","op","android-fixture");fail("lost")} catch (_: ApiException) {}
        f.ledger.calls.clear()
        return c
    }
    @Test fun recoveryRetiresWithoutSendingAndAnotherExplicitRetryKeepsOriginalBytes() = runTest {Fixture().use {f->
        val c=interrupted(f); val before=f.row(c)!!; val nonce=(before["retryAttempt"] as Map<*,*>)["retryId"]
        val recovered=c.recoverRetry(f.stamp,"alice","op","android-fixture") as Map<*,*>
        assertEquals("admission_failed",prep(recovered)["state"]);assertEquals(false,recovered["uncertain"])
        assertEquals(true,(recovered["retryAttempt"] as Map<*,*>)["notReserved"])
        assertEquals(nonce,(recovered["retryAttempt"] as Map<*,*>)["retryId"])
        assertEquals("Original",recovered["message"])
        val store=FirstSendDraftStore(File(f.parent,"drafts"))
        assertArrayEquals("hello".toByteArray(),store.attachment(recovered["scope"] as String,"op","file1").second)
        assertEquals(1,f.ledger.calls.count {it.endsWith("/retire")})
        assertFalse(f.ledger.calls.any {it.endsWith("/retry") || it.endsWith("/prepare") || it.contains("/attachments/")})
        assertEquals("admitted",prep(c.retry(f.stamp,"alice","op","android-fixture"))["state"])
        assertNotEquals(nonce,(f.row(c)!!["retryAttempt"] as Map<*,*>)["retryId"])
    }}
    @Test fun lostRetirementReplyReopensAndResolvesOnlyByGet() = runTest {Fixture().use {f->
        val c=interrupted(f);f.ledger.loseRetirement=true
        try {c.recoverRetry(f.stamp,"alice","op","android-fixture");fail("lost")}catch(e:ApiException){assertEquals(503,e.status)}
        assertNotEquals(true,(f.row(c)!!["retryAttempt"] as Map<*,*>)["resolved"])
        val reopened=f.connection();reopened.capabilities(f.stamp);f.ledger.calls.clear()
        val recovered=reopened.check(f.stamp,"alice","op") as Map<*,*>
        assertEquals(true,(recovered["retryAttempt"] as Map<*,*>)["notReserved"])
        assertEquals(false,recovered["uncertain"]);assertEquals(1,f.ledger.calls.size)
        assertTrue(f.ledger.calls.single().startsWith("GET "))
    }}
    @Test fun retirementCannotResolveAMismatchedOrContradictoryReceipt() = runTest {
        for(field in listOf("retryId","previousCommandId","status","retired","quotedRetired","commandId","attemptNumber","operationId","sessionId","workspaceId")) Fixture().use {f->
            val c=interrupted(f)
            f.ledger.retirementTransform={proof->
                val key=if(field in setOf("operationId","sessionId","workspaceId")) "preparation" else "retry"
                val bad=JsonObject(proof.getValue(key).jsonObject+((if(field=="quotedRetired") "retired" else field) to when(field){"quotedRetired"->JsonPrimitive("true");"retired"->JsonPrimitive(false);"attemptNumber"->JsonPrimitive(1);else->JsonPrimitive("wrong")}))
                JsonObject(proof+(key to bad))
            }
            try {c.recoverRetry(f.stamp,"alice","op","android-fixture");fail(field)}catch(_:IllegalArgumentException){}
            val row=f.row(c)!!;assertEquals(field,true,row["uncertain"]);assertNotEquals(field,true,(row["retryAttempt"] as Map<*,*>)["resolved"])
        }
    }
    @Test fun recoveryDoesNotRequireRolloutButRequiresFreshRetirementCapability() = runTest {Fixture().use {f->
        val c=interrupted(f);f.ledger.canRetire=false
        try {c.recoverRetry(f.stamp,"alice","op","android-fixture");fail("unsupported")}catch(_:IllegalStateException){}
        assertFalse(f.ledger.calls.any {it.startsWith("POST ")})
        f.ledger.canRetire=true;f.ledger.enabled=false
        assertEquals(true,((c.recoverRetry(f.stamp,"alice","op","android-fixture") as Map<*,*>)["retryAttempt"] as Map<*,*>)["notReserved"])
    }}
    @Test fun lateRetirementProofDoesNotResolveANewerPrivateNonce() = runTest {Fixture().use {f->
        val c=interrupted(f);val row=f.row(c)!!
        f.ledger.onRetirement={
            FirstSendDraftStore(File(f.parent,"drafts")).update(row["scope"] as String,"alice","op") {old->
                JsonObject(old+("retryAttempt" to buildJsonObject {put("retryId","newer");put("previousCommandId","cmd-original");put("previousAttemptNumber",0)}))
            }
        }
        val result=c.recoverRetry(f.stamp,"alice","op","android-fixture") as Map<*,*>
        assertEquals("newer",(result["retryAttempt"] as Map<*,*>)["retryId"])
        assertNotEquals(true,(result["retryAttempt"] as Map<*,*>)["resolved"]);assertEquals(true,result["uncertain"])
    }}
    @Test fun firstSendUsesSavedTextFilesAndIdentityWithoutLegacyCreationOrCommands() = runTest { Fixture().use { f ->
        val connection = f.connection()
        f.saved(connection)
        val result = connection.submit(f.stamp, "alice", "op", 1, "android-fixture")
        assertEquals("admitted", prep(result)["state"])
        assertEquals("Original", (result as Map<*, *>)["message"])
        assertEquals(1, f.ledger.calls.count { it.endsWith("/prepare") })
        assertEquals(1, f.ledger.calls.count { it.endsWith("/dispatch") })
        assertFalse(f.ledger.calls.contains("POST /api/sessions"))
        assertFalse(f.ledger.calls.any { it.endsWith("/commands") })
    } }
    @Test fun lostDispatchReplyRestoresFromDiskAndChecksWithoutTakingControlOrReplaying() = runTest { Fixture().use { f ->
        val first = f.connection(); f.saved(first); f.ledger.loseDispatch = true
        try { first.submit(f.stamp, "alice", "op", 1, "android-fixture"); fail("lost reply must stay uncertain") }
        catch (error: ApiException) { assertEquals(503, error.status) }
        assertEquals(true, f.row(first)!!["uncertain"])
        val restored = f.connection(); restored.capabilities(f.stamp); f.ledger.calls.clear()
        assertEquals("admitted", prep(restored.check(f.stamp, "alice", "op"))["state"])
        restored.submit(f.stamp, "alice", "op", null, "android-fixture")
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt", "GET /api/conversation-submissions/op/receipt"), f.ledger.calls)
    } }
    @Test fun anUnknownAdmissionStaysQueryOnlyEvenOnExplicitContinue() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection); f.ledger.loseDispatch = true
        try { connection.submit(f.stamp, "alice", "op", 1, "android-fixture") } catch (_: ApiException) {}
        f.ledger.preparation = JsonObject(f.ledger.preparation!! + ("state" to JsonPrimitive("outcome_unknown")))
        f.ledger.calls.clear()
        assertEquals("outcome_unknown", prep(connection.submit(f.stamp, "alice", "op", null, "android-fixture"))["state"])
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt"), f.ledger.calls)
    } }
    @Test fun localDiscardNeverCreatesARemoteSessionAndCannotBeResurrected() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection); f.ledger.calls.clear()
        assertNull(connection.cancel(f.stamp, "alice", "op")); assertNull(f.row(connection))
        assertTrue(f.ledger.calls.isEmpty())
        try { connection.submit(f.stamp, "alice", "op", 1, "android-fixture"); fail("discarded draft must be fenced") } catch (_: IllegalStateException) {}
        assertTrue(f.ledger.calls.isEmpty())
    } }
    @Test fun anotherDeviceAdoptsAcceptedFilesAndContinuesWithoutUploadingItsOwnCopy() = runTest { Fixture().use { f ->
        val remote = FirstSendApi(f.api)
        val file = buildJsonObject {
            put("id", "file1"); put("name", "note.txt"); put("mimeType", "text/plain"); put("byteSize", 5)
            put("sha256", FirstSendDraftStore.digest("hello".toByteArray()))
        }
        remote.request("POST", "/api/conversation-submissions/prepare", "alice", buildJsonObject {
            put("expectedOwner", "alice"); put("operationId", "other-op")
            put("submission", buildJsonObject { put("workspaceId", "node:repo"); put("message", "From another device"); put("attachments", JsonArray(listOf(file))) })
        })
        remote.request("PUT", "/api/conversation-submissions/other-op/attachments/file1", "alice", bytes = "hello".toByteArray())
        remote.request("POST", "/api/conversation-submissions/other-op/accept", "alice")
        val connection = f.connection("second-device")
        connection.capabilities(f.stamp)
        f.ledger.calls.clear()
        val adopted = connection.adopt(f.stamp, "alice", "public-session") as Map<*, *>
        assertEquals("From another device", adopted["message"])
        assertFalse(File(f.parent, "second-device").walkTopDown().any { it.name.startsWith("blob-") })
        val result = connection.submit(f.stamp, "alice", "other-op", null, "android-fixture")
        assertEquals("admitted", prep(result)["state"])
        assertFalse(f.ledger.calls.any { it.contains("/attachments/") })
        assertEquals(1, f.ledger.calls.count { it.endsWith("/dispatch") })
    } }
    @Test fun refreshingTheSameAuthenticatedCapabilitiesDoesNotInterruptAnInFlightSend() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection)
        val accepted = CompletableDeferred<Unit>()
        f.ledger.onAccept = { accepted.complete(Unit) }
        val gate = CountDownLatch(1)
        f.ledger.holdAccept = gate
        val sending = async { connection.submit(f.stamp, "alice", "op", 1, "android-fixture") }
        accepted.await()
        try { connection.capabilities(f.stamp) } finally { gate.countDown() }
        assertEquals("admitted", prep(sending.await())["state"])
        assertEquals(1, f.ledger.calls.count { it.endsWith("/dispatch") })
    } }
    @Test fun activationGateRefusesANewSendBeforeAnyNetworkMutation() = runTest { Fixture().use { f ->
        f.ledger.enabled = false
        val connection = f.connection(); f.saved(connection); f.ledger.calls.clear()
        try { connection.submit(f.stamp, "alice", "op", 1, "android-fixture"); fail("must stay gated") } catch (_: IllegalStateException) {}
        assertEquals(false, f.row(connection)!!["frozen"]); assertTrue(f.ledger.calls.isEmpty())
    } }
    @Test fun anUncertainStopReusesItsCommandAndPreservesOriginalInput() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection)
        connection.submit(f.stamp, "alice", "op", 1, "android-fixture")
        f.ledger.loseStop = true
        try { connection.stop(f.stamp, "alice", "op", "android-fixture"); fail("Stop result must be checked") } catch (_: ApiException) {}
        val command = f.ledger.stopCommand
        connection.stop(f.stamp, "alice", "op", "android-fixture")
        assertEquals(command, f.row(connection)!!["stopCommandId"])
        assertEquals(1, f.ledger.calls.count { it == "POST /api/sessions/public-session/commands" })
        assertEquals("Original", f.row(connection)!!["message"])
        assertEquals(true, (connection.release(f.stamp, "alice", "op") as Map<*, *>)["released"])
    } }
    @Test fun pendingDeletionCanFinishAndLatePendingEvidenceCannotUndoCompletion() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection)
        connection.submit(f.stamp, "alice", "op", 1, "android-fixture")
        f.ledger.cleanupPending = true
        assertEquals(true, prep(connection.cancel(f.stamp, "alice", "op", deleteAccepted = true))["cleanupPending"])
        val pending = f.ledger.preparation!!
        f.ledger.preparation = JsonObject(pending + ("cleanupPending" to JsonPrimitive(false)))
        assertEquals(false, prep(connection.check(f.stamp, "alice", "op"))["cleanupPending"])
        assertEquals("", f.row(connection)!!["message"])
        assertTrue((f.row(connection)!!["files"] as List<*>).isEmpty())
        f.ledger.preparation = pending
        assertEquals(false, prep(connection.check(f.stamp, "alice", "op"))["cleanupPending"])
    } }
    @Test fun discardingAStaleUnacceptedViewCannotDeleteAnAcceptedConversationWithoutConfirmation() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection)
        connection.submit(f.stamp, "alice", "op", 1, "android-fixture")
        f.ledger.calls.clear()
        try { connection.cancel(f.stamp, "alice", "op"); fail("Accepted deletion needs explicit confirmation") }
        catch (error: ApiException) { assertEquals("confirmation_required", error.code) }
        assertFalse(f.ledger.calls.any { it.startsWith("DELETE ") })
        assertEquals("Original", f.row(connection)!!["message"])
        connection.cancel(f.stamp, "alice", "op", deleteAccepted = true)
        assertTrue(f.ledger.calls.contains("DELETE /api/sessions/public-session"))
    } }
    @Test fun platformDraftEditsCannotForgeAdmissionOrForgetAnUncertainSend() = runTest { Fixture().use { f ->
        val connection = f.connection(); val saved = f.saved(connection)
        try {
            connection.drafts(f.stamp, "alice", mapOf("action" to "put", "operationId" to "op", "expectedRevision" to 1,
                "record" to (saved + ("preparation" to mapOf("accepted" to true, "state" to "admitted")))))
            fail("Caller cannot forge admission")
        } catch (_: IllegalArgumentException) {}
        f.ledger.loseDispatch = true
        try { connection.submit(f.stamp, "alice", "op", 1, "android-fixture") } catch (_: ApiException) {}
        val frozen = f.row(connection)!!
        try {
            connection.drafts(f.stamp, "alice", mapOf("action" to "delete", "operationId" to "op", "expectedRevision" to frozen["revision"]))
            fail("Uncertain input must be kept")
        } catch (_: IllegalStateException) {}
        assertEquals("Original", f.row(connection)!!["message"])
    } }
    @Test fun accountChangeDuringAcceptanceCannotContinueOrReturnOldAccountData() = runTest { Fixture().use { f ->
        val connection = f.connection(); f.saved(connection)
        f.ledger.onAccept = { f.stamp = "pair-b" }
        try { connection.submit("pair-a", "alice", "op", 1, "android-fixture"); fail("old reply must not reach the new account") }
        catch (error: ApiException) { assertEquals("account_changed", error.code) }
        assertFalse(f.ledger.calls.any { it.endsWith("/materialize") || it.endsWith("/dispatch") })
        connection.capabilities(f.stamp)
        assertEquals("accepted", prep(connection.check(f.stamp, "alice", "op"))["state"])
        assertEquals("Original", f.row(connection)!!["message"])
    } }

    @Test fun pendingStopUsesSeparateScopeAndChecksWithoutReplaying() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c)
        assertEquals("stopping",prep(c.stop(f.stamp,"alice","op","android-fixture"))["state"])
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt","POST /api/conversation-submissions/op/stop-control/acquire","POST /api/conversation-submissions/op/stop"),f.ledger.calls)
        assertNotNull(f.row(c)!!["stopCommandId"]);assertNotNull(f.row(c)!!["pendingStopControl"])
        f.ledger.calls.clear();c.check(f.stamp,"alice","op");c.submit(f.stamp,"alice","op",null,"android-fixture")
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt","GET /api/conversation-submissions/op/receipt"),f.ledger.calls)
    }}
    @Test fun stoppedContinuationPreparesOnlyBlankStorageWithOriginalFilesRetained() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);c.stop(f.stamp,"alice","op","android-fixture")
        f.ledger.preparation=JsonObject(f.ledger.preparation!!+mapOf("state" to JsonPrimitive("stopped"),"messageAdmission" to buildJsonObject {put("stopRequested",true);put("stopConfirmed",true);put("outcome","not_admitted")}))
        f.ledger.calls.clear();val row=c.release(f.stamp,"alice","op") as Map<*,*>
        assertEquals(true,prep(row)["nodeMapped"]);assertEquals(true,row["released"]);assertEquals("Original",row["message"]);assertEquals(1,(row["files"] as List<*>).size)
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt","POST /api/conversation-submissions/op/materialize"),f.ledger.calls)
        f.ledger.preparation=JsonObject(f.ledger.preparation!!+("nodeMapped" to JsonPrimitive(false)))
        assertEquals(true,prep(c.check(f.stamp,"alice","op"))["nodeMapped"])
    }}
    @Test fun lostPendingReplyRestoresAndOnlyChecksAcceptedStop() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);f.ledger.losePendingStop=true
        try {c.stop(f.stamp,"alice","op","android-fixture");fail("lost")}catch(e:ApiException){assertEquals(503,e.status)}
        val identity=f.row(c)!!["stopCommandId"];val restored=f.connection();restored.capabilities(f.stamp);f.ledger.calls.clear()
        restored.stop(f.stamp,"alice","op","android-fixture")
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt"),f.ledger.calls);assertEquals(identity,f.row(restored)!!["stopCommandId"])
    }}
    @Test fun unreceivedStopExplicitRetryUsesPersistedControl() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);f.ledger.dropPendingStop=true
        try {c.stop(f.stamp,"alice","op","android-fixture");fail("lost")}catch(_:ApiException){}
        val held=f.row(c)!!["pendingStopControl"];val restored=f.connection();restored.capabilities(f.stamp);f.ledger.calls.clear()
        restored.stop(f.stamp,"alice","op","android-fixture")
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt","POST /api/conversation-submissions/op/stop"),f.ledger.calls);assertEquals(held,f.row(restored)!!["pendingStopControl"])
    }}
    @Test fun mappingRaceRequiresFreshNodeControl() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);f.ledger.raceMapping=true
        try {c.stop(f.stamp,"alice","op","android-fixture");fail("race")}catch(e:ApiException){assertEquals("session_control_required",e.code)}
        assertEquals(true,prep(f.row(c))["nodeMapped"]);f.ledger.calls.clear();c.takeControl(f.stamp,"alice","op","android-fixture")
        assertEquals(listOf("GET /api/conversation-submissions/op/receipt","POST /api/sessions/public-session/control/acquire"),f.ledger.calls)
    }}
    @Test fun wrongScopeCannotAuthorizePendingStopOrNodeFallback() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);f.ledger.pendingScope="node"
        try {c.stop(f.stamp,"alice","op","android-fixture");fail("scope")}catch(_:IllegalStateException){}
        assertFalse(f.ledger.calls.any {it.endsWith("/stop") || it.endsWith("/commands")})
    }}

    @Test fun aLateWeakReceiptCannotEraseStopWhileLaterKnownAdmissionStillAdvances() = runTest {Fixture().use {f->
        val c=f.connection();f.pending(c);val weak=f.ledger.preparation!!
        c.stop(f.stamp,"alice","op","android-fixture");f.ledger.preparation=weak
        val pending=prep(c.check(f.stamp,"alice","op"));assertEquals("stopping",pending["state"])
        assertEquals(true,(pending["messageAdmission"] as Map<*,*>)["stopRequested"])
        f.ledger.preparation=JsonObject(weak+mapOf("state" to JsonPrimitive("admitted"),"nodeMapped" to JsonPrimitive(true)))
        val known=prep(c.check(f.stamp,"alice","op"));assertEquals("admitted",known["state"])
        assertEquals(true,(known["messageAdmission"] as Map<*,*>)["stopRequested"])
    }}

    @Test fun aCachedActivationCannotExecuteAfterTheServerDropsTheClientContract() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.contract=0;f.ledger.calls.clear()
        try {c.submit(f.stamp,"alice","op",1,"android-fixture");fail("contract changed")}catch(_:IllegalStateException){}
        assertEquals(listOf("GET /api/conversation-submissions/capabilities"),f.ledger.calls)
        assertEquals(false,f.row(c)!!["frozen"]);assertEquals("Original",f.row(c)!!["message"])
        assertEquals(true,(c.capabilities(f.stamp) as Map<*,*>)["firstSendUpgradeRequired"])
    }}
    @Test fun successfulOldGatedRepliesCannotRemoveTheBoundContractFence() = runTest {Fixture().use {f->
        val c=f.connection();f.saved(c);f.ledger.contract=null;f.ledger.enabled=false;f.ledger.calls.clear()
        repeat(2) { assertEquals(true,(c.capabilities(f.stamp) as Map<*,*>)["firstSendUpgradeRequired"]) }
        assertEquals("Original",f.row(c)!!["message"])
        assertEquals(false,f.row(c)!!["frozen"])
        assertTrue(f.ledger.calls.all { it == "GET /api/conversation-submissions/capabilities" })
    }}

    @Test fun nativeRecoveryCopiesFrozenPrivateBytesWithoutAnyGatewayMutation() = runTest {Fixture().use {f->
        val c=f.connection();val original=f.saved(c);f.ledger.failMaterialize=true
        try {c.submit(f.stamp,"alice","op",1,"android-fixture");fail("pending")}catch(_:ApiException){}
        f.ledger.calls.clear()
        try {c.drafts(f.stamp,"alice",mapOf("action" to "put","operationId" to "op","expectedRevision" to 1,"record" to mapOf("workspaceId" to "node:repo","message" to "Unsent","files" to original["files"])));fail("frozen")}
        catch(e:ApiException){assertEquals("draft_changed",e.code)}
        val copy=c.drafts(f.stamp,"alice",mapOf("action" to "recover","sourceOperationId" to "op","operationId" to "copy","record" to mapOf("workspaceId" to "node:repo","message" to "Unsent","files" to original["files"]))) as Map<*,*>
        assertEquals("op",copy["recoveredFrom"]);assertEquals("Unsent",copy["message"]);assertEquals(false,copy["frozen"])
        assertEquals("Original",f.row(c)!!["message"]);assertTrue(f.ledger.calls.isEmpty())
    }}

}
