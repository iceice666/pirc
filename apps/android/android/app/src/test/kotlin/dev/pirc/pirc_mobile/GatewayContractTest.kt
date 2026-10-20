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
    private val relayedSnapshot = PircJson.parseToJsonElement("""{"session":{"id":"chat","workspaceId":"w","name":"Chat","runnerEpoch":"4"},"watermark":{"epoch":"4","sequence":2},
        "interactions":[{"id":"relay.d1.interaction_7","rpcId":"relay.d1.interaction_7","sessionId":"chat","runnerEpoch":0,"kind":"confirm","status":"pending",
          "request":{"method":"confirm","title":"Run rm -rf build?","message":"Auto mode stopped a dangerous command","confirmLabel":"Allow",
            "relayed":{"sessionId":"delegated","sessionName":"Fix build","workspace":"repo on mac","delegationId":"d1"}},"createdAt":1}],
        "delegations":[{"id":"d1","title":"Fix build","workspace":"repo on mac","status":"waiting_input","dispatch":"auto","targetSessionId":"delegated"},
          {"id":"d2","title":"Done","workspace":"x","status":"completed","targetSessionId":"t"},
          {"id":"d3","title":"No target","workspace":"x","status":"running"},
          {"id":"d4","title":"Approved","workspace":"lib on pi","status":"running","targetSessionId":"t4"}]}""")

    @Test fun snapshotParsesRelayedApprovalsAndActiveDelegations() {
        val state = snapshotState(relayedSnapshot)
        val q = state.interactions.single()
        assertEquals(RelayedFrom("delegated", "Fix build", "repo on mac", "d1"), q.relayed)
        assertEquals("0", q.runnerEpoch)
        assertEquals(
            mapOf("sessionId" to "delegated", "sessionName" to "Fix build", "workspace" to "repo on mac", "delegationId" to "d1"),
            q.wire()["relayed"],
        )
        // Malformed or finished delegations are dropped, as on the web.
        assertEquals(
            listOf(
                ChatDelegation("d1", "Fix build", "repo on mac", "waiting_input", "auto", "delegated"),
                ChatDelegation("d4", "Approved", "lib on pi", "running", "approved", "t4"),
            ),
            state.delegations,
        )
        assertEquals(listOf("d1", "d4"), (state.wire()["delegations"] as List<*>).map { (it as Map<*, *>)["id"] })
        // An ordinary question has no relay, and older snapshots no delegations.
        assertNull(question.wire()["relayed"])
        assertEquals(emptyList<Any>(), state().wire()["delegations"])
    }

    @Test fun delegationsChangedReplacesTheListWithoutASnapshot() {
        val state = snapshotState(relayedSnapshot)
        val event = normalizeEvent(PircJson.parseToJsonElement("""{"type":"delegations_changed","sessionId":"chat","epoch":"4","sequence":3,
            "data":{"delegations":[{"id":"d4","title":"Approved","workspace":"lib on pi","status":"running","dispatch":"approved","targetSessionId":"t4"}]}}"""))
        val next = state.reduce(event)
        assertFalse(next.needsSnapshot)
        assertEquals(listOf("d4"), next.delegations.map { it.id })
        assertEquals("4:3", next.cursor)
        val cleared = next.reduce(normalizeEvent(PircJson.parseToJsonElement(
            """{"type":"delegations_changed","sessionId":"chat","epoch":"4","sequence":4,"data":{"delegations":[]}}""")))
        assertEquals(emptyList<ChatDelegation>(), cleared.delegations)
    }

    @Test fun relayedConfirmIsCheckedLikeAnyOtherAndAnswersWithConfirmedOnly() {
        val state = snapshotState(relayedSnapshot)
        val id = "relay.d1.interaction_7"
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":true}"""), checkedAnswer(state, id, "0", mapOf("confirmed" to true)).rpc())
        assertEquals(PircJson.parseToJsonElement("""{"confirmed":false}"""), checkedAnswer(state, id, "0", mapOf("confirmed" to false)).rpc())
        try { checkedAnswer(state, id, "4", mapOf("confirmed" to true)); fail("the relay's own epoch must match") }
        catch (e: ApiException) { assertEquals(409, e.status) }
    }

    @Test fun relayedAnswersNeverAcquireTheControlLease() = kotlinx.coroutines.runBlocking {
        var acquisitions = 0
        val acquire: suspend () -> Long = { acquisitions++; 7L }
        assertNull(answerGeneration("relay.d1.interaction_7", acquire))
        assertEquals(0, acquisitions)
        assertEquals(7L, answerGeneration("interaction_7", acquire))
        assertEquals(7L, answerGeneration("memory:p:3", acquire))
        assertEquals(2, acquisitions)
        assertTrue(isRelayedInteraction("relay.x"))
        assertFalse(isRelayedInteraction("interaction_relay.x"))
    }

}
