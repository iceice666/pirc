package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.File
import java.io.IOException
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/** Explicit conformance process entrypoint, not an Android OS/instrumentation test. */
object NativeFirstSendLive {
    private const val owner = "test@example.com"
    private const val stamp = "fixture-pairing"
    private val operations = listOf("native-reply-loss", "native-local-write-loss")
    private fun obj(value: Any?) = value as Map<*, *>
    private fun preparation(value: Any?) = obj(obj(value)["preparation"])
    private fun publish(root: File, name: String, value: Any?) {
        val pending = File(root, "$name.pending")
        pending.writeText(value.json().toString())
        Files.move(pending.toPath(), File(root, "$name.json").toPath(), StandardCopyOption.ATOMIC_MOVE)
    }
    private suspend fun marker(root: File, name: String) {
        val deadline = System.nanoTime() + 60_000_000_000L
        while (!File(root, "$name.json").isFile) {
            check(System.nanoTime() < deadline) { "Timed out waiting for $name" }
            delay(30)
        }
    }
    @JvmStatic fun main(args: Array<String>) = runBlocking {
        require(args.size == 2 && args[1] in setOf("send", "recover"))
        val config = PircJson.parseToJsonElement(File(args[0]).readText()).jsonObject
        val gateway = config.getValue("gateway").jsonPrimitive.content
        require(URI(gateway).host == "127.0.0.1")
        val root = File(config.getValue("directory").jsonPrimitive.content)
        val directory = File(root, "primary")
        val scope = FirstSendDraftStore.scope(gateway, owner)
        val calls = mutableListOf<Map<String, Any>>()
        var beforeDispatch: ((String) -> Unit)? = null
        var lost = false
        var readonly: Pair<File, Set<PosixFilePermission>>? = null
        val faulting = args[1] == "send"
        val client = defaultHttpClient().newBuilder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            check(request.header("x-pirc-user") == null && request.header("Origin") == null)
            check(request.header("Authorization")?.startsWith("Bearer pirc_dev_") == true)
            if (faulting && request.url.encodedPath.endsWith("/dispatch")) {
                beforeDispatch!!(request.url.pathSegments[2])
            }
            // Only fixture routing is substituted; authentication remains the real device bearer.
            val response = chain.proceed(request.newBuilder().header("Host", config.getValue("host").jsonPrimitive.content).build())
            calls += mapOf("method" to request.method, "path" to request.url.encodedPath, "status" to response.code)
            if (request.url.encodedPath.endsWith("/capabilities") && response.isSuccessful) {
                val original = PircJson.parseToJsonElement(response.body.string()).jsonObject
                check(original["canSubmit"] == JsonPrimitive(false))
                check(original["clientContract"] == JsonPrimitive(2))
                return@Interceptor response.newBuilder().body(
                    JsonObject(original + ("canSubmit" to JsonPrimitive(true))).toString().toResponseBody("application/json".toMediaType())
                ).build()
            }
            if (faulting && request.url.encodedPath.endsWith("/dispatch") && response.isSuccessful) {
                if (request.url.encodedPath.contains("native-reply-loss") && !lost) {
                    lost = true
                    response.close()
                    throw IOException("Injected loss after real Gateway dispatch")
                }
                if (request.url.encodedPath.contains("native-local-write-loss")) {
                    val op = File(File(directory, FirstSendDraftStore.digest(scope.toByteArray())), FirstSendDraftStore.digest("native-local-write-loss".toByteArray()))
                    readonly = op to Files.getPosixFilePermissions(op.toPath())
                    Files.setPosixFilePermissions(op.toPath(), PosixFilePermissions.fromString("r-xr-xr-x"))
                    check(!Files.isWritable(op.toPath())) { "Run this filesystem-failure fixture as an ordinary user, not root" }
                }
            }
            response
        }).build()
        fun connection(token: String, dir: File): NativeFirstSend {
            val api = PircApi(Pairing(gateway, token), client)
            return NativeFirstSend(dir, { requested -> requirePairingStamp(requested, stamp); api }, { requested -> requirePairingStamp(requested, stamp) })
        }
        suspend fun save(c: NativeFirstSend, id: String, withFile: Boolean) = c.drafts(stamp, owner, mapOf(
            "action" to "put", "operationId" to id,
            "record" to mapOf("workspaceId" to "test:chats", "message" to "First message $id",
                "model" to mapOf("provider" to "fake", "id" to "fake-model"), "thinking" to "low",
                "files" to if (withFile) listOf(mapOf("id" to "original-file", "name" to "native.txt", "mimeType" to "text/plain", "byteSize" to "Original bytes for $id".toByteArray().size)) else emptyList()),
            "files" to if (withFile) listOf(mapOf("id" to "original-file", "bytes" to "Original bytes for $id".toByteArray())) else emptyList(),
        ))
        suspend fun row(c: NativeFirstSend, id: String) = obj(c.drafts(stamp, owner, mapOf("action" to "get", "operationId" to id)))
        try {
            val primary = connection(config.getValue("token").jsonPrimitive.content, directory)
            primary.capabilities(stamp)
            val secondDirectory = File(root, "secondary")
            val secondary = connection(config.getValue("secondToken").jsonPrimitive.content, secondDirectory)
            secondary.capabilities(stamp)
            if (faulting) {
                // A second paired client opens the pending conversation before delivery.
                // Completed operations intentionally disappear from the pending-session API.
                beforeDispatch = { id ->
                    val saved = FirstSendDraftStore(directory).get(scope, id)!!
                    val session = saved.getValue("preparation").jsonObject.getValue("sessionId").jsonPrimitive.content
                    runBlocking {
                        val adopted = secondary.adopt(stamp, owner, session)
                        check(preparation(adopted)["state"] == "ready")
                        check(preparation(adopted)["operationId"] == id)
                    }
                }
                val pending = operations.map { id ->
                    save(primary, id, true)
                    var failed = false
                    try { primary.submit(stamp, owner, id, 1, "primary-native") }
                    catch (_: Exception) { failed = true }
                    check(failed) { "Expected interrupted submission for $id" }
                    if (id == "native-local-write-loss") check(readonly != null) { "Expected real file write refusal" }
                    val saved = row(primary, id)
                    check(saved["frozen"] == true && saved["uncertain"] == true)
                    check(preparation(saved)["state"] == "ready")
                    val content = FirstSendDraftStore(directory).attachment(scope, id, "original-file").second
                    check(content.contentEquals("Original bytes for $id".toByteArray()))
                    readonly?.let { (file, permissions) -> Files.setPosixFilePermissions(file.toPath(), permissions) }
                    readonly = null
                    mapOf("id" to id, "session" to preparation(saved)["sessionId"])
                }
                check(lost)
                for (id in operations) check(calls.count { it["path"] == "/api/conversation-submissions/$id/dispatch" } == 1)
                publish(root, "before-restart", mapOf("operations" to pending, "calls" to calls))
            } else {
                val recovered = operations.map { id ->
                    val before = row(primary, id)
                    check(before["uncertain"] == true)
                    val result = primary.submit(stamp, owner, id, null, "primary-native")
                    check(preparation(result)["state"] == "admitted")
                    val session = preparation(result)["sessionId"] as String
                    check(session == preparation(before)["sessionId"])
                    val other = secondary.check(stamp, owner, id)
                    check(preparation(other) == preparation(result))
                    check(FirstSendDraftStore(directory).attachment(scope, id, "original-file").second.contentEquals("Original bytes for $id".toByteArray()))
                    check(!secondDirectory.walkTopDown().any { it.name.startsWith("blob-") })
                    mapOf("id" to id, "session" to session, "command" to obj(preparation(result)["messageAdmission"])["commandId"])
                }
                check(calls.all { it["method"] == "GET" })
                save(primary, "revoked-new", false)
                publish(root, "recovered", mapOf("operations" to recovered))
                marker(root, "revoked")
                val beforeRevocation = row(primary, "revoked-new")
                for (id in listOf(operations.first(), "revoked-new")) {
                    try { primary.submit(stamp, owner, id, 1, "primary-native"); error("Revoked token must be refused") }
                    catch (error: ApiException) { check(error.status == 401) }
                }
                check(row(primary, "revoked-new") == beforeRevocation)
                for (id in operations) check(preparation(secondary.check(stamp, owner, id))["state"] == "admitted")
                check(calls.all { it["method"] == "GET" })
                check(calls.count { it["status"] == 401 } == 2)
                publish(root, "result", mapOf("operations" to recovered, "calls" to calls, "revokedRefused" to true))
            }
        } finally {
            readonly?.let { (file, permissions) -> Files.setPosixFilePermissions(file.toPath(), permissions) }
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }
}
