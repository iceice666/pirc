package dev.pirc.pirc_mobile

import org.junit.Assert.*
import org.junit.Test

class NativeDocumentStorageTest {
    @Test fun orderedMutationsProduceOnlyRealChangesAndKeepPerOperationUrl() {
        val store = NativeDocumentStorage()
        val origin = "HTTPS://Example.TEST:443"
        val session = "tab-a"
        val pageUrl = "https://example.test/document"
        val generation = store.snapshot(origin, session).long("generation")

        val changes = store.apply(
            origin = origin,
            sessionKey = session,
            url = pageUrl,
            expectedGeneration = generation,
            operations = listOf(
                operation("local", "set", "first", "1", generation, "https://example.test/first"),
                operation("local", "set", "second", "2", generation, "https://example.test/second"),
                operation("local", "set", "first", "updated", generation, "https://example.test/overwrite"),
                operation("local", "set", "first", "updated", generation), // Same value is a no-op.
                operation("local", "remove", "missing", generation = generation),
            ),
        )

        assertEquals("https://example.test", store.snapshot(origin, session)["origin"])
        assertEquals(10L * 1024L * 1024L, store.snapshot(origin, session)["quotaBytes"])
        assertEquals(5L * 1024L * 1024L, store.snapshot(origin, session)["quotaCodeUnits"])
        assertEquals(listOf(1L, 2L, 3L), changes.map { it.long("revision") })
        assertEquals(listOf("/first", "/second", "/overwrite"), changes.map { it.string("url").substringAfter("example.test") })
        assertEquals(null, changes[0]["oldValue"])
        assertEquals("1", changes[2]["oldValue"])
        assertEquals("updated", changes[2]["newValue"])
        assertEquals(
            listOf(listOf("first", "updated"), listOf("second", "2")),
            store.snapshot(origin, session).entries("local"),
        )

        val reorder = store.apply(
            origin,
            session,
            pageUrl,
            listOf(
                operation("local", "remove", "first", generation = generation),
                operation("local", "set", "first", "again", generation = generation),
            ),
            generation,
        )
        assertEquals(2, reorder.size)
        assertEquals(listOf(listOf("second", "2"), listOf("first", "again")), store.snapshot(origin, session).entries("local"))
    }

    @Test fun originAndSessionScopesAreIndependentAndLocalMutationCallbackIsScoped() {
        var localCallbacks = 0
        val store = NativeDocumentStorage(onLocalChanged = { localCallbacks++ })
        val origin = "https://one.example.test"
        val generation = store.snapshot(origin, "tab-a").long("generation")
        store.apply(
            origin,
            "tab-a",
            "$origin/page",
            listOf(
                operation("local", "set", "shared", "local", generation),
                operation("session", "set", "private", "tab-a", generation),
            ),
            generation,
        )

        assertEquals(listOf(listOf("shared", "local")), store.snapshot(origin, "tab-b").entries("local"))
        assertTrue(store.snapshot(origin, "tab-b").entries("session").isEmpty())
        assertTrue(store.snapshot("https://two.example.test", "tab-a").entries("local").isEmpty())
        assertTrue(store.snapshot("https://two.example.test", "tab-a").entries("session").isEmpty())
        assertEquals(1, localCallbacks)
    }

    @Test fun clearEmitsOneNullKeyChangeAndNoOpClearEmitsNothing() {
        var callbacks = 0
        val store = NativeDocumentStorage(onLocalChanged = { callbacks++ })
        val origin = "https://clear.example.test"
        val session = "tab"
        val generation = store.snapshot(origin, session).long("generation")
        val url = "$origin/path"
        store.apply(
            origin,
            session,
            url,
            listOf(operation("session", "set", "k", "v", generation)),
            generation,
        )

        val cleared = store.apply(
            origin,
            session,
            url,
            listOf(operation("session", "clear", generation = generation)),
            generation,
        )
        assertEquals(1, cleared.size)
        assertNull(cleared.single()["key"])
        assertNull(cleared.single()["oldValue"])
        assertNull(cleared.single()["newValue"])
        assertTrue(
            store.apply(
                origin,
                session,
                url,
                listOf(operation("session", "clear", generation = generation)),
                generation,
            ).isEmpty(),
        )
        assertEquals(0, callbacks)
    }

