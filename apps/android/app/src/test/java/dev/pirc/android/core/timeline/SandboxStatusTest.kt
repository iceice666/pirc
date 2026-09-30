package dev.pirc.android.core.timeline

import dev.pirc.android.core.PircJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SandboxStatusTest {
    private fun snapshot(sandbox: String) = snapshotState(
        PircJson.parseToJsonElement(
            """{"session":{"id":"s1","workspaceId":"n:w","name":"S","runnerState":"ready"},"history":[],""" +
                """"watermark":{"epoch":1,"sequence":0},"sandbox":$sandbox}""",
        ),
    )

    @Test
    fun readsTheSandboxFromTheSnapshot() {
        assertEquals(
            SandboxStatus(false, "srt is not installed"),
            snapshot("""{"active":false,"reason":"srt is not installed"}""").sandbox,
        )
        assertEquals(SandboxStatus(true), snapshot("""{"active":true}""").sandbox)
        assertNull(snapshot("null").sandbox)
    }
}
