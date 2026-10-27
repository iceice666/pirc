package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class NativeFirstSendTest {
    @Test fun offlineLocalStorageKeepsAuthenticatedScopeAndRefusesAChangedPairing() = runTest {
        val parent = Files.createTempDirectory("pirc-native-first-").toFile()
        val server = MockWebServer()
        server.start()
        var stamp = "pair-a"
        try {
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "fixture-token"))
            val access = NativeFirstSend(File(parent, "drafts"), { expected -> requirePairingStamp(expected, stamp); api }, { expected -> requirePairingStamp(expected, stamp) })
            server.enqueue(MockResponse.Builder().body("""{"version":1,"clientContract":2,"requiredClientContract":2,"ownerUser":"alice","canFenceAccount":true,"canSubmit":false}""").build())
            val caps = obj(access.capabilities(stamp))
            assertTrue(caps["draftScope"].toString().contains("alice"))
            val args = mapOf("action" to "put", "operationId" to "op", "record" to mapOf("workspaceId" to "node:repo", "message" to "Keep original", "frozen" to false, "files" to emptyList<Any>()))
            access.drafts(stamp, "alice", args)
            assertEquals(1, server.requestCount) // Edits/readback do not require a network round trip.
            assertEquals("Keep original", obj(access.drafts(stamp, "alice", mapOf("action" to "get", "operationId" to "op")))["message"])
            for ((requestedStamp, owner) in listOf("pair-b" to "alice", "pair-a" to "bob")) {
                try { access.drafts(requestedStamp, owner, mapOf("action" to "list")); fail("must isolate accounts") }
                catch (error: ApiException) { assertEquals("account_changed", error.code) }
            }
            stamp = "pair-b"
            try { access.drafts("pair-a", "alice", mapOf("action" to "list")); fail("old pairing must be refused") }
            catch (error: ApiException) { assertEquals("account_changed", error.code) }
            access.clear()
            try { access.drafts(stamp, "alice", mapOf("action" to "list")); fail("new pairing needs capability authentication") }
            catch (error: ApiException) { assertEquals("account_changed", error.code) }
        } finally { server.close(); parent.deleteRecursively() }
    }
    @Test fun openEditorReturnsAccountBoundBytesWithoutNetworkingOrCreatingAnotherDraft() = runTest {
        val parent = Files.createTempDirectory("pirc-native-first-").toFile()
        val server = MockWebServer()
        server.start()
        try {
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "fixture-token"))
            val access = NativeFirstSend(File(parent, "drafts"), { expected -> requirePairingStamp(expected, "pair-a"); api }, { expected -> requirePairingStamp(expected, "pair-a") })
            server.enqueue(MockResponse.Builder().body("""{"version":1,"clientContract":2,"requiredClientContract":2,"ownerUser":"alice","canFenceAccount":true,"canSubmit":false}""").build())
            access.capabilities("pair-a")
            val saved = obj(access.drafts("pair-a", "alice", mapOf("action" to "put", "operationId" to "op", "record" to mapOf(
                "workspaceId" to "node:repo", "message" to "Original", "files" to listOf(mapOf("id" to "f1", "name" to "note.txt", "mimeType" to "text/plain", "byteSize" to 5)),
            ), "files" to listOf(mapOf("id" to "f1", "bytes" to "hello".toByteArray())))))
            val snapshot = obj(access.drafts("pair-a", "alice", mapOf("action" to "open", "operationId" to "op")))
            assertEquals(saved, snapshot["record"])
            val files = snapshot["files"] as List<*>
            assertArrayEquals("hello".toByteArray(), obj(files.single())["bytes"] as ByteArray)
            access.drafts("pair-a", "alice", mapOf("action" to "delete", "operationId" to "op", "expectedRevision" to saved["revision"]))
            access.drafts("pair-a", "alice", mapOf("action" to "recover", "operationId" to "copy", "sourceOperationId" to "op", "record" to saved, "files" to files))
            assertNull(access.drafts("pair-a", "alice", mapOf("action" to "open", "operationId" to "op")))
            val restored = obj(access.drafts("pair-a", "alice", mapOf("action" to "open", "operationId" to "copy")))
            assertArrayEquals("hello".toByteArray(), obj((restored["files"] as List<*>).single())["bytes"] as ByteArray)
            assertEquals(1, (access.drafts("pair-a", "alice", mapOf("action" to "list")) as List<*>).size)
            for ((stamp, owner) in listOf("pair-b" to "alice", "pair-a" to "bob")) {
                try { access.drafts(stamp, owner, mapOf("action" to "open", "operationId" to "copy")); fail("must isolate accounts") }
                catch (error: ApiException) { assertEquals("account_changed", error.code) }
            }
            assertEquals(1, server.requestCount)
        } finally { server.close(); parent.deleteRecursively() }
    }
    private fun obj(value: Any?): Map<*, *> = value as Map<*, *>
}