    @Test fun invalidOperationUrlFailsAfterEarlierMutationsAndPreservesTheirChanges() {
        val store = NativeDocumentStorage()
        val origin = "https://scope.example.test"
        val session = "tab"
        val generation = store.snapshot(origin, session).long("generation")
        val failure = assertThrows(InvalidStorageOperationException::class.java) {
            store.apply(
                origin,
                session,
                "$origin/base",
                listOf(
                    operation("local", "set", "accepted", "yes", generation, "$origin/path?q=1"),
                    operation("local", "set", "wrong-origin", "no", generation, "https://elsewhere.test/"),
                ),
                generation,
            )
        }
        assertEquals(1, failure.failedOperationIndex)
        assertEquals("$origin/path?q=1", failure.committedChanges.single()["url"])
        assertEquals(listOf(listOf("accepted", "yes")), store.snapshot(origin, session).entries("local"))
    }

    @Test fun missingGenerationMalformedOperationsAndRetiredOwnersFailVisibly() {
        val store = NativeDocumentStorage()
        val origin = "https://strict.example.test"
        val session = "tab"
        val generation = store.snapshot(origin, session).long("generation")
        val failure = assertThrows(InvalidStorageOperationException::class.java) {
            store.apply(
                origin,
                session,
                "$origin/base",
                listOf(
                    operation("local", "set", "committed", "yes", generation),
                    operation("local", "set", "missing-generation", "no"),
                ),
                generation,
            )
        }
        assertEquals(1, failure.failedOperationIndex)
        assertEquals(listOf(listOf("committed", "yes")), store.snapshot(origin, session).entries("local"))
        val staleFailure = assertThrows(StaleStorageGenerationException::class.java) {
            store.apply(
                origin,
                session,
                "$origin/base",
                listOf(
                    operation("local", "set", "before-stale", "yes", generation),
                    operation("local", "set", "stale-op", "no", generation + 1),
                ),
                generation,
            )
        }
        assertEquals(1, staleFailure.failedOperationIndex)
        assertEquals(1, staleFailure.committedChanges.size)
        assertThrows(StaleStorageGenerationException::class.java) {
            store.apply(origin, session, "$origin/base", emptyList(), generation + 1)
        }

        store.retire()
        assertThrows(StaleStorageGenerationException::class.java) {
            store.apply(
                origin,
                session,
                "$origin/base",
                listOf(operation("local", "set", "late", "no", generation)),
                generation,
            )
        }
        assertThrows(IllegalStateException::class.java) { store.snapshot(origin, session) }
    }

    @Test fun blobDocumentsUseInheritedTupleOriginAndRetainBlobEventUrl() {
        val store = NativeDocumentStorage()
        val origin = "http://127.0.0.1:8123"
        val session = "blob-tab"
        val blobUrl = "blob:http://127.0.0.1:8123/550e8400-e29b-41d4-a716-446655440000"
        val generation = store.snapshot(origin, session).long("generation")
        val changes = store.apply(
            origin,
            session,
            blobUrl,
            listOf(operation("local", "set", "from-blob", "works", generation, blobUrl)),
            generation,
        )

        assertEquals(blobUrl, changes.single()["url"])
        assertEquals(listOf(listOf("from-blob", "works")), store.snapshot(origin, session).entries("local"))
        assertThrows(IllegalArgumentException::class.java) {
            store.apply(
                "null",
                session,
                "blob:null/opaque-id",
                listOf(operation("local", "set", "opaque", "no", generation)),
                generation,
            )
        }
    }

    @Test fun perAreaQuotaUsesUtf16BytesAndRejectsOnlyTheOverflowingOperation() {
        var callbacks = 0
        val store = NativeDocumentStorage(onLocalChanged = { callbacks++ })
        val origin = "https://quota.example.test"
        val session = "tab"
        val generation = store.snapshot(origin, session).long("generation")
        val exact = "😀".repeat(AREA_QUOTA_CODE_UNITS.toInt() / 2)
        assertEquals(AREA_QUOTA_CODE_UNITS.toInt(), exact.length)

        val exception = try {
            store.apply(
                origin,
                session,
                "$origin/path",
                listOf(
                    operation("local", "set", "", exact, generation),
                    operation("local", "set", "x", "", generation),
                ),
                generation,
            )
            fail("Expected the second operation to exceed the origin quota")
            null
        } catch (quota: StorageQuotaExceededException) {
            quota
        }

        val actualException = requireNotNull(exception)
        assertEquals("area", actualException.quotaScope)
        assertEquals(1, actualException.failedOperationIndex)
        assertEquals(1, actualException.committedChanges.size)
        assertEquals(1, callbacks)
        assertEquals(listOf(listOf("", exact)), store.snapshot(origin, session).entries("local"))
    }

