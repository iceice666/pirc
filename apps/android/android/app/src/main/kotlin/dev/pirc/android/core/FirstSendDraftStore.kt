package dev.pirc.android.core

import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class DraftWriteConflict(message: String = "This draft changed in another window. Reopen the saved version.") : IllegalStateException(message)

/** Private no-backup storage. Metadata commits only after its referenced bytes are durable. */
internal class FirstSendDraftStore(private val root: File) {
    companion object {
        private val locks = ConcurrentHashMap<String, ReentrantLock>()
        private const val MAX_METADATA = 4 * 1024 * 1024
        const val MAX_ATTACHMENT = 8 * 1024 * 1024
        private val digestName = Regex("[0-9a-f]{64}")
        fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        fun scope(origin: String, owner: String): String = JsonArray(listOf(JsonPrimitive(origin), JsonPrimitive(owner))).toString()
    }
    private fun directory(parent: File, name: String): File {
        check(!Files.isSymbolicLink(parent.toPath())) { "Local draft directory is a symbolic link" }
        val child = File(parent, name)
        check(!Files.isSymbolicLink(child.toPath())) { "Local draft path is a symbolic link" }
        if (!child.exists()) {
            check(child.mkdir()) { "Local draft directory could not be created" }
            syncDirectory(parent)
        }
        check(child.isDirectory) { "Local draft directory is unavailable" }
        return child
    }
    private fun syncDirectory(file: File) {
        FileChannel.open(file.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }
    private fun <T> locked(scope: String, action: (File) -> T): T {
        check(scope.isNotBlank() && scope.length <= 8192)
        return locks.computeIfAbsent(root.absolutePath) { ReentrantLock() }.withLock {
            val parent = root.parentFile ?: error("Missing private storage parent")
            check(parent.isDirectory)
            val base = directory(parent, root.name)
            val account = directory(base, digest(scope.toByteArray(Charsets.UTF_8)))
            val lockFile = File(account, "lock")
            check(!Files.isSymbolicLink(lockFile.toPath()))
            FileChannel.open(lockFile.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
                channel.lock().use { action(account) }
            }
        }
    }
    private fun operation(account: File, id: String, create: Boolean): File? {
        require(id.isNotBlank() && id.length <= 192 && id.none { it.code < 32 }) { "Invalid draft identity" }
        val name = digest(id.toByteArray(Charsets.UTF_8))
        if (create) return directory(account, name)
        return File(account, name).takeIf { it.exists() }?.also {
            check(!Files.isSymbolicLink(it.toPath()) && it.isDirectory)
        }
    }
    private fun read(directory: File, scope: String, id: String? = null): JsonObject? {
        val file = File(directory, "record.json")
        check(!Files.isSymbolicLink(file.toPath()))
        if (!file.exists()) return null
        check(file.length() in 1..MAX_METADATA.toLong()) { "Local draft metadata is corrupt" }
        val envelope = PircJson.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject
        val version = envelope["version"]?.jsonPrimitive?.intOrNull
        check(version in setOf(1, 2)) { "Unsupported local draft format" }
        val row = checked(envelope["record"]?.jsonObject ?: error("Missing local draft record"), scope, id)
        check(directory.name == digest(row.getValue("operationId").jsonPrimitive.content.toByteArray(Charsets.UTF_8))) { "Local draft identity changed" }
        // Migrate only after binding validation, under the account/file lock.
        // Logical revision and Blob contents stay unchanged; old readers refuse 2.
        if (version == 1) persist(directory, row)
        return row
    }
    private fun checked(row: JsonObject, scope: String, id: String? = null): JsonObject {
        check(row["scope"]?.jsonPrimitive?.content == scope) { "Local draft account changed" }
        if (id != null) check(row["operationId"]?.jsonPrimitive?.content == id) { "Local draft identity changed" }
        return row
    }
    private fun visible(row: JsonObject?) = row?.takeUnless { it["deleted"]?.jsonPrimitive?.booleanOrNull == true }
    fun list(scope: String): List<JsonObject> = locked(scope) { account ->
        account.listFiles().orEmpty().filter { digestName.matches(it.name) }.mapNotNull { dir ->
            check(!Files.isSymbolicLink(dir.toPath()) && dir.isDirectory)
            visible(read(dir, scope))?.let { row ->
                checked(row, scope)
                check(dir.name == digest(row.getValue("operationId").jsonPrimitive.content.toByteArray(Charsets.UTF_8)))
                row
            }
        }
    }
    fun get(scope: String, id: String): JsonObject? = locked(scope) { account ->
        operation(account, id, false)?.let { dir -> visible(read(dir, scope, id))?.let { checked(it, scope, id) } }
    }
    private fun atomicWrite(directory: File, name: String, bytes: ByteArray) {
        val target = File(directory, name)
        check(!Files.isSymbolicLink(target.toPath()))
        val temporary = File(directory, "pending-${UUID.randomUUID()}")
        try {
            FileOutputStream(temporary).use { out -> out.write(bytes); out.fd.sync() }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            syncDirectory(directory)
        } finally { temporary.delete() }
    }
    private fun persist(directory: File, row: JsonObject) {
        val bytes = buildJsonObject { put("version", 2); put("record", row) }.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_METADATA) { "Local draft metadata is too large" }
        atomicWrite(directory, "record.json", bytes)
    }
    fun put(scope: String, owner: String, id: String, expectedRevision: Long?, value: JsonObject, bytes: Map<String, ByteArray> = emptyMap()): JsonObject = locked(scope) { account ->
        putAt(account, scope, owner, id, expectedRevision, value, bytes)
    }
    fun update(scope: String, owner: String, id: String, change: (JsonObject) -> JsonObject): JsonObject = locked(scope) { account ->
        val dir = operation(account, id, false) ?: error("This draft is no longer available")
        val before = visible(read(dir, scope, id))?.let { checked(it, scope, id) } ?: error("This draft is no longer available")
        putAt(account, scope, owner, id, before.getValue("revision").jsonPrimitive.long, change(before), emptyMap())
    }
    private fun putAt(account: File, scope: String, owner: String, id: String, expectedRevision: Long?, value: JsonObject, bytes: Map<String, ByteArray>): JsonObject {
        val dir = operation(account, id, true)!!
        val before = read(dir, scope, id)?.let { checked(it, scope, id) }
        if (before?.get("deleted")?.jsonPrimitive?.booleanOrNull == true) throw DraftWriteConflict("This draft was discarded")
        if (!(if (before == null) expectedRevision == null else before["revision"]?.jsonPrimitive?.longOrNull == expectedRevision)) throw DraftWriteConflict()
        if (before?.get("frozen")?.jsonPrimitive?.booleanOrNull == true && value["frozen"]?.jsonPrimitive?.booleanOrNull != true) throw DraftWriteConflict("Frozen first-message input cannot be edited")
        require(value["workspaceId"]?.jsonPrimitive?.content?.isNotBlank() == true)
        require(value["message"]?.jsonPrimitive?.content?.length?.let { it <= 1_000_000 } == true)
        require(value["deleted"] == null)
        val files = value["files"]?.jsonArray ?: JsonArray(emptyList())
        require(files.size <= 16)
        val usedIds = HashSet<String>()
        val previousFiles = before?.get("files")?.jsonArray.orEmpty().associateBy { it.jsonObject["id"]?.jsonPrimitive?.content }
        val prepared = files.map { raw ->
            val file = raw.jsonObject
            val fileId = file["id"]?.jsonPrimitive?.content ?: error("Missing attachment identity")
            require(fileId.isNotBlank() && fileId.length <= 192 && usedIds.add(fileId))
            val name = file["name"]?.jsonPrimitive?.content ?: error("Missing attachment name")
            require(name.isNotBlank() && name.length <= 255 && name.none { it in "\\/\u0000" })
            val mime = file["mimeType"]?.jsonPrimitive?.content ?: error("Missing attachment type")
            require(mime.length <= 127 && Regex("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+").matches(mime))
            val content = bytes[fileId]
            val previous = previousFiles[fileId]?.jsonObject
            val hash: String
            val size: Long
            if (content != null) {
                require(content.size in 1..MAX_ATTACHMENT)
                hash = digest(content); size = content.size.toLong()
                require(file["byteSize"]?.jsonPrimitive?.longOrNull == size)
                val blob = File(dir, "blob-$hash")
                if (!blob.exists()) atomicWrite(dir, blob.name, content)
                else check(!Files.isSymbolicLink(blob.toPath()) && digest(blob.readBytes()) == hash)
            } else if (previous != null) {
                require(file == previous) { "Stored attachment metadata changed without bytes" }
                hash = previous.getValue("sha256").jsonPrimitive.content
                size = previous.getValue("byteSize").jsonPrimitive.long
            } else {
                // Remote accepted records may have no local bytes; materialization owns them.
                require(value["preparation"]?.jsonObject?.get("accepted")?.jsonPrimitive?.booleanOrNull == true)
                hash = file["sha256"]?.jsonPrimitive?.content ?: error("Missing remote attachment hash")
                size = file["byteSize"]?.jsonPrimitive?.longOrNull ?: error("Missing attachment size")
            }
            require(digestName.matches(hash) && size > 0)
            JsonObject(file + mapOf("sha256" to JsonPrimitive(hash), "byteSize" to JsonPrimitive(size)))
        }
        require(bytes.keys.all { it in usedIds }) { "Unexpected attachment bytes" }
        val revision = (before?.get("revision")?.jsonPrimitive?.longOrNull ?: 0L) + 1
        val row = JsonObject(value + mapOf(
            "scope" to JsonPrimitive(scope), "ownerUser" to JsonPrimitive(owner), "operationId" to JsonPrimitive(id),
            "revision" to JsonPrimitive(revision), "updatedAt" to JsonPrimitive(System.currentTimeMillis()), "files" to JsonArray(prepared),
        ))
        if (before?.get("frozen")?.jsonPrimitive?.booleanOrNull == true &&
            row["preparation"]?.jsonObject?.get("state")?.jsonPrimitive?.content != "cancelled") {
            for (field in listOf("workspaceId", "message", "model", "thinking", "files"))
                require(row[field] == before[field]) { "Frozen first-message input changed" }
            require(row["frozen"]?.jsonPrimitive?.booleanOrNull == true)
        }
        persist(dir, row)
        return row
    }
    fun attachment(scope: String, id: String, fileId: String): Pair<JsonObject, ByteArray> = locked(scope) { account ->
        val dir = operation(account, id, false) ?: error("Missing local draft")
        val row = visible(read(dir, scope, id)) ?: error("Missing local draft")
        attachmentAt(dir, row, fileId)
    }
    private fun attachmentAt(dir: File, row: JsonObject, fileId: String): Pair<JsonObject, ByteArray> {
        val file = row["files"]?.jsonArray?.map { it.jsonObject }?.singleOrNull { it["id"]?.jsonPrimitive?.content == fileId }
            ?: error("Missing local attachment")
        val hash = file.getValue("sha256").jsonPrimitive.content
        require(digestName.matches(hash))
        val blob = File(dir, "blob-$hash")
        check(!Files.isSymbolicLink(blob.toPath()) && blob.length() in 1..MAX_ATTACHMENT.toLong()) { "Local attachment unavailable" }
        val content = blob.readBytes()
        check(content.size.toLong() == file.getValue("byteSize").jsonPrimitive.long && digest(content) == hash) { "Local attachment is corrupt" }
        return file to content
    }
    /** A private copy only: never changes the source operation or its outcome. */
    fun recover(scope: String, owner: String, sourceId: String, targetId: String, expectedRevision: Long?, value: JsonObject, bytes: Map<String, ByteArray>): JsonObject = locked(scope) { account ->
        require(sourceId != targetId) { "Recovery must have its own draft identity" }
        val sourceDir = operation(account, sourceId, false)
        val source = sourceDir?.let { visible(read(it, scope, sourceId)) }
        val targetDir = operation(account, targetId, false)
        val target = targetDir?.let { visible(read(it, scope, targetId)) }
        if (target != null && (target["frozen"]?.jsonPrimitive?.booleanOrNull == true || target["recoveredFrom"]?.jsonPrimitive?.content != sourceId)) throw DraftWriteConflict()
        val supplied = bytes.toMutableMap()
        for (raw in value.getValue("files").jsonArray) {
            val file = raw.jsonObject
            val id = file.getValue("id").jsonPrimitive.content
            if (id in supplied) continue
            val candidate = listOf(targetDir to target, sourceDir to source).firstOrNull { (_, row) ->
                row?.get("files")?.jsonArray?.any { entry ->
                    val known = entry.jsonObject
                    listOf("id", "name", "mimeType", "byteSize").all { file[it] == known[it] } &&
                        (file["sha256"] == null || file["sha256"] == known["sha256"])
                } == true
            } ?: error("The original attachment is missing from local storage.")
            supplied[id] = attachmentAt(candidate.first!!, candidate.second!!, id).second
        }
        val record = JsonObject(value.filterKeys { it in setOf("workspaceId", "message", "model", "thinking", "files") } + mapOf(
            "frozen" to JsonPrimitive(false), "prepareAttempted" to JsonPrimitive(false), "recoveredFrom" to JsonPrimitive(sourceId),
        ))
        putAt(account, scope, owner, targetId, expectedRevision, record, supplied)
    }
    fun remove(scope: String, id: String, expectedRevision: Long) = locked(scope) { account ->
        val dir = operation(account, id, false) ?: return@locked
        val row = read(dir, scope, id)?.let { checked(it, scope, id) } ?: return@locked
        if (row["deleted"]?.jsonPrimitive?.booleanOrNull != true) {
            check(row["revision"]?.jsonPrimitive?.longOrNull == expectedRevision) { "This draft changed in another window" }
            persist(dir, buildJsonObject {
                put("scope", scope); put("operationId", id); put("revision", expectedRevision + 1); put("deleted", true)
            })
        }
        // The identifier-only tombstone prevents delayed queued writes from resurrection.
        for (file in dir.listFiles().orEmpty()) if (file.name.startsWith("blob-") && digestName.matches(file.name.removePrefix("blob-"))) {
            check(!Files.isSymbolicLink(file.toPath()))
            check(file.delete()) { "Local attachment cleanup is pending" }
        }
        syncDirectory(dir)
    }
}
