package dev.pirc.android.core

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
        }
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
