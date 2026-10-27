package dev.pirc.android.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class FirstSendDraftStoreTest {
    private fun value(message: String = "Original", files: JsonArray = JsonArray(emptyList())) = buildJsonObject {
        put("workspaceId", "node:repo"); put("message", message); put("frozen", false); put("prepareAttempted", false); put("files", files)
    }
    private fun attachment() = buildJsonObject {
        put("id", "f1"); put("name", "note.txt"); put("mimeType", "text/plain"); put("byteSize", 5)
    }
    private fun <T> fixture(action: (File, FirstSendDraftStore, String) -> T): T {
        val parent = Files.createTempDirectory("pirc-first-store-").toFile()
        try { return action(parent, FirstSendDraftStore(File(parent, "drafts")), FirstSendDraftStore.scope("https://example.test", "alice")) }
        finally { parent.deleteRecursively() }
    }
    private fun refused(action: () -> Unit) {
        try { action(); fail("Expected refusal") } catch (_: IllegalArgumentException) {} catch (_: IllegalStateException) {}
    }
    @Test fun persistedOriginalAndAttachmentSurviveReopeningWithoutAnIndexCache() = fixture { parent, store, scope ->
        val saved = store.put(scope, "alice", "op1", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        assertEquals(1L, saved.getValue("revision").jsonPrimitive.long)
        val reopened = FirstSendDraftStore(File(parent, "drafts"))
        assertEquals(saved, reopened.get(scope, "op1"))
        assertArrayEquals("hello".toByteArray(), reopened.attachment(scope, "op1", "f1").second)
        assertEquals(emptyList<JsonObject>(), reopened.list(FirstSendDraftStore.scope("https://example.test", "bob")))
        assertEquals(emptyList<JsonObject>(), reopened.list(FirstSendDraftStore.scope("https://other.test", "alice")))
    }
    @Test fun competingConnectionsHaveOnlyOneRevisionWinner() = fixture { parent, store, scope ->
        store.put(scope, "alice", "op1", null, value())
        val executor = Executors.newFixedThreadPool(2)
        try {
            val results = executor.invokeAll((1..2).map { n -> Callable {
                try { FirstSendDraftStore(File(parent, "drafts")).put(scope, "alice", "op1", 1, value("Edit $n")); true }
                catch (_: IllegalStateException) { false }
            } }).map { it.get() }
            assertEquals(1, results.count { it })
            assertEquals(2L, store.get(scope, "op1")!!.getValue("revision").jsonPrimitive.long)
        } finally { executor.shutdownNow() }
    }
    @Test fun abortedMetadataCommitKeepsThePreviouslyCommittedInput() = fixture { _, store, scope ->
        val before = store.put(scope, "alice", "op1", null, value())
        refused { store.put(scope, "alice", "op1", 1, value("x".repeat(1_000_001))) }
        assertEquals(before, store.get(scope, "op1"))
    }
    @Test fun anOrphanBlobFromAnInterruptedCommitDoesNotCreateAnotherDraft() = fixture { parent, store, scope ->
        store.put(scope, "alice", "op1", null, value())
        val dir = File(File(File(parent, "drafts"), FirstSendDraftStore.digest(scope.toByteArray())), FirstSendDraftStore.digest("orphan".toByteArray()))
        dir.mkdir()
        File(dir, "blob-${FirstSendDraftStore.digest("unused".toByteArray())}").writeText("unused")
        assertEquals(listOf("op1"), store.list(scope).map { it.getValue("operationId").jsonPrimitive.content })
    }
    @Test fun corruptionNeverBecomesAnUploadOrSilentlyErasesTheOriginalRecord() = fixture { parent, store, scope ->
        val row = store.put(scope, "alice", "op1", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        parent.walkTopDown().first { it.name.startsWith("blob-") }.writeText("wrong")
        refused { store.attachment(scope, "op1", "f1") }
        assertEquals(row, store.get(scope, "op1"))
    }
    @Test fun frozenInputAndItsManifestCannotBeChangedByAnotherWindow() = fixture { _, store, scope ->
        val row = store.put(scope, "alice", "op1", null, value())
        val frozen = store.put(scope, "alice", "op1", 1, JsonObject(row + ("frozen" to JsonPrimitive(true))))
        refused { store.put(scope, "alice", "op1", 2, JsonObject(frozen + ("message" to JsonPrimitive("changed")))) }
        assertEquals("Original", store.get(scope, "op1")!!.getValue("message").jsonPrimitive.content)
    }
    @Test fun discardLeavesOnlyAnIdentityTombstoneAndBlocksDelayedQueuedWrites() = fixture { parent, store, scope ->
        val saved = store.put(scope, "alice", "op1", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        store.remove(scope, "op1", 1)
        assertNull(store.get(scope, "op1")); assertTrue(store.list(scope).isEmpty())
        refused { store.put(scope, "alice", "op1", 1, saved) }
        refused { store.put(scope, "alice", "op1", null, value("resurrect")) }
        assertFalse(parent.walkTopDown().any { it.name.startsWith("blob-") })
        assertFalse(parent.walkTopDown().filter { it.isFile }.any { String(it.readBytes()).contains("Original") })
    }
    @Test fun symbolicLinkStorageNeverWritesOutsideThePrivateRoot() = fixture { parent, _, scope ->
        val outside = Files.createTempDirectory("pirc-first-sentinel-").toFile()
        try {
            Files.createSymbolicLink(File(parent, "linked").toPath(), outside.toPath())
            refused { FirstSendDraftStore(File(parent, "linked")).put(scope, "alice", "op", null, value()) }
            assertTrue(outside.listFiles().orEmpty().isEmpty())
        } finally { outside.deleteRecursively() }
    }

    @Test fun envelopeTwoFencesOldWritersAndLegacyEnvelopeOneIsImportedWithoutLosingBytes() = fixture {parent,store,scope->
        val saved=store.put(scope,"alice","op",null,value(files=JsonArray(listOf(attachment()))),mapOf("f1" to "hello".toByteArray()))
        val file=parent.walkTopDown().single {it.name=="record.json"}
        val envelope=PircJson.parseToJsonElement(file.readText()).jsonObject
        assertEquals(2,envelope["version"]?.jsonPrimitive?.int)
        // Actual envelope-1 readers require equality to 1 before exposing data.
        assertFalse(envelope["version"]?.jsonPrimitive?.int==1)
        file.writeText(JsonObject(envelope+("version" to JsonPrimitive(1))).toString())
        val restored=FirstSendDraftStore(File(parent,"drafts"))
        assertEquals(saved,restored.get(scope,"op"))
        assertEquals(2,PircJson.parseToJsonElement(file.readText()).jsonObject["version"]?.jsonPrimitive?.int)
        assertArrayEquals("hello".toByteArray(),restored.attachment(scope,"op","f1").second)
        restored.update(scope,"alice","op") {JsonObject(it+("stopCommandId" to JsonPrimitive("stop")))}
        val migrated=PircJson.parseToJsonElement(file.readText()).jsonObject
        assertEquals(2,migrated["version"]?.jsonPrimitive?.int)
        assertEquals("stop",restored.get(scope,"op")!!["stopCommandId"]?.jsonPrimitive?.content)
        file.writeText(JsonObject(migrated+("version" to JsonPrimitive(3))).toString())
        val future=file.readBytes();refused {restored.get(scope,"op")};assertArrayEquals(future,file.readBytes())
    }
}
