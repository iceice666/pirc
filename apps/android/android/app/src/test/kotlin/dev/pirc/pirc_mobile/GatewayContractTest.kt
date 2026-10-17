package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import dev.pirc.android.core.timeline.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class GatewayContractTest {
    private val question = Interaction(id="q", runnerEpoch="epoch", kind="select", title="Continue?", expiresAt=1000,
        options=listOf(InteractionOption("a", "A"), InteractionOption("b", "B")))
    private fun state(q: Interaction = question) = SessionState(Session("s", "w", "Session"), "running", null,
        emptyList(), listOf(q), emptyList(), "cursor", "epoch")
    private fun refused(snapshot: SessionState, epoch: String = "epoch", data: Map<String, Any?> = mapOf("values" to listOf("a")), now: Long = 10) {
        try { checkedAnswer(snapshot, "q", epoch, data, now); fail("must reject without posting") }
        catch (e: ApiException) { assertTrue(e.status in 400..499) }
    }
    @Test fun matchingFreshQuestionCanBeAnswered() {
        assertTrue(checkedAnswer(state(), "q", "epoch", mapOf("values" to listOf("a")), 10) is InteractionAnswer.Choices)
    }
    @Test fun observedQuestionEpochMustMatchWhileDaemonCursorCanDiffer() {
        refused(state(), "old")
        assertTrue(checkedAnswer(state().copy(runnerEpoch="daemon-cursor"), "q", "epoch", mapOf("values" to listOf("a")), 10) is InteractionAnswer.Choices)
    }
    @Test fun completedAndExpiredQuestionsCannotBeAnswered() {
        refused(state(question.copy(status="answered")))
        refused(state(), now=1000)
        refused(state().copy(interactions=emptyList()))
    }
    @Test fun explicitAnswerReconciliationOnlyReturnsTheExactUnexpiredPendingQuestion() {
        val pending = answerReconciliation(state(), "s", "q", "epoch", 10)
        assertTrue(pending.pending)
        assertEquals(question, pending.interaction)

        assertFalse(answerReconciliation(state(question.copy(status="answered")), "s", "q", "epoch", 10).pending)
        assertFalse(answerReconciliation(state().copy(interactions=emptyList()), "s", "q", "epoch", 10).pending)
        assertFalse(answerReconciliation(state(question.copy(runnerEpoch="replacement")), "s", "q", "epoch", 10).pending)
        assertFalse(answerReconciliation(state(question.copy(expiresAt=10)), "s", "q", "epoch", 10).pending)
    }
    @Test fun explicitAnswerReconciliationRejectsAChangedSession() {
        try {
            answerReconciliation(state(), "different-session", "q", "epoch", 10)
            fail("must not reconcile another session")
        } catch (e: ApiException) {
            assertEquals(409, e.status)
            assertEquals("session_changed", e.code)
        }
    }
    @Test fun answerMutationAndRecoveryRequireTheCurrentOpaquePairingStamp() {
        requirePairingStamp("pair-a", "pair-a")
        for ((expected, actual) in listOf("pair-a" to "pair-b", "pair-a" to null, null to "pair-a")) {
            try {
                requirePairingStamp(expected, actual)
                fail("must reject a missing or stale pairing stamp")
            } catch (e: ApiException) {
                assertEquals(409, e.status)
                assertEquals("account_changed", e.code)
            }
        }
    }
    @Test fun selectionMustStillExistAndRespectSingleChoice() {
        refused(state(), data=mapOf("values" to listOf("gone")))
        refused(state(), data=mapOf("values" to listOf("a", "b")))
        refused(state(), data=mapOf("values" to listOf("a", "a")))
    }
    @Test fun cancellationAlsoRequiresFreshQuestion() {
        refused(state(question.copy(status="expired")), data=mapOf("cancelled" to true))
        assertEquals(InteractionAnswer.Cancel, checkedAnswer(state(), "q", "epoch", mapOf("cancelled" to true), 10))
    }
    @Test fun platformWireContainsCodecValuesAndPreservesBooleansAndNumbers() {
        val raw = mapOf("flag" to true, "generation" to 9007199254740992L, "nullable" to null, "nested" to listOf(mapOf("text" to "中文")))
        assertEquals(raw, raw.json().wire())
        val wire = state().wire()
        assertEquals("epoch", wire["runnerEpoch"])
        assertEquals("s", (wire["session"] as Map<*, *>)["id"])
        assertEquals("q", ((wire["interactions"] as List<*>).single() as Map<*, *>)["id"])
    }
    @Test fun delegationChoicesAndDeclineHaveTheWebAnswerShape() {
        val q = question.copy(kind="confirm", modelChoice=buildJsonObject {}, confirmLabel="Allow", cancelLabel="Decline")
        val choice = checkedAnswer(state(q), "q", "epoch", mapOf("confirmed" to true, "model" to mapOf("provider" to "p", "id" to "m"), "thinking" to "max"), 10)
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":true,"model":{"provider":"p","id":"m"},"thinking":"max"}"""), choice.rpc())
        val defaults = checkedAnswer(state(q), "q", "epoch", mapOf("confirmed" to true, "model" to null, "thinking" to null), 10)
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":true,"model":null,"thinking":null}"""), defaults.rpc())
        val decline = checkedAnswer(state(q), "q", "epoch", mapOf("confirmed" to false, "model" to null, "thinking" to "high"), 10)
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":false}"""), decline.rpc())
        refused(state(q),data=mapOf("confirmed" to true,"model" to mapOf("id" to "m")),now=10)
        refused(state(q),data=mapOf("confirmed" to true,"thinking" to "invalid"),now=10)
        val wire = q.wire()
        assertEquals("Allow",wire["confirmLabel"])
        assertEquals("Decline",wire["cancelLabel"])
        assertEquals(emptyMap<String,Any>(),wire["modelChoice"])
    }

    @Test fun delegatedUserRequestCheckboxIsOnlySentForAnOfferedConfirmedChoice() {
        val q = question.copy(
            kind = "confirm",
            userRequestChoice = UserRequestChoice("Treat this as my request", checked = false),
        )
        val selected = checkedAnswer(
            state(q), "q", "epoch",
            mapOf("confirmed" to true, "asUserRequest" to true),
            now = 10,
        )
        assertEquals(
            PircJson.parseToJsonElement("""{"confirmed":true,"asUserRequest":true}"""),
            selected.rpc(),
        )
        assertEquals(
            PircJson.parseToJsonElement("""{"confirmed":true}"""),
            InteractionAnswer.Confirm(true, asUserRequest = true).rpc(),
        )
        val declined = checkedAnswer(
            state(q), "q", "epoch",
            mapOf("confirmed" to false, "asUserRequest" to true),
            now = 10,
        )
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":false}"""), declined.rpc())

        val noChoice = checkedAnswer(
            state(q.copy(userRequestChoice = null)), "q", "epoch",
            mapOf("confirmed" to true, "asUserRequest" to true),
            now = 10,
        )
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":true}"""), noChoice.rpc())
    }

    @Test fun snapshotPreservesDelegationRequestMetadata() {
        val raw=PircJson.parseToJsonElement("""{"session":{"id":"s","workspaceId":"w","name":"Session","runnerEpoch":"epoch"},"interactions":[{"id":"q","runnerEpoch":"epoch","kind":"confirm","status":"pending","request":{"title":"Delegate?","confirmLabel":"Allow & run","cancelLabel":"Decline","modelChoice":{"model":{"provider":"p","id":"m"},"thinking":"high"},"userRequestChoice":{"label":"Treat as my request","checked":true}}}]}""")
        val q=snapshotState(raw).interactions.single()
        assertEquals("Allow & run",q.confirmLabel)
        assertEquals("Decline",q.cancelLabel)
        assertEquals(PircJson.parseToJsonElement("""{"model":{"provider":"p","id":"m"},"thinking":"high"}"""),q.modelChoice)
        assertEquals(UserRequestChoice("Treat as my request", true), q.userRequestChoice)
        assertEquals(mapOf("label" to "Treat as my request", "checked" to true), q.wire()["userRequestChoice"])
    }

    @Test fun memoryAnswerIsBoundToDisplayedTargetRevisionAndPreservesFullDescription() {
        val raw=PircJson.parseToJsonElement("""{"session":{"id":"s","workspaceId":"w","name":"Memory test"},"runnerEpoch":9,"messages":[],"interactions":[{"id":"memory:p:3","runnerEpoch":0,"kind":"confirm","status":"pending","request":{"title":"Replace USER memory?","message":"Current memory:\nold\n\nProposed memory:\nnew\n\nYour words:\nquoted","confirmLabel":"Approve","cancelLabel":"Reject"}}]}""")
        val state=snapshotState(raw)
        val q=state.interactions.single()
        assertEquals("0",q.runnerEpoch)
        assertEquals("Current memory:\nold\n\nProposed memory:\nnew\n\nYour words:\nquoted",q.wire()["description"])
        assertEquals("Approve",q.wire()["confirmLabel"])
        assertEquals("Reject",q.wire()["cancelLabel"])
        try { checkedAnswer(state,"memory:p:2","0",mapOf("confirmed" to true)); fail("old target revision must not be submitted") }
        catch(e: ApiException) { assertEquals(409,e.status) }
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":false}"""), checkedAnswer(state,"memory:p:3","0",mapOf("confirmed" to false)).rpc())
    }

}
