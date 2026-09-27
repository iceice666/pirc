package dev.pirc.android.core

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionGroupsTest {
    /** A `GET /api/sessions` reply as the gateway sends it, including fields the app ignores. */
    private val json = """
        {"sessions":[
          {"id":"s1","workspaceId":"m5pro:pirc","nodeId":"m5pro","name":"Old","nameSource":"user","runnerState":"ready","runStatus":"succeeded","runnerEpoch":2,"pinnedAt":null,"settledAt":null,"createdAt":1,"updatedAt":100},
          {"id":"s2","workspaceId":"m5pro:pirc","nodeId":"m5pro","name":"Pinned","nameSource":"auto","runnerState":"ready","runStatus":null,"runnerEpoch":0,"pinnedAt":5,"settledAt":null,"createdAt":1,"updatedAt":50},
          {"id":"s3","workspaceId":"m5pro:pirc","nodeId":"m5pro","name":"Done","nameSource":"user","runnerState":"stopped","runStatus":"succeeded","runnerEpoch":0,"pinnedAt":null,"settledAt":9,"createdAt":1,"updatedAt":400},
          {"id":"s4","workspaceId":"m3air:notes","nodeId":"m3air","name":"Fresh","nameSource":"user","runnerState":"ready","runStatus":"running","runnerEpoch":1,"pinnedAt":null,"settledAt":null,"createdAt":1,"updatedAt":300},
          {"id":"s5","workspaceId":"m5pro:pirc","nodeId":"m5pro","name":"Newer","nameSource":"user","runnerState":"ready","runnerEpoch":1,"createdAt":1,"updatedAt":200}
        ]}
    """.trimIndent()

    @Test
    fun groupsLikeTheWebSidebar() {
        val sessions = PircJson.decodeFromString<SessionsResponse>(json).sessions
        val groups = groupSessions(
            sessions,
            workspaces = listOf(Workspace("m5pro:pirc", "m5pro", "pirc")),
            nodes = listOf(NodeSummary("m5pro", workspaces = listOf(NodeWorkspace("pirc", "pirc")))),
        )
        // Latest activity first, counting settled sessions.
        assertEquals(listOf("m5pro:pirc", "m3air:notes"), groups.map { it.workspaceId })
        val pirc = groups[0]
        assertEquals(listOf("s2", "s5", "s1"), pirc.open.map { it.id })
        assertEquals(listOf("s3"), pirc.settled.map { it.id })
        assertEquals(true, pirc.online)
        // Unknown workspace: title and node come from the ID; its node is offline.
        assertEquals(Triple("notes", "m3air", false), groups[1].let { Triple(it.title, it.node, it.online) })
        assertEquals("running", groups[1].open.single().runStatus)
    }
}
