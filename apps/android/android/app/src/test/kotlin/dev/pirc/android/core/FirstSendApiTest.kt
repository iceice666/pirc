package dev.pirc.android.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class FirstSendApiTest {
    private fun <T> fixture(action: (MockWebServer, FirstSendApi) -> T): T {
        MockWebServer().use { server ->
            server.start()
            return action(server, FirstSendApi(PircApi(Pairing(server.url("/").toString().trimEnd('/'), "secret-fixture-token"))))
        }
    }
    @Test fun requestsPinTheExactUnicodeAccountAndKeepRawAttachmentBytes() = fixture { server, api -> runTest {
        server.enqueue(MockResponse.Builder().body("{}").build())
        api.request("PUT", "/api/conversation-submissions/op/attachments/f1", "使用者@example.test~!()'", bytes = byteArrayOf(0, 1, -1))
        val request = server.takeRequest()
        assertEquals("Bearer secret-fixture-token", request.headers["Authorization"])
        assertEquals("%E4%BD%BF%E7%94%A8%E8%80%85%40example.test~!()'", request.headers["x-pirc-account"])
        assertEquals("application/octet-stream", request.headers["Content-Type"])
        assertArrayEquals(byteArrayOf(0, 1, -1), request.body!!.toByteArray())
    } }
    @Test fun redirectsDoNotForwardCredentialsOrTurnAnUnknownPostIntoReplay() = fixture { server, api -> runTest {
        server.enqueue(MockResponse.Builder().code(307).addHeader("Location", server.url("/other")).body("{}").build())
        try { api.request("POST", "/api/conversation-submissions/prepare", "alice", buildJsonObject { put("operationId", "op") }); fail("must refuse redirect") }
        catch (error: ApiException) { assertEquals(307, error.status) }
        assertEquals(1, server.requestCount)
    } }
    @Test fun retryAfterZeroDoesNotAutomaticallyReplayAMutation() = fixture { server, api -> runTest {
        server.enqueue(MockResponse.Builder().code(503).addHeader("Retry-After", "0").body("{}").build())
        server.enqueue(MockResponse.Builder().body("{}").build())
        try { api.request("POST", "/api/conversation-submissions/prepare", "alice", buildJsonObject { put("operationId", "op") }); fail("must surface response") }
        catch (error: ApiException) { assertEquals(503, error.status) }
        assertEquals(1, server.requestCount)
    } }
    @Test fun privateDraftBytesCannotBeSentToAnArbitraryPath() = fixture { server, api -> runTest {
        for (path in listOf("https://example.test/steal", "/api/providers", "/api/conversation-submissions/%2e%2e", "/api/conversation-submissions/op/../prepare", "/api/sessions/s/commands?next=https://other.test")) {
            try { api.request("POST", path, "alice"); fail("Invalid route must be refused") }
            catch (_: IllegalArgumentException) {}
        }
        try { api.request("POST", "/api/conversation-submissions/prepare"); fail("Account must be pinned") }
        catch (_: IllegalArgumentException) {}
        assertEquals(0, server.requestCount)
    } }
}
