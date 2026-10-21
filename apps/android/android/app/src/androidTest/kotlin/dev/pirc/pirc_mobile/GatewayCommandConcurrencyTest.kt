package dev.pirc.pirc_mobile

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PircApi
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class GatewayCommandConcurrencyTest {
    @Test
    fun queuedCommandCannotCrossPairingChangeOrClearNewAccountMarker() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = GatewayRuntime.get(context)
        val sessionId = "pairing-command-race-${UUID.randomUUID()}"
        val steerId = "steer-${UUID.randomUUID()}"
        val queuedId = "model-${UUID.randomUUID()}"
        val marker = "new-account-${UUID.randomUUID()}"
        val server = LocalCommandServer(runtime.local.clientId, holdSteer = true)
        val original = RuntimeOverride(context, runtime, server.api(), sessionId)
        val pairingIdentity = context.getSharedPreferences("pairing_identity", Context.MODE_PRIVATE)
        val initialStamp = UUID.randomUUID().toString()
        val jobs = mutableListOf<Deferred<Result<Map<String, Any?>>>>()

        try {
            assertTrue(pairingIdentity.edit().putString("stamp", initialStamp).commit())
            val steer = async(Dispatchers.IO) {
                runCatching { runtime.sessions.command(sessionId, mapOf("type" to "steer"), steerId) }
            }
            jobs += steer
            assertTrue("The held steer POST did not reach the gateway", server.steerReceived.await(5, TimeUnit.SECONDS))

            // Undispatched execution snapshots the current pairing before it suspends on commandLock.
            val queued = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
                runCatching {
                    runtime.sessions.command(sessionId, mapOf("type" to "set_model", "modelId" to "queued-model"), queuedId)
                }
            }
            jobs += queued
            assertTrue(pairingIdentity.edit().putString("stamp", UUID.randomUUID().toString()).commit())
            assertTrue(original.preferences.edit().putString(original.commandKey, marker).commit())

            server.releaseSteer.countDown()
            withTimeout(5_000) { steer.await() }
            val result = withTimeout(5_000) { queued.await() }
            assertEquals("account_changed", (result.exceptionOrNull() as? ApiException)?.code)
            assertEquals(setOf(steerId), server.receivedCommandIds.toSet())
            assertEquals(marker, original.preferences.getString(original.commandKey, null))
            assertTrue(runtime.sessions.unknownCommand(sessionId))
        } finally {
            server.releaseSteer.countDown()
            withTimeoutOrNull(5_000) { jobs.joinAll() }
            server.close()
            original.close()
        }
    }

    @Test
    fun stopReachesGatewayWhileSteerResponseIsHeldAndKeepsSteerUncertainty() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = GatewayRuntime.get(context)
        val sessionId = "stop-race-${UUID.randomUUID()}"
        val steerId = "steer-${UUID.randomUUID()}"
        val stopId = "stop-${UUID.randomUUID()}"
        val server = LocalCommandServer(runtime.local.clientId, holdSteer = true)
        val original = RuntimeOverride(context, runtime, server.api(), sessionId)
        val jobs = mutableListOf<Deferred<Map<String, Any?>>>()

        try {
            val steer = async(Dispatchers.IO) {
                runtime.sessions.command(sessionId, mapOf("type" to "steer", "message" to "continue"), steerId)
            }
            jobs += steer
            assertTrue("The held steer POST did not reach the local gateway", server.steerReceived.await(5, TimeUnit.SECONDS))
            assertEquals(steerId, original.preferences.getString(original.commandKey, null))

            val stop = async(Dispatchers.IO) {
                runtime.sessions.command(sessionId, mapOf("type" to "stop"), stopId)
            }
            jobs += stop
            assertTrue("Stop did not reach the gateway on an independent request", server.stopReceived.await(5, TimeUnit.SECONDS))
            assertEquals("accepted", withTimeout(5_000) { stop.await() }["status"])

            assertFalse("The steer response must still be held", steer.isCompleted)
            assertEquals("The accepted stop must leave the unresolved steer marker", steerId,
                original.preferences.getString(original.commandKey, null))
            assertNull("The accepted stop should clear only its own marker",
                original.preferences.getString(original.stopKey, null))
            assertTrue(runtime.sessions.unknownCommand(sessionId))

            server.releaseSteer.countDown()
            assertEquals("accepted", withTimeout(5_000) { steer.await() }["status"])
            assertFalse("The accepted steer should clear its marker", runtime.sessions.unknownCommand(sessionId))
        } finally {
            server.releaseSteer.countDown()
            withTimeoutOrNull(5_000) { jobs.joinAll() }
            server.close()
            original.close()
        }
    }

    @Test
    fun unknownStopRemainsUncertainAndAcknowledgeClearsBothCommandMarkers() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = GatewayRuntime.get(context)
        val sessionId = "stop-unknown-${UUID.randomUUID()}"
        val steerId = "steer-${UUID.randomUUID()}"
        val stopId = "stop-${UUID.randomUUID()}"
        val server = LocalCommandServer(runtime.local.clientId, holdSteer = true, stopStatus = "outcome_unknown")
        val original = RuntimeOverride(context, runtime, server.api(), sessionId)
        val jobs = mutableListOf<Deferred<Map<String, Any?>>>()

        try {
            val steer = async(Dispatchers.IO) {
                runtime.sessions.command(sessionId, mapOf("type" to "steer", "message" to "continue"), steerId)
            }
            jobs += steer
            assertTrue("The held steer POST did not reach the local gateway", server.steerReceived.await(5, TimeUnit.SECONDS))
            assertEquals(steerId, original.preferences.getString(original.commandKey, null))

            val stop = async(Dispatchers.IO) {
                runtime.sessions.command(sessionId, mapOf("type" to "stop"), stopId)
            }
            jobs += stop
            assertTrue("Stop did not reach the gateway on an independent request", server.stopReceived.await(5, TimeUnit.SECONDS))
            val receipt = withTimeout(5_000) { stop.await() }
            assertEquals("outcome_unknown", receipt["status"])
            assertTrue("An uncertain stop must remain visible as uncertain", runtime.sessions.unknownCommand(sessionId))
            assertEquals(steerId, original.preferences.getString(original.commandKey, null))
            assertEquals(stopId, original.preferences.getString(original.stopKey, null))

            server.releaseSteer.countDown()
            assertEquals("accepted", withTimeout(5_000) { steer.await() }["status"])
            assertNull("The accepted steer clears only its own marker", original.preferences.getString(original.commandKey, null))
            assertEquals("The uncertain stop must survive the later steer receipt", stopId,
                original.preferences.getString(original.stopKey, null))
            assertTrue(runtime.sessions.unknownCommand(sessionId))

            runtime.sessions.acknowledgeCommand(sessionId)
            assertFalse(runtime.sessions.unknownCommand(sessionId))
            assertNull(original.preferences.getString(original.commandKey, null))
            assertNull(original.preferences.getString(original.stopKey, null))
        } finally {
            server.releaseSteer.countDown()
            withTimeoutOrNull(5_000) { jobs.joinAll() }
            server.close()
            original.close()
        }
    }

    private inner class RuntimeOverride(
        context: Context,
        private val runtime: GatewayRuntime,
        api: PircApi,
        sessionId: String,
    ) : Closeable {
        private val apiField = GatewayRuntime::class.java.getDeclaredField("activeApi").apply { isAccessible = true }
        private val heldField = GatewayRuntime::class.java.getDeclaredField("heldGenerations").apply { isAccessible = true }
        private val heldGenerations = heldField.get(runtime) as MutableMap<String, Long>
        private val previousApi = apiField.get(runtime)
        private val previousGeneration = heldGenerations[sessionId]
        val preferences = context.getSharedPreferences("uncertain_answers", Context.MODE_PRIVATE)
        val commandKey = "command:$sessionId"
        val stopKey = "command-stop:$sessionId"
        private val previousCommand = preferences.all[commandKey]
        private val previousStop = preferences.all[stopKey]
        private val pairingIdentity = context.getSharedPreferences("pairing_identity", Context.MODE_PRIVATE)
        private val previousPairingStamp = pairingIdentity.getString("stamp", null)

        init {
            apiField.set(runtime, api)
        }

        override fun close() {
            apiField.set(runtime, previousApi)
            if (previousGeneration == null) heldGenerations.remove(commandKey.removePrefix("command:"))
            else heldGenerations[commandKey.removePrefix("command:")] = previousGeneration
            restorePreference(preferences, commandKey, previousCommand)
            restorePreference(preferences, stopKey, previousStop)
            restorePreference(pairingIdentity, "stamp", previousPairingStamp)
        }
    }

    private inner class LocalCommandServer(
        private val clientId: String,
        private val holdSteer: Boolean = false,
        private val stopStatus: String = "accepted",
    ) : Closeable {
        private val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        private val workers = Executors.newCachedThreadPool()
        private val openSockets = ConcurrentHashMap.newKeySet<Socket>()
        private val acceptThread = Thread({ acceptRequests() }, "gateway-command-test-server").apply {
            isDaemon = true
            start()
        }
        val steerReceived = CountDownLatch(1)
        val stopReceived = CountDownLatch(1)
        val releaseSteer = CountDownLatch(1)
        val receivedCommandIds = ConcurrentHashMap.newKeySet<String>()

        fun api() = PircApi(
            Pairing("http://127.0.0.1:${socket.localPort}", "android-test-token"),
            OkHttpClient.Builder()
                .connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .writeTimeout(3, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false)
                .build(),
        )

        private fun acceptRequests() {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: SocketException) {
                    break
                } catch (error: Exception) {
                    if (!socket.isClosed) throw error
                    break
                }
                openSockets += client
                workers.execute { serve(client) }
            }
        }

        private fun serve(client: Socket) {
            client.use { connection ->
                try {
                    connection.soTimeout = 8_000
                    val input = connection.getInputStream()
                    val requestLine = readLine(input) ?: return
                    val first = requestLine.split(' ', limit = 3)
                    val method = first.getOrNull(0).orEmpty()
                    val path = first.getOrNull(1).orEmpty()
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = readLine(input) ?: break
                        if (line.isEmpty()) break
                        val separator = line.indexOf(':')
                        if (separator > 0) headers[line.substring(0, separator).lowercase()] = line.substring(separator + 1).trim()
                    }
                    val bodySize = headers["content-length"]?.toIntOrNull() ?: 0
                    val bytes = ByteArray(bodySize)
                    var offset = 0
                    while (offset < bytes.size) {
                        val count = input.read(bytes, offset, bytes.size - offset)
                        if (count <= 0) return
                        offset += count
                    }
                    val body = bytes.toString(Charsets.UTF_8)
                    val reply = when {
                        path.endsWith("/control") || path.endsWith("/control/heartbeat") ->
                            """{"lease":{"clientId":"$clientId","generation":7,"expiresAt":4102444800000}}"""
                        path.endsWith("/commands") -> commandReply(body)
                        else -> "{}"
                    }
                    writeResponse(connection, 200, reply)
                } catch (_: Exception) {
                    // A test assertion or timeout may close a held connection.
                } finally {
                    openSockets.remove(connection)
                }
            }
        }

        private fun commandReply(body: String): String {
            val root = dev.pirc.android.core.PircJson.parseToJsonElement(body).jsonObject
            val id = root["commandId"]!!.jsonPrimitive.content
            receivedCommandIds += id
            val type = root["payload"]!!.jsonObject["type"]!!.jsonPrimitive.content
            if (type == "steer") {
                steerReceived.countDown()
                if (holdSteer) check(releaseSteer.await(5, TimeUnit.SECONDS)) { "Steer response was not released" }
                return """{"command":{"id":"$id","status":"accepted"}}"""
            }
            if (type == "stop") {
                stopReceived.countDown()
                return """{"command":{"id":"$id","status":"$stopStatus"}}"""
            }
            return """{"command":{"id":"$id","status":"rejected"}}"""
        }

        override fun close() {
            releaseSteer.countDown()
            runCatching { socket.close() }
            openSockets.toList().forEach { runCatching { it.close() } }
            workers.shutdownNow()
            workers.awaitTermination(1, TimeUnit.SECONDS)
            acceptThread.join(1_000)
        }
    }

    private fun readLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) return if (bytes.size() == 0) null else bytes.toString(Charsets.US_ASCII.name())
            if (value == '\n'.code) {
                val line = bytes.toByteArray().let { raw ->
                    if (raw.lastOrNull() == '\r'.code.toByte()) raw.copyOf(raw.size - 1) else raw
                }
                return line.toString(Charsets.US_ASCII)
            }
            bytes.write(value)
        }
    }

    private fun writeResponse(socket: Socket, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val phrase = if (status == 200) "OK" else "Not Found"
        val headers = "HTTP/1.1 $status $phrase\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        socket.getOutputStream().apply {
            write(headers.toByteArray(Charsets.US_ASCII))
            write(bytes)
            flush()
        }
    }

    private fun restorePreference(store: android.content.SharedPreferences, key: String, value: Any?) {
        val editor = store.edit()
        when (value) {
            null -> editor.remove(key)
            is String -> editor.putString(key, value)
            is Boolean -> editor.putBoolean(key, value)
            is Int -> editor.putInt(key, value)
            is Long -> editor.putLong(key, value)
            is Float -> editor.putFloat(key, value)
            is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toSet())
            else -> error("Unexpected saved preference value for $key: ${value::class.java.name}")
        }
        check(editor.commit()) { "Could not restore test preference $key" }
    }
}