    @Test fun accountQuotaCoversEveryOriginAndStorageArea() {
        val store = NativeDocumentStorage()
        val session = "tab"
        val generation = store.snapshot("https://quota-0.example.test", session).long("generation")
        val tenMiB = "x".repeat(AREA_QUOTA_CODE_UNITS.toInt())
        repeat(6) { index ->
            val origin = "https://quota-$index.example.test"
            val applied = store.apply(
                origin,
                session,
                "$origin/path",
                listOf(operation("local", "set", "", tenMiB, generation)),
                generation,
            )
            assertEquals(1, applied.size)
        }

        val seventhOrigin = "https://quota-6.example.test"
        val exception = try {
            store.apply(
                seventhOrigin,
                session,
                "$seventhOrigin/path",
                listOf(operation("session", "set", "", "y".repeat(AREA_QUOTA_CODE_UNITS.toInt() / 2), generation)),
                generation,
            )
            fail("Expected the account-wide quota to reject the operation")
            null
        } catch (quota: StorageQuotaExceededException) {
            quota
        }

        val actualException = requireNotNull(exception)
        assertEquals("account", actualException.quotaScope)
        assertTrue(store.snapshot(seventhOrigin, session).entries("session").isEmpty())

        assertEquals(
            1,
            store.apply(
                "https://quota-0.example.test",
                session,
                "https://quota-0.example.test/page",
                listOf(operation("local", "remove", "", generation = generation)),
                generation,
            ).size,
        )
        assertEquals(
            1,
            store.apply(
                seventhOrigin,
                session,
                "$seventhOrigin/page",
                listOf(operation("session", "set", "", "y".repeat(AREA_QUOTA_CODE_UNITS.toInt() / 2), generation)),
                generation,
            ).size,
        )
    }

    @Test fun sessionCloneCopiesEveryOriginOnceAndDoesNotPersistOrOverwriteAnOpenedTarget() {
        var localCallbacks = 0
        val store = NativeDocumentStorage(onLocalChanged = { localCallbacks++ })
        val source = "source-tab"
        val target = "opened-tab"
        val firstOrigin = "https://first.example.test"
        val secondOrigin = "https://second.example.test"
        val generation = store.snapshot(firstOrigin, source).long("generation")
        store.apply(
            firstOrigin,
            source,
            "$firstOrigin/page",
            listOf(operation("session", "set", "first", "one", generation)),
            generation,
        )
        store.apply(
            secondOrigin,
            source,
            "$secondOrigin/page",
            listOf(operation("session", "set", "second", "two", generation)),
            generation,
        )

        store.cloneSession(source, target)
        assertEquals(listOf(listOf("first", "one")), store.snapshot(firstOrigin, target).entries("session"))
        assertEquals(listOf(listOf("second", "two")), store.snapshot(secondOrigin, target).entries("session"))
        assertTrue(store.exportLocalPersistence().isEmpty())

        store.apply(
            firstOrigin,
            target,
            "$firstOrigin/page",
            listOf(operation("session", "set", "target-only", "kept", generation)),
            generation,
        )
        store.cloneSession(source, target)
        assertEquals(
            listOf(listOf("first", "one"), listOf("target-only", "kept")),
            store.snapshot(firstOrigin, target).entries("session"),
        )
        store.removeSession(target)
        assertTrue(store.snapshot(firstOrigin, target).entries("session").isEmpty())
        assertEquals(listOf(listOf("first", "one")), store.snapshot(firstOrigin, source).entries("session"))
        assertEquals(0, localCallbacks)
    }

