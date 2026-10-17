package dev.pirc.android.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ControlTest {
    private val me = "android-me"
    private fun lease(holder: String?, generation: Long = 3, expired: Boolean = false) =
        ControlLease(holder, holder == me && !expired, expired, generation)

    private class FakeControl(
        var current: () -> ControlLease,
        var acquired: () -> ControlLease,
        var renewed: (Long) -> ControlLease,
    ) : ControlApi {
        val calls = mutableListOf<String>()
        override suspend fun control() = current().also { calls += "control" }
        override suspend fun acquire() = acquired().also { calls += "acquire" }
        override suspend fun heartbeat(generation: Long) = renewed(generation).also { calls += "heartbeat:$generation" }
    }

    private fun conflict(): Nothing = throw ApiException(409, "lost_control", "Another client holds control")

    @Test
    fun renewsItsOwnLease() = runTest {
        val api = FakeControl({ fail(); lease(null) }, { fail(); lease(null) }, { lease(me, it) })
        assertEquals(lease(me, 3), syncControl(api, lease(me, 3), mayAcquire = true))
        assertEquals(listOf("heartbeat:3"), api.calls)
    }

    @Test
    fun picksUpAFreeOrExpiredLeaseOnlyWhenVisible() = runTest {
        val api = FakeControl({ lease("web", expired = true) }, { lease(me, 4) }, { fail(); lease(null) })
        assertEquals(lease("web", expired = true), syncControl(api, ControlLease(), mayAcquire = false))
        assertEquals(lease(me, 4), syncControl(api, ControlLease(), mayAcquire = true))
    }

    @Test
    fun leavesALiveForeignLeaseAlone() = runTest {
        val api = FakeControl({ lease("web") }, { fail(); lease(null) }, { conflict() })
        // Superseded: our heartbeat is rejected; the new holder is reported, never forced.
        assertEquals(lease("web"), syncControl(api, lease(me, 3), mayAcquire = true))
        assertEquals(listOf("control"), api.calls.filter { it == "control" || it == "acquire" })
    }

    @Test
    fun reportsTheWinnerOfARace() = runTest {
        var holder: String? = null
        val api = FakeControl({ lease(holder) }, { holder = "web"; conflict() }, { fail(); lease(null) })
        assertEquals(lease("web"), syncControl(api, ControlLease(), mayAcquire = true))
    }

    @Test
    fun keepsTheLeaseOnATransientFailureButNotADeadToken() = runTest {
        val flaky = FakeControl({ lease(null) }, { lease(null) }, { throw java.io.IOException("timeout") })
        assertNull(syncControl(flaky, lease(me, 3), mayAcquire = true))
        val revoked = FakeControl({ throw ApiException(401, "unauthenticated", "revoked") }, { lease(null) }, { lease(null) })
        try {
            syncControl(revoked, ControlLease(), mayAcquire = true)
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertTrue(error.unauthorized)
        }
    }

    @Test
    fun sendsCommandsAnswersAndUploadsLikeTheWeb() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val api = PircApi(Pairing(server.url("/").toString().trimEnd('/'), "pirc_dev_" + "e".repeat(43)))
            server.enqueue(MockResponse.Builder().code(200).body("""{"lease":{"clientId":"$me","generation":7,"expiresAt":99}}""").build())
            server.enqueue(MockResponse.Builder().code(202).body("""{"command":{"id":"c1","status":"accepted"},"duplicate":false}""").build())
            server.enqueue(MockResponse.Builder().code(503).body("""{"command":{"id":"c2","status":"rejected","error":"Node is offline"},"duplicate":false}""").build())
            server.enqueue(MockResponse.Builder().code(409).body("""{"error":{"code":"lost_control","message":"Another client holds control"}}""").build())
            server.enqueue(MockResponse.Builder().code(204).build())
            server.enqueue(MockResponse.Builder().code(201).body("""{"upload":{"id":"up1","mimeType":"image/png","byteSize":3}}""").build())

            val control = api.acquireControl("s1", me, force = true)
            assertEquals(ControlLease(me, true, false, 7, 99), control)
            assertEquals("""{"clientId":"$me","force":true}""", server.takeRequest().body!!.utf8())

            assertTrue(api.command("s1", me, 7, "c1", Commands.message("prompt", "hi", listOf("up1"))).accepted)
            val sent = PircJsonObject(server.takeRequest().body!!.utf8())
            assertEquals("""{"type":"prompt","message":"hi","uploadIds":["up1"]}""", sent["payload"].toString())
            assertEquals("7", sent["generation"].toString())

            // Not accepted: a receipt with the node's reason, not an exception.
            val rejected = api.command("s1", me, 7, "c2", Commands.simple("stop"))
            assertEquals("rejected" to "Node is offline", rejected.status to rejected.message)
            server.takeRequest()

            try {
                api.command("s1", me, 7, "c3", Commands.setThinking("high"))
                fail("expected ApiException")
            } catch (error: ApiException) {
                assertEquals("lost_control", error.code)
            }
            server.takeRequest()

            api.answer("s1", "i 1", me, 7, InteractionAnswer.Choices(listOf("a", "b")))
            val answer = server.takeRequest()
            assertEquals("/api/sessions/s1/interactions/i%201/answer", answer.url.encodedPath)
            assertEquals("""{"value":"a, b","values":["a","b"]}""", PircJsonObject(answer.body!!.utf8())["answer"].toString())

            assertEquals("up1", api.upload("s1", byteArrayOf(1, 2, 3), "image/png").id)
            val upload = server.takeRequest()
            assertEquals("image/png", upload.headers["Content-Type"])
            assertEquals(3L, upload.bodySize)
        }
    }

    private fun PircJsonObject(text: String): JsonObject = PircJson.parseToJsonElement(text).jsonObject
}
