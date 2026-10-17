package dev.pirc.pirc_mobile

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.LinkedHashMap
import java.util.concurrent.atomic.AtomicLong

/** Quota failure includes mutations committed by earlier operations in the same batch. */
internal class StorageQuotaExceededException(
    val area: String,
    val quotaScope: String,
    val quotaBytes: Long,
    val quotaUnit: String = "bytes",
    val attemptedAreaBytes: Long,
    val attemptedAccountBytes: Long,
    val failedOperationIndex: Int,
    val committedChanges: List<Map<String, Any?>> = emptyList(),
    val quotaLimit: Long = quotaBytes,
    val attemptedQuotaUnits: Long = attemptedAreaBytes,
) : IllegalStateException(
    "Web Storage $quotaScope quota exceeded for $area " +
        "(limit $quotaLimit $quotaUnit, attempted $attemptedQuotaUnits $quotaUnit, " +
        "$attemptedAccountBytes account bytes)",
)

internal class InvalidStorageOperationException(
    val failedOperationIndex: Int,
    val committedChanges: List<Map<String, Any?>>,
    message: String,
) : IllegalArgumentException(message)

internal class StaleStorageGenerationException(
    message: String,
    val failedOperationIndex: Int,
    val committedChanges: List<Map<String, Any?>>,
) : IllegalStateException(message)

/**
 * Pure in-memory Web Storage for native documents. Local storage is partitioned by canonical
 * HTTP(S) origin; session storage is partitioned by both origin and native document session key.
 *
 * A single instance belongs to one account scope. Retire it before replacing that scope so late
 * JavaScript bridge calls cannot mutate a newer instance.
 */