    @Test fun emptySessionCloneIsAlsoOneShot() {
        val store = NativeDocumentStorage()
        val source = "initially-empty"
        val target = "opened-while-empty"
        val origin = "https://empty-clone.example.test"
        val generation = store.snapshot(origin, source).long("generation")
        store.cloneSession(source, target)
        store.apply(
            origin,
            source,
            "$origin/page",
            listOf(operation("session", "set", "later", "source-only", generation)),
            generation,
        )
        store.cloneSession(source, target)

        assertTrue(store.snapshot(origin, target).entries("session").isEmpty())
        assertEquals(listOf(listOf("later", "source-only")), store.snapshot(origin, source).entries("session"))
    }

    @Test fun persistenceRoundTripContainsLocalOnlyAndImportDoesNotTriggerPersistence() {
        var callbacks = 0
        val source = NativeDocumentStorage(onLocalChanged = { callbacks++ })
        val origin = "https://persist.example.test"
        val session = "source-tab"
        val generation = source.snapshot(origin, session).long("generation")
        source.apply(
            origin,
            session,
            "$origin/path",
            listOf(
                operation("local", "set", "persisted", "yes", generation),
                operation("session", "set", "ephemeral", "no", generation),
            ),
            generation,
        )
        val records = source.exportLocalPersistence()
        assertEquals(1, callbacks)
        assertEquals(listOf(mapOf("origin" to origin, "entries" to listOf(listOf("persisted", "yes")))), records)

        var importedCallbacks = 0
        val restored = NativeDocumentStorage(onLocalChanged = { importedCallbacks++ })
        assertEquals(1, restored.importLocalPersistence(records))
        assertEquals(listOf(listOf("persisted", "yes")), restored.snapshot(origin, "new-tab").entries("local"))
        assertTrue(restored.snapshot(origin, "new-tab").entries("session").isEmpty())
        assertEquals(0, importedCallbacks)
        assertEquals(0, restored.importLocalPersistence(listOf(mapOf("origin" to "file:///tmp", "entries" to emptyList<List<String>>()))))
    }

    @Test fun retiredOwnerRejectsLateWritesAndDoesNotShareStateWithNewGeneration() {
        val oldStore = NativeDocumentStorage()
        val newStore = NativeDocumentStorage()
        val origin = "https://retired.example.test"
        val session = "tab"
        val oldGeneration = oldStore.snapshot(origin, session).long("generation")
        val newGeneration = newStore.snapshot(origin, session).long("generation")
        assertNotEquals(oldGeneration, newGeneration)

        oldStore.apply(
            origin,
            session,
            "$origin/page",
            listOf(operation("local", "set", "old", "value", oldGeneration)),
            oldGeneration,
        )
        oldStore.retire()
        assertThrows(StaleStorageGenerationException::class.java) {
            oldStore.apply(
                origin,
                session,
                "$origin/page",
                listOf(operation("local", "set", "late", "write", oldGeneration)),
                oldGeneration,
            )
        }
        assertThrows(IllegalStateException::class.java) { oldStore.snapshot(origin, session) }
        assertTrue(newStore.snapshot(origin, session).entries("local").isEmpty())
    }

    @Test fun invalidOriginsAndSessionKeysCannotCreateStorageNamespaces() {
        val store = NativeDocumentStorage()
        assertThrows(IllegalArgumentException::class.java) { store.snapshot("file:///tmp/site", "tab") }
        assertThrows(IllegalArgumentException::class.java) { store.snapshot("https://example.test/path", "tab") }
        assertThrows(IllegalArgumentException::class.java) { store.snapshot("https://example.test", "") }
        assertThrows(IllegalArgumentException::class.java) {
            store.apply(
                "https://example.test/path",
                "tab",
                "https://example.test/page",
                listOf(operation("local", "set", "x", "y")),
                store.generation,
            )
        }
        assertTrue(store.exportLocalPersistence().isEmpty())
    }

