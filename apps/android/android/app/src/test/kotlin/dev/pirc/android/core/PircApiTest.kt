package dev.pirc.android.core

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertArrayEquals
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class PircApiTest {
    private val server = MockWebServer()
    private val token = "pirc_dev_" + "b".repeat(43)
    private lateinit var api: PircApi

    @Before
    fun start() {
        server.start()
        api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), token))
    }

    @After
    fun stop() = server.close()

    @Test
    fun commandPostsCapturedEnvironmentWithoutRefreshingOrRetrying() = runTest {
        val binding = ConversationBinding(1, ConversationMembership(2, "node:repo"), ConversationExecution(7, "node:repo", "node", "directory"))
        server.enqueue(MockResponse.Builder().code(409).body("""{"error":{"code":"stale_environment","message":"Environment changed"}}""").build())
        try {
            api.command("s", "phone", 3, "cmd", Commands.simple("stop"), binding)
            fail("expected the original server rejection")
        } catch (error: ApiException) {
            assertEquals("stale_environment", error.code)
        }
        val body = PircJson.parseToJsonElement(server.takeRequest().body!!.utf8())
        assertEquals(PircJson.encodeToJsonElement(ConversationBinding.serializer(), binding), (body as kotlinx.serialization.json.JsonObject)["expectedBinding"])
        assertEquals(1, server.requestCount)
    }

    @Test
    fun temporaryManagementGrantIsScopedAndExpiresByMonotonicTime() {
        var clock = 100L
        api.managementClock = { clock }
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 10_000L, 5_000L, setOf("providers"))
        for (path in listOf("/api/providers", "/api/providers/p/test", "/api/provider-auth/status")) {
            assertEquals("pirc_mgmt_" + "a".repeat(43), api.request(path).build().header("X-Pirc-Management"))
        }
        for (path in listOf("/api/devices", "/api/sessions", "/api/providers-other", "/api/native-management/requests", "/api/attachments")) {
            assertEquals(null, api.request(path).build().header("X-Pirc-Management"))
        }
        assertEquals(5_000L, api.managementStatus()["remainingMs"])
        assertTrue(!api.managementStatus().containsKey("token"))
        clock = 5_100L
        assertEquals(null, api.request("/api/providers").build().header("X-Pirc-Management"))
        assertEquals(false, api.managementStatus()["active"])
    }

    @Test
    fun temporaryDeviceConsentClearsImmediatelyAndNeverFollowsRedirects() = runTest {
        api.installManagementGrant("pirc_mgmt_" + "a".repeat(43), 10_000L, 5_000L, setOf("devices"))
        assertEquals(null, api.request("/api/providers").build().header("X-Pirc-Management"))
        assertTrue(api.request("/api/devices?foo=1").build().header("X-Pirc-Management") != null)
        assertTrue(!api.client.followRedirects && !api.client.followSslRedirects)
        api.clearManagementGrant()
        assertEquals(null, api.request("/api/devices").build().header("X-Pirc-Management"))
    }

    @Test
    fun projectFilesUseRawBytesAndEncodeNamesWithoutCreatingAttachments() = runTest {
        val bytes = "{\"hello\":\"你好\"}\n".toByteArray()
        server.enqueue(MockResponse.Builder().code(201).body("""{"file":{"name":"設定 notes +.json","byteSize":${bytes.size},"modifiedAt":1}}""").build())
        val reply = api.uploadProjectFile("chat:project /+", "設定 notes +.json",
            bytes.toRequestBody("application/octet-stream".toMediaType()))
        assertTrue(reply.containsKey("file"))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/workspaces/chat%3Aproject%20%2F%2B/files", request.url.encodedPath)
        assertEquals("設定 notes +.json", request.url.queryParameter("filename"))
        assertEquals("application/octet-stream", request.headers["Content-Type"])
        assertEquals("Bearer $token", request.headers["Authorization"])
        assertArrayEquals(bytes, request.body!!.toByteArray())
    }

    @Test
    fun sendsTheDeviceTokenAndNoOrigin() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"nodes":[{"id":"m5pro","workspaces":[{"id":"pirc","displayName":"pirc"}]}]}""").build())
        assertEquals("m5pro", api.nodes().single().id)
        val request = server.takeRequest()
        assertEquals("/api/nodes", request.url.encodedPath)
        assertEquals("Bearer $token", request.headers["Authorization"])
        assertEquals(null, request.headers["Origin"])
    }

    @Test
    fun reportsADeadTokenAsUnauthorized() = runTest {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":{"code":"unauthenticated","message":"Device token is invalid, expired or revoked"}}""").build())
        try {
            api.sessions()
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertTrue(error.unauthorized)
            assertEquals("unauthenticated", error.code)
            assertEquals("Device token is invalid, expired or revoked. Pair this phone again.", error.message)
        }
    }

    @Test
    fun reportsAnUnreadableReplyAsAnApiError() = runTest {
        // A proxy answering with its own page must not end the app.
        server.enqueue(MockResponse.Builder().body("<html>login</html>").build())
        server.enqueue(MockResponse.Builder().body("""{"ok":true}""").build())
        server.enqueue(MockResponse.Builder().body("""{"session":{"unexpected":1}}""").build())
        for (call in listOf<suspend () -> Unit>(
            { api.sessions() },
            { api.createSession("w") },
            { api.updateSession("s", name = "x") },
        )) {
            try {
                call()
                fail("expected ApiException")
            } catch (error: ApiException) {
                assertEquals("bad_reply", error.code)
                assertTrue(!error.unauthorized)
            }
        }
    }

    @Test
    fun anEventStreamClosedFor4401CarriesTheReason() {
        val error = EventStream(api).fatal(4401, null, "device token revoked or expired")!!
        assertTrue(error.unauthorized)
        assertEquals("Device token revoked or expired. Pair this phone again.", error.message)
        assertEquals(null, EventStream(api).fatal(1006, null))
    }

    @Test
    fun neverFollowsRedirectsWithTheToken() = runTest {
        server.enqueue(MockResponse.Builder().code(302).setHeader("Location", "https://auth.example/login").build())
        try {
            api.sessions()
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertEquals(302, error.status)
            assertTrue(error.message!!.contains("redirected"))
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun passesGatewayErrorMessagesThrough() = runTest {
        server.enqueue(MockResponse.Builder().code(403).body("""{"error":{"code":"forbidden","message":"Device tokens cannot reach this route"}}""").build())
        try {
            api.workspaces()
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertEquals(403, error.status)
            assertEquals("Device tokens cannot reach this route", error.message)
        }
    }
}
