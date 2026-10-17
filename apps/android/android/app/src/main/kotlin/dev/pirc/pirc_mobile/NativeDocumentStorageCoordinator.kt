package dev.pirc.pirc_mobile

/** Called under GatewayRuntime's account lock. Notifications carry no storage values. */
internal class NativeDocumentStorageCoordinator(
    private val bindStore: (String?) -> NativeDocumentStorage,
    private val persistenceError: () -> String?,
    private val notify: (Map<String, Any?>) -> Unit,
) {
    constructor(store: NativeDocumentStorageStore, notify: (Map<String, Any?>) -> Unit) :
        this(store::bind, { store.persistenceError }, notify)

    private data class Reader(
        val principal: NativeDocumentScripts.ResourcePrincipal,
        val origin: String,
        val sessionKey: String,
        val events: MutableList<Map<String, Any?>> = mutableListOf(),
        var eventBytes: Long = 0L,
        var eventError: String? = null,
    )
    private val readers = mutableMapOf<String, Reader>()
    private val initializedSessions = mutableSetOf<String>()
    private val closedSessions = mutableSetOf<String>()
    private var generation: Long? = null
    private var currentStorage: NativeDocumentStorage? = null

    @Synchronized
    fun bind(stamp: String?): NativeDocumentStorage {
        val storage = bindStore(stamp)
        currentStorage = storage
        if (generation != storage.generation) {
            generation = storage.generation
            readers.clear()
            initializedSessions.clear()
            closedSessions.clear()
        }
        return storage
    }

    @Synchronized
    fun openWindow(stamp: String?, key: String, openerKey: String?) {
        validateKey(key)
        if (openerKey != null) validateKey(openerKey)
        val storage = bind(stamp)
        check(key !in closedSessions) { "The storage window is closed" }
        if (key in initializedSessions) return
        if (openerKey != null) {
            check(openerKey !in closedSessions) { "The storage opener is closed" }
            storage.cloneSession(openerKey, key)
        }
        initializedSessions += key
    }

    @Synchronized
    fun closeWindow(stamp: String?, key: String) {
        validateKey(key)
        val storage = bind(stamp)
        closedSessions += key
        initializedSessions -= key
        storage.removeSession(key)
        readers.entries.removeAll { it.value.sessionKey == key }
    }

    @Synchronized
    fun closeReader(owner: String, contextId: String?) {
        val reader = readers[owner] ?: return
        if (reader.principal.contextId != (contextId ?: ContextRegistry.PRIMARY_CONTEXT_ID)) return
        readers.remove(owner)
        if (reader.sessionKey == owner && readers.values.none { it.sessionKey == owner }) {
            currentStorage?.removeSession(owner)
            initializedSessions -= owner
        }
    }

    @Synchronized
    fun state(
        principal: NativeDocumentScripts.ResourcePrincipal,
        documentUrl: String,
        operations: List<Map<*, *>>,
        knownRevision: Long?,
        expectedGeneration: Long?,
    ): Map<String, Any?> {
        val owner = requireNotNull(principal.scriptOwner) { "Storage document owner is missing" }
        val key = requireNotNull(principal.storageSessionKey) { "Storage window is missing" }
        validateKey(key)
        val origin = storageOrigin(documentUrl)
        require(origin != "null" && origin == principal.documentOrigin) { "Storage requires the owning HTTP origin" }
        val storage = bind(principal.pairingStamp)
        check(key !in closedSessions) { "The storage window is closed" }
        if (expectedGeneration != null) check(expectedGeneration == storage.generation) { "Browser storage account changed" }
        val existing = readers[owner]
        check(existing == null || existing.principal == principal) { "Storage document owner changed" }
        val reader = existing ?: Reader(principal, origin, key).also { readers[owner] = it }
        initializedSessions += key
        require(operations.size <= 256) { "Too many browser storage operations" }
        var failure: String? = null
        for (operation in operations) {
            val operationUrl = operation["url"] as? String ?: documentUrl
            require(storageOrigin(operationUrl) == origin) { "Storage write origin changed" }
            val operationGeneration = (operation["generation"] as? Number)?.toLong()
                ?: throw IllegalArgumentException("Storage write generation is required")
            try {
                // Earlier accepted operations retain their events if a later operation fails.
                val changes = storage.apply(origin, key, operationUrl, listOf(operation), operationGeneration)
                for (change in changes) broadcast(owner, change, storage.generation)
            } catch (error: StorageQuotaExceededException) {
                failure = error.message ?: "Browser storage quota exceeded"
                break
            }
        }
        val snapshot = storage.snapshot(origin, key)
        val events = reader.events.toList()
        reader.events.clear()
        reader.eventBytes = 0
        val error = failure ?: reader.eventError ?: persistenceError()
        return mapOf(
            "generation" to storage.generation,
            "revision" to snapshot["revision"],
            "changed" to (knownRevision == null || snapshot["revision"] != knownRevision),
            "state" to snapshot.takeIf { knownRevision == null || it["revision"] != knownRevision },
            "events" to events,
            "error" to error,
        )
    }

    @Synchronized
    fun closeReadersForContext(contextId: String) {
        val keys = readers.values.filter { it.principal.contextId == contextId }.map { it.sessionKey }.toSet()
        readers.entries.removeAll { it.value.principal.contextId == contextId }
        for (key in keys) if (readers.values.none { it.sessionKey == key }) {
            currentStorage?.removeSession(key)
            initializedSessions -= key
            closedSessions += key
        }
    }

    @Synchronized
    fun closeAllReaders() {
        for (key in initializedSessions) {
            currentStorage?.removeSession(key)
            closedSessions += key
        }
        readers.clear()
        initializedSessions.clear()
    }

    private fun broadcast(sourceOwner: String, change: Map<String, Any?>, generation: Long) {
        for ((owner, reader) in readers) {
            if (owner == sourceOwner || reader.origin != change["origin"]) continue
            if (change["area"] == "session" && reader.sessionKey != change["sessionKey"]) continue
            val bytes = listOf("key", "oldValue", "newValue", "url").sumOf {
                (change[it] as? String)?.length?.toLong()?.times(2) ?: 0L
            }
            if (reader.events.size >= 256 || reader.eventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
                reader.events.clear()
                reader.eventBytes = 0
                reader.eventError = "Too many pending browser storage events; reload this document."
            } else if (reader.eventError == null) {
                reader.events += change
                reader.eventBytes += bytes
            }
            notify(mapOf("targetOwner" to owner, "generation" to generation,
                "origin" to reader.origin, "revision" to change["revision"]))
        }
    }

    private fun storageOrigin(url: String): String =
        if (url.startsWith("blob:", ignoreCase = true)) NativeScriptResourceTransport.originForBlobUrl(url)
        else NativeScriptResourceTransport.originForDocument(url)

    private fun validateKey(key: String) {
        require(key.isNotBlank() && key.length <= 256 && key.none { it.code < 0x20 || it.code == 0x7f }) {
            "Invalid storage window key"
        }
    }

    companion object { private const val MAX_PENDING_EVENT_BYTES = 32L * 1024L * 1024L }
}