internal class NativeDocumentStorage(
    private val onLocalChanged: () -> Unit = {},
) {
    // LinkedHashMap keeps native snapshots and JS updates consistent. Chrome 155 enumerated
    // alpha/beta/gamma as gamma/alpha/beta, so browser key order remains a documented gap.
    private val lock = Any()
    private val localAreas = LinkedHashMap<String, LinkedHashMap<String, String>>()
    private val sessionAreas = LinkedHashMap<String, LinkedHashMap<String, LinkedHashMap<String, String>>>()
    private val localByteCounts = LinkedHashMap<String, Long>()
    private val sessionByteCounts = LinkedHashMap<String, LinkedHashMap<String, Long>>()
    private val clonedSessionTargets = mutableSetOf<String>()

    val generation: Long = NEXT_GENERATION.getAndIncrement()
    private var revision = 0L
    private var accountByteCount = 0L
    private var retired = false

    /**
     * Return a complete, ordered snapshot for one origin and session. `origin` must be an HTTP(S)
     * origin with no path, query, fragment or credentials. Invalid scopes throw.
     */
    fun snapshot(origin: String, sessionKey: String): Map<String, Any?> {
        val canonicalOrigin = requireOrigin(origin)
        requireSessionKey(sessionKey)
        return synchronized(lock) {
            check(!retired) { "Browser storage owner has been retired" }
            val local = localAreas[canonicalOrigin]
            val session = sessionAreas[sessionKey]?.get(canonicalOrigin)
            linkedMapOf(
                "generation" to generation,
                "revision" to revision,
                "origin" to canonicalOrigin,
                "sessionKey" to sessionKey,
                "quotaBytes" to AREA_QUOTA_BYTES,
                "quotaCodeUnits" to AREA_QUOTA_CODE_UNITS,
                "quotaEntries" to MAX_ENTRIES_PER_AREA,
                "local" to entriesSnapshot(local),
                "session" to entriesSnapshot(session),
            )
        }
    }

    /**
     * Apply ordered bridge operations. Invalid scopes, a retired instance, stale generations, and
     * malformed operations fail visibly. A quota or operation failure stops the batch after the
     * failed operation; earlier operations remain committed and appear on the exception.
     */
    fun apply(
        origin: String,
        sessionKey: String,
        url: String,
        operations: List<Map<*, *>>,
        expectedGeneration: Long,
    ): List<Map<String, Any?>> {
        val canonicalOrigin = requireOrigin(origin)
        requireSessionKey(sessionKey)
        val pageUrl = parseDocumentUrl(url)
            ?: throw IllegalArgumentException("Invalid HTTP(S) or inherited blob document URL")
        require(pageUrl.origin == canonicalOrigin) { "Document URL does not belong to the storage origin" }

        val outcome = synchronized(lock) {
            if (retired) {
                return@synchronized ApplyOutcome(emptyList(), false, null,
                    ApplyFailure(-1, "Browser storage owner has been retired", stale = true))
            }
            if (expectedGeneration != generation) {
                return@synchronized ApplyOutcome(emptyList(), false, null,
                    ApplyFailure(-1, "Browser storage generation is stale", stale = true))
            }

            val changes = mutableListOf<Map<String, Any?>>()
            var changedLocal = false
            var quotaFailure: QuotaFailure? = null
            var operationFailure: ApplyFailure? = null

            for ((index, rawOperation) in operations.withIndex()) {
                val operation = parseOperation(rawOperation)
                if (operation == null) {
                    operationFailure = ApplyFailure(index, "Invalid browser storage operation", stale = false)
                    break
                }
                if (operation.generation != expectedGeneration) {
                    operationFailure = ApplyFailure(index, "Browser storage operation generation is stale", stale = true)
                    break
                }
                val operationUrl = operation.url ?: pageUrl
                if (operationUrl.origin != canonicalOrigin) {
                    operationFailure = ApplyFailure(index, "Browser storage operation URL changed origin", stale = false)
                    break
                }
                val area = currentArea(operation.area, canonicalOrigin, sessionKey)
                when (operation.type) {
                    "set" -> {
                        val key = requireNotNull(operation.key)
                        val value = requireNotNull(operation.value)
                        val oldExists = area?.containsKey(key) == true
                        val oldValue = area?.get(key)
                        if (oldExists && oldValue == value) continue

                        val oldBytes = if (oldExists) itemBytes(key, oldValue!!) else 0L
                        val newItemBytes = itemBytes(key, value)
                        val attemptedAreaBytes = safeAdd(areaBytesLocked(operation.area, canonicalOrigin, sessionKey) - oldBytes, newItemBytes)
                        val attemptedAccountBytes = safeAdd(accountByteCount - oldBytes, newItemBytes)
                        val newArea = area == null
                        val entryLimit = if (!oldExists && (area?.size ?: 0) >= MAX_ENTRIES_PER_AREA) {
                            Triple(MAX_ENTRIES_PER_AREA.toLong(), "area-entry-count", (area?.size?.plus(1) ?: 1).toLong())
                        } else null
                        val areaCountLimit = when {
                            newArea && operation.area == LOCAL_AREA && !localAreas.containsKey(canonicalOrigin) &&
                                localAreas.size >= MAX_LOCAL_ORIGINS ->
                                Triple(MAX_LOCAL_ORIGINS.toLong(), "local-origin-count", (localAreas.size + 1).toLong())
                            newArea && operation.area == SESSION_AREA &&
                                sessionAreaCountLocked() >= MAX_SESSION_AREAS ->
                                Triple(MAX_SESSION_AREAS.toLong(), "session-area-count", (sessionAreaCountLocked() + 1).toLong())
                            else -> null
                        }
                        val failureLimit = when {
                            entryLimit != null -> entryLimit
                            areaCountLimit != null -> areaCountLimit
                            attemptedAreaBytes > AREA_QUOTA_BYTES -> Triple(AREA_QUOTA_BYTES, "area", attemptedAreaBytes)
                            attemptedAccountBytes > ACCOUNT_QUOTA_BYTES -> Triple(ACCOUNT_QUOTA_BYTES, "account", attemptedAccountBytes)
                            else -> null
                        }
                        if (failureLimit != null) {
                            quotaFailure = QuotaFailure(
                                area = operation.area,
                                quotaBytes = if (failureLimit.second == "area-entry-count") AREA_QUOTA_BYTES else failureLimit.first,
                                quotaLimit = failureLimit.first,
                                quotaUnit = when (failureLimit.second) {
                                    "area-entry-count" -> "entries"
                                    "local-origin-count", "session-area-count" -> "areas"
                                    else -> "bytes"
                                },
                                quotaScope = failureLimit.second,
                                attemptedAreaBytes = attemptedAreaBytes,
                                attemptedAccountBytes = attemptedAccountBytes,
                                attemptedQuotaUnits = failureLimit.third,
                                failedOperationIndex = index,
                            )
                            break
                        }

                        areaForMutation(operation.area, canonicalOrigin, sessionKey)[key] = value
                        setAreaBytesLocked(operation.area, canonicalOrigin, sessionKey, attemptedAreaBytes)
                        accountByteCount = attemptedAccountBytes
                        revision++
                        changes += changeRecord(
                            area = operation.area,
                            origin = canonicalOrigin,
                            sessionKey = sessionKey,
                            key = key,
                            oldValue = oldValue,
                            newValue = value,
                            url = operationUrl.serialized,
                        )
                        if (operation.area == LOCAL_AREA) changedLocal = true
                    }

                    "remove" -> {
                        val key = requireNotNull(operation.key)
                        if (area?.containsKey(key) != true) continue
                        val oldValue = area.remove(key) ?: ""
                        val remainingAreaBytes = areaBytesLocked(operation.area, canonicalOrigin, sessionKey) - itemBytes(key, oldValue)
                        setAreaBytesLocked(operation.area, canonicalOrigin, sessionKey, remainingAreaBytes)
                        accountByteCount -= itemBytes(key, oldValue)
                        removeEmptyArea(operation.area, canonicalOrigin, sessionKey, area)
                        revision++
                        changes += changeRecord(
                            area = operation.area,
                            origin = canonicalOrigin,
                            sessionKey = sessionKey,
                            key = key,
                            oldValue = oldValue,
                            newValue = null,
                            url = operationUrl.serialized,
                        )
                        if (operation.area == LOCAL_AREA) changedLocal = true
                    }

                    "clear" -> {
                        if (area.isNullOrEmpty()) continue
                        val removedBytes = areaBytesLocked(operation.area, canonicalOrigin, sessionKey)
                        area.clear()
                        setAreaBytesLocked(operation.area, canonicalOrigin, sessionKey, 0L)
                        accountByteCount -= removedBytes
                        removeEmptyArea(operation.area, canonicalOrigin, sessionKey, area)
                        revision++
                        changes += changeRecord(
                            area = operation.area,
                            origin = canonicalOrigin,
                            sessionKey = sessionKey,
                            key = null,
                            oldValue = null,
                            newValue = null,
                            url = operationUrl.serialized,
                        )
                        if (operation.area == LOCAL_AREA) changedLocal = true
                    }
                }
            }
            ApplyOutcome(changes, changedLocal, quotaFailure, operationFailure)
        }

        notifyLocalChanged(outcome.changedLocal)
        outcome.quotaFailure?.let { failure ->
            throw StorageQuotaExceededException(
                area = failure.area,
                quotaScope = failure.quotaScope,
                quotaBytes = failure.quotaBytes,
                quotaUnit = failure.quotaUnit,
                attemptedAreaBytes = failure.attemptedAreaBytes,
                attemptedAccountBytes = failure.attemptedAccountBytes,
                failedOperationIndex = failure.failedOperationIndex,
                committedChanges = outcome.changes.toList(),
                quotaLimit = failure.quotaLimit,
                attemptedQuotaUnits = failure.attemptedQuotaUnits,
            )
        }
        outcome.operationFailure?.let { failure ->
            val committed = outcome.changes.toList()
            if (failure.stale) {
                throw StaleStorageGenerationException(failure.message, failure.operationIndex, committed)
            }
            throw InvalidStorageOperationException(failure.operationIndex, committed, failure.message)
        }
        return outcome.changes
    }

    /** Copy every origin's session area into `toSessionKey`, preserving each key's order. */
    fun cloneSession(fromSessionKey: String, toSessionKey: String) {
        requireSessionKey(fromSessionKey)
        requireSessionKey(toSessionKey)

        synchronized(lock) {
            check(!retired) { "Browser storage owner has been retired" }
            if (fromSessionKey == toSessionKey) return@synchronized
            if (toSessionKey in clonedSessionTargets) return@synchronized
            if (sessionAreas.containsKey(toSessionKey)) {
                clonedSessionTargets += toSessionKey
                return@synchronized
            }
            val source = sessionAreas[fromSessionKey].orEmpty()
            if (source.isEmpty()) {
                clonedSessionTargets += toSessionKey
                return@synchronized
            }

            val attemptedAreaCount = sessionAreaCountLocked() + source.size
            if (attemptedAreaCount > MAX_SESSION_AREAS) {
                throw StorageQuotaExceededException(
                    area = SESSION_AREA,
                    quotaScope = "session-area-count",
                    quotaBytes = MAX_SESSION_AREAS.toLong(),
                    quotaUnit = "areas",
                    attemptedAreaBytes = sessionBytes(source),
                    attemptedAccountBytes = totalBytesLocked(),
                    failedOperationIndex = -1,
                    quotaLimit = MAX_SESSION_AREAS.toLong(),
                    attemptedQuotaUnits = attemptedAreaCount.toLong(),
                )
            }

            val beforeBytes = totalBytesLocked()
            val sourceBytes = sessionBytes(source)
            val attemptedBytes = safeAdd(beforeBytes, sourceBytes)
            if (attemptedBytes > ACCOUNT_QUOTA_BYTES) {
                throw StorageQuotaExceededException(
                    area = SESSION_AREA,
                    quotaScope = "account",
                    quotaBytes = ACCOUNT_QUOTA_BYTES,
                    attemptedAreaBytes = sourceBytes,
                    attemptedAccountBytes = attemptedBytes,
                    failedOperationIndex = -1,
                    quotaLimit = ACCOUNT_QUOTA_BYTES,
                    attemptedQuotaUnits = attemptedBytes,
                )
            }

            sessionAreas[toSessionKey] = deepCopySession(source)
            val copiedByteCounts = LinkedHashMap<String, Long>()
            source.forEach { (origin, entries) -> copiedByteCounts[origin] = areaBytes(entries) }
            sessionByteCounts[toSessionKey] = copiedByteCounts
            accountByteCount = attemptedBytes
            clonedSessionTargets += toSessionKey
            revision++
        }
    }

    /** Drop all session storage owned by a native document session key. */
    fun removeSession(sessionKey: String) {
        if (!isValidSessionKey(sessionKey)) return
        synchronized(lock) {
            if (retired) return@synchronized
            val removed = sessionAreas.remove(sessionKey)
            val removedBytes = sessionByteCounts.remove(sessionKey)
            clonedSessionTargets.remove(sessionKey)
            if (removed == null) return@synchronized
            accountByteCount -= removedBytes.orEmpty().values.sum()
            revision++
        }
    }

    /** Export local storage only, retaining origin and insertion order. */
    fun exportLocalPersistence(): List<Map<String, Any?>> = synchronized(lock) {
        if (retired) return@synchronized emptyList()
        localAreas.map { (origin, entries) ->
            linkedMapOf(
                "origin" to origin,
                "entries" to entriesSnapshot(entries),
            )
        }
    }

    /**
     * Merge valid local-storage records into this instance. Malformed entries and entries that
     * exceed either quota are skipped. Imported data is not sent back to the persistence callback.
     * The return value is the number of entries whose stored value changed.
     */
    fun importLocalPersistence(records: List<Map<String, Any?>>): Int = synchronized(lock) {
        check(!retired) { "Browser storage owner has been retired" }
        var imported = 0
        var changed = false

        for (record in records) {
            val origin = (record["origin"] as? String)?.let(::parseOrigin) ?: continue
            val rows = record["entries"] as? List<*> ?: continue
            for (row in rows) {
                val pair = row as? List<*> ?: continue
                if (pair.size != 2) continue
                val key = pair[0] as? String ?: continue
                val value = pair[1] as? String ?: continue

                val area = localAreas[origin]
                val oldExists = area?.containsKey(key) == true
                val oldValue = area?.get(key)
                if (oldExists && oldValue == value) continue
                val oldBytes = if (oldExists) itemBytes(key, oldValue!!) else 0L
                val newItemBytes = itemBytes(key, value)
                val attemptedAreaBytes = safeAdd(areaBytesLocked(LOCAL_AREA, origin, "") - oldBytes, newItemBytes)
                val attemptedAccountBytes = safeAdd(accountByteCount - oldBytes, newItemBytes)
                if (attemptedAreaBytes > AREA_QUOTA_BYTES || attemptedAccountBytes > ACCOUNT_QUOTA_BYTES) {
                    continue
                }
                if (!oldExists && (area?.size ?: 0) >= MAX_ENTRIES_PER_AREA) continue
                if (area == null && !localAreas.containsKey(origin) && localAreas.size >= MAX_LOCAL_ORIGINS) continue

                localAreas.getOrPut(origin) { LinkedHashMap() }[key] = value
                setAreaBytesLocked(LOCAL_AREA, origin, "", attemptedAreaBytes)
                accountByteCount = attemptedAccountBytes
                imported++
                changed = true
            }
        }
        if (changed) revision++
        imported
    }

    /** Retire this owner and discard its in-memory state. */
    fun retire() {
        synchronized(lock) {
            if (retired) return@synchronized
            retired = true
            localAreas.clear()
            sessionAreas.clear()
            localByteCounts.clear()
            sessionByteCounts.clear()
            clonedSessionTargets.clear()
            accountByteCount = 0L
            revision++
        }
    }

    private fun currentArea(
        area: String,
        origin: String,
        sessionKey: String,
    ): LinkedHashMap<String, String>? = when (area) {
        LOCAL_AREA -> localAreas[origin]
        SESSION_AREA -> sessionAreas[sessionKey]?.get(origin)
        else -> null
    }

    private fun areaForMutation(
        area: String,
        origin: String,
        sessionKey: String,
    ): LinkedHashMap<String, String> = when (area) {
        LOCAL_AREA -> localAreas.getOrPut(origin) { LinkedHashMap() }
        else -> sessionAreas.getOrPut(sessionKey) { LinkedHashMap() }
            .getOrPut(origin) { LinkedHashMap() }
    }

    private fun removeEmptyArea(
        area: String,
        origin: String,
        sessionKey: String,
        entries: LinkedHashMap<String, String>,
    ) {
        if (entries.isNotEmpty()) return
        if (area == LOCAL_AREA) {
            localAreas.remove(origin)
        } else {
            val origins = sessionAreas[sessionKey] ?: return
            origins.remove(origin)
            if (origins.isEmpty()) sessionAreas.remove(sessionKey)
        }
    }

    private fun changeRecord(
        area: String,
        origin: String,
        sessionKey: String,
        key: String?,
        oldValue: String?,
        newValue: String?,
        url: String,
    ): Map<String, Any?> = linkedMapOf(
        "area" to area,
        "origin" to origin,
        "sessionKey" to sessionKey,
        "key" to key,
        "oldValue" to oldValue,
        "newValue" to newValue,
        "url" to url,
        "revision" to revision,
    )

    private fun entriesSnapshot(entries: Map<String, String>?): List<List<String>> =
        entries?.map { (key, value) -> listOf(key, value) } ?: emptyList()

    private fun totalBytesLocked(): Long = accountByteCount

    private fun sessionAreaCountLocked(): Int = sessionAreas.values.sumOf { it.size }

    private fun areaBytes(entries: Map<String, String>?): Long =
        entries?.entries?.sumOf { (key, value) -> itemBytes(key, value) } ?: 0L

    private fun areaBytesLocked(area: String, origin: String, sessionKey: String): Long = when (area) {
        LOCAL_AREA -> localByteCounts[origin] ?: 0L
        else -> sessionByteCounts[sessionKey]?.get(origin) ?: 0L
    }

    private fun setAreaBytesLocked(area: String, origin: String, sessionKey: String, bytes: Long) {
        if (area == LOCAL_AREA) {
            if (bytes == 0L) localByteCounts.remove(origin) else localByteCounts[origin] = bytes
            return
        }
        val counts = sessionByteCounts[sessionKey]
        if (bytes == 0L) {
            counts?.remove(origin)
            if (counts.isNullOrEmpty()) sessionByteCounts.remove(sessionKey)
        } else {
            sessionByteCounts.getOrPut(sessionKey) { LinkedHashMap() }[origin] = bytes
        }
    }

    private fun sessionBytes(origins: Map<String, Map<String, String>>): Long =
        origins.values.sumOf(::areaBytes)

    private fun itemBytes(key: String, value: String): Long =
        (key.length.toLong() + value.length.toLong()) * UTF16_BYTES_PER_CODE_UNIT

    private fun safeAdd(left: Long, right: Long): Long =
        if (left > Long.MAX_VALUE - right) Long.MAX_VALUE else left + right

    private fun deepCopySession(
        source: Map<String, out Map<String, String>>,
    ): LinkedHashMap<String, LinkedHashMap<String, String>> = LinkedHashMap<String, LinkedHashMap<String, String>>().apply {
        source.forEach { (origin, entries) -> put(origin, LinkedHashMap(entries)) }
    }

    private fun notifyLocalChanged(changed: Boolean) {
        if (changed) runCatching { onLocalChanged() }
    }

    private fun parseOperation(raw: Map<*, *>): StorageOperation? {
        val allowedFields = setOf("area", "type", "key", "value", "generation", "url")
        if (raw.keys.any { it !is String || it !in allowedFields }) return null
        val generation = raw["generation"].asLongOrNull() ?: return null
        val operationUrl = if ("url" in raw) {
            val rawUrl = raw["url"] as? String ?: return null
            parseDocumentUrl(rawUrl) ?: return null
        } else {
            null
        }
        val area = raw["area"] as? String ?: return null
        if (area != LOCAL_AREA && area != SESSION_AREA) return null
        return when (raw["type"] as? String) {
            "set" -> {
                val key = raw["key"] as? String ?: return null
                val value = raw["value"] as? String ?: return null
                StorageOperation(area, "set", key, value, operationUrl, generation)
            }

            "remove" -> {
                val key = raw["key"] as? String ?: return null
                if ("value" in raw) return null
                StorageOperation(area, "remove", key, null, operationUrl, generation)
            }

            "clear" -> {
                if ("key" in raw || "value" in raw) return null
                StorageOperation(area, "clear", null, null, operationUrl, generation)
            }

            else -> null
        }
    }

    private data class StorageOperation(
        val area: String,
        val type: String,
        val key: String?,
        val value: String?,
        val url: StorageDocumentUrl?,
        val generation: Long,
    )

    private data class StorageDocumentUrl(val origin: String, val serialized: String)

    private data class ApplyFailure(
        val operationIndex: Int,
        val message: String,
        val stale: Boolean,
    )

    private data class QuotaFailure(
        val area: String,
        val quotaScope: String,
        val quotaBytes: Long,
        val quotaLimit: Long,
        val quotaUnit: String,
        val attemptedAreaBytes: Long,
        val attemptedAccountBytes: Long,
        val attemptedQuotaUnits: Long,
        val failedOperationIndex: Int,
    )

    private data class ApplyOutcome(
        val changes: List<Map<String, Any?>>,
        val changedLocal: Boolean,
        val quotaFailure: QuotaFailure?,
        val operationFailure: ApplyFailure? = null,
    )

    private fun requireOrigin(raw: String): String =
        parseOrigin(raw) ?: throw IllegalArgumentException("Invalid HTTP(S) origin")

    private fun requireSessionKey(sessionKey: String) {
        require(isValidSessionKey(sessionKey)) { "Invalid native document session key" }
    }

    companion object {
        private const val LOCAL_AREA = "local"
        private const val SESSION_AREA = "session"
        private const val UTF16_BYTES_PER_CODE_UNIT = 2L
        private const val AREA_QUOTA_CODE_UNITS = 5L * 1024L * 1024L
        private const val AREA_QUOTA_BYTES = AREA_QUOTA_CODE_UNITS * UTF16_BYTES_PER_CODE_UNIT
        private const val ACCOUNT_QUOTA_BYTES = 64L * 1024L * 1024L
        private const val MAX_ENTRIES_PER_AREA = 50_000
        private const val MAX_LOCAL_ORIGINS = 256
        private const val MAX_SESSION_AREAS = 1024
        private const val MAX_URL_LENGTH = 8 * 1024
        private const val MAX_SESSION_KEY_LENGTH = 1024
        private val NEXT_GENERATION = AtomicLong(1L)

        private fun parsePageUrl(raw: String): HttpUrl? {
            if (raw.isEmpty() || raw.length > MAX_URL_LENGTH) return null
            val url = raw.toHttpUrlOrNull() ?: return null
            if (url.scheme != "http" && url.scheme != "https") return null
            if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            return url
        }

        private fun parseDocumentUrl(raw: String): StorageDocumentUrl? {
            if (raw.isEmpty() || raw.length > MAX_URL_LENGTH) return null
            val page = parsePageUrl(raw)
            if (page != null) return StorageDocumentUrl(originOf(page), page.toString())
            if (!raw.startsWith("blob:", ignoreCase = true)) return null
            val inner = raw.substring(5)
            if (inner.isEmpty() || inner.startsWith("blob:", ignoreCase = true)) return null
            val embedded = parsePageUrl(inner) ?: return null
            return StorageDocumentUrl(originOf(embedded), "blob:$embedded")
        }

        private fun parseOrigin(raw: String): String? {
            val url = parsePageUrl(raw) ?: return null
            if (url.encodedPath != "/" || url.encodedQuery != null || url.encodedFragment != null) return null
            return originOf(url)
        }

        private fun originOf(url: HttpUrl): String {
            val host = if (url.host.contains(':')) "[${url.host}]" else url.host
            val defaultPort = if (url.scheme == "https") 443 else 80
            val port = if (url.port == defaultPort) "" else ":${url.port}"
            return "${url.scheme}://$host$port"
        }

        private fun isValidSessionKey(sessionKey: String): Boolean =
            sessionKey.isNotEmpty() && sessionKey.length <= MAX_SESSION_KEY_LENGTH &&
                sessionKey.none { it == '\u0000' }

        private fun Any?.asLongOrNull(): Long? = when (this) {
            is Long -> this
            is Int -> toLong()
            is Short -> toLong()
            is Byte -> toLong()
            is Double -> if (isFinite() && this % 1.0 == 0.0) toLong() else null
            is Float -> if (isFinite() && this % 1f == 0f) toLong() else null
            else -> null
        }
    }
}
