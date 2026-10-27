package dev.pirc.android.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress

class ConversationEnvironmentTest {
    private val raw = """{"version":1,"sessionId":"same-id","binding":{"version":1,"membership":{"revision":2,"legacyWorkspaceId":"node:project"},"execution":{"generation":7,"workspaceId":"node:project","nodeId":"node","modeId":"research"}},"project":{"revision":3,"workspaceId":"node:project","resolution":"member"},"modePolicy":{"revision":4,"definition":{"id":"research","projects":true}},"workspacePolicy":{"revision":5,"capabilities":{"version":1,"delegation":true,"memory_search":true,"remote_recall":false,"schedules":true,"web_search":true,"delegation_approval":"always"}},"enforcement":"not_tracked"}"""
    @Test fun readsIndependentVersionsAndPreservesUnavailableProject() {
        val value = PircJson.decodeFromString<ConversationEnvironment>(raw)
        assertEquals(3L, value.project.revision)
        assertEquals(7L, value.binding.execution.generation)
        assertEquals(4L, value.modePolicy!!.revision)
        assertEquals("not_tracked", value.enforcement)
        val missing = raw.replace("\"resolution\":\"member\"", "\"resolution\":\"mode_unavailable\"")
            .replace("\"definition\":{\"id\":\"research\",\"projects\":true}", "\"definition\":null")
        assertEquals("node:project", PircJson.decodeFromString<ConversationEnvironment>(missing).project.workspaceId)
    }
    @Test fun rejectsUnknownVersionsMismatchedScopesAndClaimedEnforcement() {
        for (invalid in listOf(
            raw.replaceFirst("\"version\":1", "\"version\":2"),
            raw.replace("\"enforcement\":\"not_tracked\"", "\"enforcement\":\"ready\""),
            raw.replace("\"revision\":3", "\"revision\":0"),
            raw.replace("\"revision\":5", "\"revision\":9007199254740992"),
            raw.replace("\"resolution\":\"member\"", "\"resolution\":\"none\""),
            raw.replace("\"id\":\"research\"", "\"id\":\"other\""),
            raw.replace("\"web_search\":true", "\"web_search\":\"true\""),
        )) assertTrue(invalid, runCatching {PircJson.decodeFromString<ConversationEnvironment>(invalid)}.isFailure)
    }
    @Test fun nativeApiReadsDirectlyWithDeviceTokenAndRejectsWrongSession() = runBlocking {
        val server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0)
        val token="pirc_dev_"+"b".repeat(43)
        val requests=java.util.concurrent.CopyOnWriteArrayList<List<String?>>()
        server.createContext("/") { exchange ->
            requests.add(listOf(exchange.requestMethod,exchange.requestURI.rawPath,exchange.requestHeaders.getFirst("Authorization"),exchange.requestHeaders.getFirst("Origin")))
            val bytes=raw.toByteArray();exchange.sendResponseHeaders(200,bytes.size.toLong());exchange.responseBody.use {it.write(bytes)}
        }
        server.start()
        try {
            val api=PircApi(Pairing("http://127.0.0.1:${server.address.port}",token))
            assertEquals("same-id",api.environment("same-id").sessionId)
            val error=runCatching { api.environment("another /+") }.exceptionOrNull()
            assertTrue(error is ApiException && error.code == "bad_reply")
            assertEquals(listOf("GET","/api/sessions/same-id/environment","Bearer $token",null),requests[0])
            assertEquals("/api/sessions/another%20%2F%2B/environment",requests[1][1])
            assertEquals(2,requests.size)
        } finally {server.stop(0)}
    }
}
