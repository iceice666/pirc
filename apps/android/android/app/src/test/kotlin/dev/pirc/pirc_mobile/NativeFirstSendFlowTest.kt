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
            if (path.endsWith("/capabilities")) return objectReply("""{"version":1,"ownerUser":"alice","canFenceAccount":true,"canStopBeforeAllocation":true,"canSubmit":$enabled}""")
            assertEquals("alice", request.headers["x-pirc-account"])
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
                update("admitted")
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
}
