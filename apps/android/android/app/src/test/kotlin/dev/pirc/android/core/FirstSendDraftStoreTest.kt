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

    @Test fun envelopeThreeFencesPreRetryWritersAndLegacyEnvelopesAreImportedWithoutLosingBytes() = fixture {parent,store,scope->
        val saved=store.put(scope,"alice","op",null,value(files=JsonArray(listOf(attachment()))),mapOf("f1" to "hello".toByteArray()))
        val file=parent.walkTopDown().single {it.name=="record.json"}
        val envelope=PircJson.parseToJsonElement(file.readText()).jsonObject
        assertEquals(3,envelope["version"]?.jsonPrimitive?.int)
        // Actual envelope-1 readers require equality to 1 before exposing data.
        assertFalse(envelope["version"]?.jsonPrimitive?.int==1)
        file.writeText(JsonObject(envelope+("version" to JsonPrimitive(1))).toString())
        val restored=FirstSendDraftStore(File(parent,"drafts"))
        assertEquals(saved,restored.get(scope,"op"))
        assertEquals(3,PircJson.parseToJsonElement(file.readText()).jsonObject["version"]?.jsonPrimitive?.int)
        assertArrayEquals("hello".toByteArray(),restored.attachment(scope,"op","f1").second)
        restored.update(scope,"alice","op") {JsonObject(it+("stopCommandId" to JsonPrimitive("stop")))}
        file.writeText(JsonObject(envelope+("version" to JsonPrimitive(2))).toString())
        assertEquals(saved,restored.get(scope,"op"))
        assertArrayEquals("hello".toByteArray(),restored.attachment(scope,"op","f1").second)
        restored.update(scope,"alice","op") {JsonObject(it+("stopCommandId" to JsonPrimitive("stop")))}
        val migrated=PircJson.parseToJsonElement(file.readText()).jsonObject
        assertEquals(3,migrated["version"]?.jsonPrimitive?.int)
        assertEquals("stop",restored.get(scope,"op")!!["stopCommandId"]?.jsonPrimitive?.content)
        file.writeText(JsonObject(migrated+("version" to JsonPrimitive(4))).toString())
        val future=file.readBytes();refused {restored.get(scope,"op")};assertArrayEquals(future,file.readBytes())
    }
    @Test fun recoveryCopiesVerifiedOriginalAndNewBytesWithoutOverwritingAnyWriter() = fixture {parent,store,scope->
        val original=store.put(scope,"alice","op",null,value(files=JsonArray(listOf(attachment()))),mapOf("f1" to "hello".toByteArray()))
        val frozen=store.put(scope,"alice","op",1,JsonObject(original+("frozen" to JsonPrimitive(true))))
        val second=JsonObject(attachment()+mapOf("id" to JsonPrimitive("f2"),"name" to JsonPrimitive("second.txt")))
        val input=JsonObject(original+mapOf("message" to JsonPrimitive("Unsent editor"),"files" to JsonArray(listOf(attachment(),second))))
        val copy=store.recover(scope,"alice","op","copy",null,input,mapOf("f2" to "world".toByteArray()))
        assertEquals("op",copy["recoveredFrom"]?.jsonPrimitive?.content)
        assertEquals(false,copy["frozen"]?.jsonPrimitive?.boolean)
        assertEquals(frozen,store.get(scope,"op"))
        assertArrayEquals("hello".toByteArray(),store.attachment(scope,"copy","f1").second)
        assertArrayEquals("world".toByteArray(),store.attachment(scope,"copy","f2").second)
        store.remove(scope,"op",2)
        val updated=store.recover(scope,"alice","op","copy",1,JsonObject(input+("message" to JsonPrimitive("Later edit"))),emptyMap())
        assertArrayEquals("hello".toByteArray(),FirstSendDraftStore(File(parent,"drafts")).attachment(scope,"copy","f1").second)
        store.put(scope,"alice","copy",updated.getValue("revision").jsonPrimitive.long,JsonObject(updated+("message" to JsonPrimitive("Peer copy edit"))))
        refused {store.recover(scope,"alice","op","copy",2,input,emptyMap())}
        assertEquals("Peer copy edit",store.get(scope,"copy")!!["message"]?.jsonPrimitive?.content)
        refused {store.recover(scope,"alice","op","op",null,input,emptyMap())}
    }
    @Test fun recoveryRefusesMissingOrCorruptBytesWithoutPublishingAnIncompleteCopy() = fixture {parent,store,scope->
        val input=value(files=JsonArray(listOf(attachment())))
        refused {store.recover(scope,"alice","missing","copy",null,input,emptyMap())}
        assertNull(store.get(scope,"copy"))
        store.put(scope,"alice","op",null,input,mapOf("f1" to "hello".toByteArray()))
        parent.walkTopDown().first {it.name.startsWith("blob-")}.writeText("wrong")
        refused {store.recover(scope,"alice","op","copy",null,input,emptyMap())}
        assertNull(store.get(scope,"copy"))
    }

    @Test fun simultaneousRecoveryWritersCannotReplaceTheOtherCopyOrReadAnotherAccount() = fixture {parent,store,scope->
        val input=value(files=JsonArray(listOf(attachment())))
        store.put(scope,"alice","op",null,input,mapOf("f1" to "hello".toByteArray()))
        val executor=Executors.newFixedThreadPool(2)
        try {
            val winners=executor.invokeAll((1..2).map {n->Callable {
                try {FirstSendDraftStore(File(parent,"drafts")).recover(scope,"alice","op","copy",null,JsonObject(input+("message" to JsonPrimitive("Writer $n"))),emptyMap());true}
                catch(_:DraftWriteConflict){false}
            }}).map {it.get()}
            assertEquals(1,winners.count {it})
            assertArrayEquals("hello".toByteArray(),store.attachment(scope,"copy","f1").second)
            val bob=FirstSendDraftStore.scope("https://example.test","bob")
            refused {store.recover(bob,"bob","op","copy",null,input,emptyMap())}
            assertNull(store.get(bob,"copy"))
        } finally {executor.shutdownNow()}
    }

    @Test fun editorSnapshotSurvivesCleanupBeforeAnyRecoveryCopyExists() = fixture { parent, store, scope ->
        val original = store.put(scope, "alice", "op", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        val (snapshot, bytes) = store.openEditor(scope, "op")!!
        assertEquals(original, snapshot)
        store.remove(scope, "op", 1)
        assertFalse(parent.walkTopDown().any { it.name.startsWith("blob-") })
        val copy = store.recover(scope, "alice", "op", "copy", null, JsonObject(snapshot + ("message" to JsonPrimitive("Unsent"))), bytes)
        assertEquals("Unsent", copy["message"]?.jsonPrimitive?.content)
        assertNull(store.get(scope, "op"))
        assertArrayEquals("hello".toByteArray(), FirstSendDraftStore(File(parent, "drafts")).attachment(scope, "copy", "f1").second)
        assertNull(copy["preparation"])
        assertEquals(false, copy["prepareAttempted"]?.jsonPrimitive?.boolean)
    }
    @Test fun openingAnEditorAndCleaningItsSourceCannotReturnPartialOrMixedBytes() = fixture { parent, store, scope ->
        val executor = Executors.newFixedThreadPool(2)
        try {
            repeat(12) { n ->
                val id = "op$n"
                val original = store.put(scope, "alice", id, null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
                val start = java.util.concurrent.CountDownLatch(1)
                val reader = executor.submit(Callable { start.await(); FirstSendDraftStore(File(parent, "drafts")).openEditor(scope, id) })
                val cleaner = executor.submit(Callable { start.await(); store.remove(scope, id, 1) })
                start.countDown()
                val captured = reader.get(5, java.util.concurrent.TimeUnit.SECONDS)
                cleaner.get(5, java.util.concurrent.TimeUnit.SECONDS)
                if (captured != null) {
                    assertEquals(original, captured.first)
                    assertArrayEquals("hello".toByteArray(), captured.second.getValue("f1"))
                    store.recover(scope, "alice", id, "copy$n", null, captured.first, captured.second)
                    assertArrayEquals("hello".toByteArray(), store.attachment(scope, "copy$n", "f1").second)
                }
                assertNull(store.openEditor(scope, id))
            }
        } finally { executor.shutdownNow() }
    }
    @Test fun editorSnapshotsRefuseMissingCorruptAndCrossAccountFilesAndSkipFrozenInput() = fixture { parent, store, scope ->
        val row = store.put(scope, "alice", "op", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        assertNull(store.openEditor(FirstSendDraftStore.scope("https://example.test", "bob"), "op"))
        val blob = parent.walkTopDown().single { it.name.startsWith("blob-") }
        blob.writeText("wrong")
        refused { store.openEditor(scope, "op") }
        blob.delete()
        refused { store.openEditor(scope, "op") }
        assertEquals(row, store.get(scope, "op"))
        store.update(scope, "alice", "op") { JsonObject(it + ("frozen" to JsonPrimitive(true))) }
        assertTrue(store.openEditor(scope, "op")!!.second.isEmpty())
        assertEquals(1, store.list(scope).size)
    }
    @Test fun recoveryRejectsChangedBytesUnderAnOriginalAttachmentDigest() = fixture { _, store, scope ->
        val row = store.put(scope, "alice", "op", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        store.remove(scope, "op", 1)
        refused { store.recover(scope, "alice", "op", "copy", null, row, mapOf("f1" to "wrong".toByteArray())) }
        assertNull(store.get(scope, "copy"))
        assertNull(store.get(scope, "op"))
    }

    private fun cancelled(row: JsonObject) = JsonObject(row + mapOf(
        "frozen" to JsonPrimitive(true), "message" to JsonPrimitive(""), "files" to JsonArray(emptyList()),
        "preparation" to buildJsonObject { put("state", "cancelled") },
    ))
    @Test fun confirmedCancellationRemovesOnlyItsBytesAfterTheReceiptCommits() = fixture { parent, store, scope ->
        val original = store.put(scope, "alice", "op", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        store.recover(scope, "alice", "op", "kept-copy", null, original, emptyMap())
        val stopped = store.update(scope, "alice", "op") { JsonObject(it + mapOf(
            "frozen" to JsonPrimitive(true), "cancelRequested" to JsonPrimitive(true), "uncertain" to JsonPrimitive(true),
            "preparation" to buildJsonObject { put("state", "stopped") },
        )) }
        assertArrayEquals("hello".toByteArray(), store.attachment(scope, "op", "f1").second)
        refused { store.update(scope, "alice", "op") { JsonObject(cancelled(it) + ("message" to JsonPrimitive("x".repeat(1_000_001)))) } }
        assertEquals(stopped, store.get(scope, "op"))
        assertArrayEquals("hello".toByteArray(), store.attachment(scope, "op", "f1").second)
        store.update(scope, "alice", "op", ::cancelled)
        assertEquals(1, parent.walkTopDown().count { it.name.startsWith("blob-") })
        assertArrayEquals("hello".toByteArray(), store.attachment(scope, "kept-copy", "f1").second)
        refused { store.put(scope, "alice", "op", stopped.getValue("revision").jsonPrimitive.long, stopped) }
        assertEquals("", FirstSendDraftStore(File(parent, "drafts")).get(scope, "op")!!["message"]?.jsonPrimitive?.content)
    }
    @Test fun interruptedCancellationCleanupIsRepairedOnReopenWithoutFollowingSymlinks() = fixture { parent, store, scope ->
        store.put(scope, "alice", "op", null, value(files = JsonArray(listOf(attachment()))), mapOf("f1" to "hello".toByteArray()))
        val blob = parent.walkTopDown().single { it.name.startsWith("blob-") }
        val sentinel = File(parent, "keep.txt").apply { writeText("outside") }
        blob.delete()
        Files.createSymbolicLink(blob.toPath(), sentinel.toPath())
        refused { store.update(scope, "alice", "op", ::cancelled) }
        assertEquals("outside", sentinel.readText())
        val record = File(blob.parentFile, "record.json")
        val committed = record.readBytes()
        assertEquals("cancelled", PircJson.parseToJsonElement(String(committed)).jsonObject["record"]!!.jsonObject["preparation"]!!.jsonObject["state"]?.jsonPrimitive?.content)
        // Simulate the interrupted unlink after its committed receipt, then a fresh process.
        Files.delete(blob.toPath())
        blob.writeText("hello")
        val reopened = FirstSendDraftStore(File(parent, "drafts"))
        assertEquals("", reopened.get(scope, "op")!!["message"]?.jsonPrimitive?.content)
        assertFalse(blob.exists())
        assertArrayEquals(committed, record.readBytes())
        assertEquals("outside", sentinel.readText())
    }

}
