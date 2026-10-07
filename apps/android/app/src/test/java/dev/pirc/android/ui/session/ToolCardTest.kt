package dev.pirc.android.ui.session

import dev.pirc.android.core.timeline.Interaction
import dev.pirc.android.core.timeline.ToolCall
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ToolCardTest {
    private val script = ToolCall(
        id = "p1",
        name = "ptc",
        input = buildJsonObject { put("code", JsonPrimitive("await tools.read({ path: 'a' })")) },
        operations = listOf(
            ToolCall(id = "p1:op1", name = "read", status = "succeeded"),
            ToolCall(id = "p1:op2", name = "read", status = "succeeded"),
            ToolCall(id = "p1:op3", name = "edit", status = "running"),
        ),
    )

    @Test
    fun aScriptReadsAsWhatItDidNotItsSource() {
        assertEquals("Script", toolTitle(script))
        assertEquals("read ×2, edit", toolSummary(script))
        val docs = ToolCall(id = "d", name = "ptc_docs", input = buildJsonObject { put("names", JsonArray(listOf(JsonPrimitive("read"), JsonPrimitive("edit")))) })
        assertEquals("Capability docs", toolTitle(docs))
        assertEquals("read, edit", toolSummary(docs))
        assertEquals("index", toolSummary(docs.copy(input = buildJsonObject {})))
    }

    @Test
    fun anOperationShowsTheApprovalItWaitsFor() {
        val edit = script.operations[2]
        val confirm = Interaction(id = "i", runnerEpoch = "1", kind = "confirm", title = "Allow?", toolCallId = "p1:op3")
        assertEquals("Waiting for approval", waitingLabel(edit, listOf(confirm)))
        assertEquals("Waiting for your answer", waitingLabel(edit, listOf(confirm.copy(kind = "select"))))
        assertNull(waitingLabel(script.operations[0], listOf(confirm.copy(toolCallId = "p1:op1"))))
        assertNull(waitingLabel(edit, listOf(confirm.copy(toolCallId = "other"))))
        assertNull(waitingLabel(edit, listOf(confirm.copy(status = "answered"))))
    }
}