    @Test fun perAreaEntryBoundStopsNewKeysButAllowsOverwrites() {
        val store = NativeDocumentStorage()
        val origin = "https://entries.example.test"
        val session = "tab"
        val generation = store.snapshot(origin, session).long("generation")
        var next = 0
        while (next < MAX_ENTRIES_PER_AREA) {
            val end = minOf(next + 250, MAX_ENTRIES_PER_AREA)
            val batch = (next until end).map { index ->
                operation("local", "set", "k$index", "v", generation)
            }
            assertEquals(batch.size, store.apply(origin, session, "$origin/page", batch, generation).size)
            next = end
        }

        assertEquals(1, store.apply(
            origin,
            session,
            "$origin/page",
            listOf(operation("local", "set", "k0", "changed", generation)),
            generation,
        ).size)
        val failure = assertThrows(StorageQuotaExceededException::class.java) {
            store.apply(
                origin,
                session,
                "$origin/page",
                listOf(operation("local", "set", "overflow", "v", generation)),
                generation,
            )
        }
        assertEquals("area-entry-count", failure.quotaScope)
        assertEquals("entries", failure.quotaUnit)
        assertEquals(MAX_ENTRIES_PER_AREA.toLong(), failure.quotaLimit)
        assertEquals((MAX_ENTRIES_PER_AREA + 1).toLong(), failure.attemptedQuotaUnits)
        assertEquals(MAX_ENTRIES_PER_AREA, store.snapshot(origin, session).entries("local").size)
    }

    @Test fun nonemptyOriginAndSessionAreaCountsHaveExplicitBounds() {
        val store = NativeDocumentStorage()
        val localSession = "local-tab"
        val generation = store.snapshot("https://origin-0.example.test", localSession).long("generation")

        repeat(MAX_LOCAL_ORIGINS) { index ->
            val origin = "https://origin-$index.example.test"
            assertEquals(
                1,
                store.apply(
                    origin,
                    localSession,
                    "$origin/page",
                    listOf(operation("local", "set", "", "", generation)),
                    generation,
                ).size,
            )
        }
        val overflowOrigin = "https://origin-overflow.example.test"
        val localFailure = try {
            store.apply(
                overflowOrigin,
                localSession,
                "$overflowOrigin/page",
                listOf(operation("local", "set", "", "", generation)),
                generation,
            )
            fail("Expected the local origin count cap to reject the operation")
            null
        } catch (quota: StorageQuotaExceededException) {
            quota
        }
        val actualLocalFailure = requireNotNull(localFailure)
        assertEquals("local-origin-count", actualLocalFailure.quotaScope)
        assertEquals("areas", actualLocalFailure.quotaUnit)
        assertTrue(store.snapshot(overflowOrigin, localSession).entries("local").isEmpty())

        val sessionOrigin = "https://session-area.example.test"
        repeat(MAX_SESSION_AREAS) { index ->
            assertEquals(
                1,
                store.apply(
                    sessionOrigin,
                    "session-$index",
                    "$sessionOrigin/page",
                    listOf(operation("session", "set", "", "", generation)),
                    generation,
                ).size,
            )
        }
        val sessionFailure = try {
            store.apply(
                sessionOrigin,
                "session-overflow",
                "$sessionOrigin/page",
                listOf(operation("session", "set", "", "", generation)),
                generation,
            )
            fail("Expected the session area count cap to reject the operation")
            null
        } catch (quota: StorageQuotaExceededException) {
            quota
        }
        val actualSessionFailure = requireNotNull(sessionFailure)
        assertEquals("session-area-count", actualSessionFailure.quotaScope)
        assertEquals("areas", actualSessionFailure.quotaUnit)
        assertTrue(store.snapshot(sessionOrigin, "session-overflow").entries("session").isEmpty())
    }

    private fun operation(
        area: String,
        type: String,
        key: String? = null,
        value: String? = null,
        generation: Long? = null,
        url: String? = null,
    ): Map<String, Any?> = buildMap {
        put("area", area)
        put("type", type)
        if (key != null) put("key", key)
        if (value != null) put("value", value)
        if (generation != null) put("generation", generation)
        if (url != null) put("url", url)
    }

    private fun Map<String, Any?>.entries(area: String): List<List<String>> =
        this[area] as List<List<String>>

    private fun Map<String, Any?>.long(key: String): Long = this[key] as Long
    private fun Map<String, Any?>.string(key: String): String = this[key] as String

    companion object {
        private const val AREA_QUOTA_CODE_UNITS = 5L * 1024L * 1024L
        private const val MAX_ENTRIES_PER_AREA = 50_000
        private const val MAX_LOCAL_ORIGINS = 256
        private const val MAX_SESSION_AREAS = 1024
    }
}
