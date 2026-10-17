package dev.pirc.pirc_mobile

import dev.pirc.android.core.PushInteraction
import dev.pirc.android.core.PushNote
import dev.pirc.android.core.PushTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionNotificationIdentityTest {
    @Test fun exactIdentityRoundTripsAndChangesAcrossQuestionEpochs() {
        val identity = QuestionNotificationIdentity("session:1", "memory:proposal:3", "7")
        assertEquals(identity, QuestionNotificationIdentity.decode(identity.encoded))
        assertEquals("interaction:73657373696f6e3a31:7:6d656d6f72793a70726f706f73616c3a33", identity.notificationTag)
        assertEquals(identity.postedPreferenceKey, identity.copy().postedPreferenceKey)
        assertFalse(identity.postedPreferenceKey == identity.copy(interactionEpoch = "8").postedPreferenceKey)
        assertFalse(identity.postedPreferenceKey == identity.copy(interactionId = "memory:proposal:4").postedPreferenceKey)
        assertNull(QuestionNotificationIdentity.decode("bad"))
        assertNull(QuestionNotificationIdentity.from("s", "q", "07"))
        val delimiterA = QuestionNotificationIdentity("a:b", "c", "1")
        val delimiterB = QuestionNotificationIdentity("a", "b:1:c", "1")
        assertNotEquals(delimiterA.notificationTag, delimiterB.notificationTag)
        assertNotEquals(delimiterA.resolvedPreferenceKey, delimiterB.resolvedPreferenceKey)
    }

    @Test fun snapshotCancelsOnlyStaleQuestionsInThatSession() {
        val answered = QuestionNotificationIdentity("s", "q1", "1")
        val stillPending = QuestionNotificationIdentity("s", "q2", "1")
        val replacement = QuestionNotificationIdentity("s", "q1", "2")
        val otherSession = QuestionNotificationIdentity("other", "q1", "1")

        val stale = staleQuestionNotifications(
            sessionId = "s",
            active = setOf(replacement, stillPending),
            posted = listOf(answered, stillPending, otherSession),
        )

        assertEquals(setOf(answered), stale)
    }

    @Test fun delayedCreateCannotResurrectResolvedTupleAndOldEpochCannotCancelReplacement() {
        val answered = QuestionNotificationIdentity("s", "q", "4")
        val replacement = answered.copy(interactionEpoch = "5")
        val tombstones = setOf(answered.resolvedPreferenceKey)

        assertEquals(
            CreatedQuestionDisposition.SUPPRESS,
            createdQuestionDisposition(tombstoned = answered.resolvedPreferenceKey in tombstones, snapshotAvailable = true, exactPending = true),
        )
        assertEquals(
            setOf(answered),
            staleQuestionNotifications("s", active = setOf(replacement), posted = listOf(answered, replacement)),
        )
        assertFalse(replacement.resolvedPreferenceKey in tombstones)
    }

    @Test fun busyOverlayOnlyCoalescesSameQuestionAndPairing() {
        val current = QuestionNotificationIdentity("s", "q", "4")

        assertTrue(sameQuestionOverlayRequest(current, "pair-a", current.copy(), "pair-a"))
        assertFalse(sameQuestionOverlayRequest(current, "pair-a", current.copy(interactionEpoch = "5"), "pair-a"))
        assertFalse(sameQuestionOverlayRequest(current, "pair-a", current.copy(), "pair-b"))
        assertFalse(sameQuestionOverlayRequest(null, "pair-a", current, "pair-a"))
        assertFalse(sameQuestionOverlayRequest(current, "pair-a", null, "pair-a"))
    }

    @Test fun delayedOverlayRevokeCannotStopReplacementQuestionOrPairing() {
        val revoked = QuestionNotificationIdentity("s", "q", "4")
        val replacement = revoked.copy(interactionEpoch = "5")

        assertTrue(sameQuestionOverlayTargetAtGeneration(revoked, "pair-a", revoked, "pair-a", 9L, 9L))
        assertFalse(sameQuestionOverlayTargetAtGeneration(replacement, "pair-a", revoked, "pair-a", 9L, 9L))
        assertFalse(sameQuestionOverlayTargetAtGeneration(revoked, "pair-b", revoked, "pair-a", 9L, 9L))
        assertFalse(sameQuestionOverlayTargetAtGeneration(revoked, "pair-a", revoked, "pair-a", 9L, 10L))
    }

    @Test fun unavailableSnapshotDoesNotResolveOrAuthorizeAQuestion() {
        assertEquals(
            CreatedQuestionDisposition.SHOW_READ_ONLY,
            createdQuestionDisposition(tombstoned = false, snapshotAvailable = false, exactPending = null),
        )
        assertEquals(
            CreatedQuestionDisposition.RESOLVE,
            createdQuestionDisposition(tombstoned = false, snapshotAvailable = true, exactPending = false),
        )
    }

    @Test fun resolvedTombstonesStayBoundedAndExpireByAge() {
        val retained = pruneQuestionTombstones(
            tombstones = mapOf("old" to 1L, "a" to 90L, "b" to 95L, "c" to 100L, "future" to 200L),
            now = 100L,
            maxEntries = 3,
            maxAgeMillis = 20L,
        )

        assertEquals(mapOf("b" to 95L, "c" to 100L, "future" to 200L), retained)
    }

    @Test fun parsesExactCreatedAndAnsweredPushIdentityWithoutConfusingLegacyNotes() {
        val created = PushNote.parse(
            """{"title":"Waiting","body":"Reply","tag":"interaction:73:2:71","target":{"sessionId":"s"},"kind":"interaction_created","sessionId":"s","interactionId":"q","interactionEpoch":"2"}""".toByteArray(),
        )!!
        assertEquals(PushTarget.OpenSession("s"), created.target)
        assertEquals(PushInteraction("interaction_created", "s", "q", "2"), created.interaction)
        assertTrue(created.interaction!!.isCreated)

        val answered = PushNote.parse(
            """{"title":"","body":"","tag":"interaction:73:2:71","kind":"interaction_answered","sessionId":"s","interactionId":"q","interactionEpoch":"2"}""".toByteArray(),
        )!!
        assertTrue(answered.interaction!!.isResolved)
        assertEquals("", answered.title)

        val refresh = PushNote.parse(
            """{"title":"","tag":"session:s","kind":"interaction_refresh","sessionId":"s","target":{"sessionId":"s"}}""".toByteArray(),
        )!!
        assertTrue(refresh.isInteractionRefresh)

        val malformedAnswered = PushNote.parse(
            """{"title":"","tag":"interaction:73:07:71","kind":"interaction_answered","sessionId":"s","interactionId":"q","interactionEpoch":"07"}""".toByteArray(),
        )!!
        assertNull(malformedAnswered.interaction)

        val versionless = PushNote.parse(
            """{"title":"Legacy","tag":"session:s","target":{"sessionId":"s"},"kind":"interaction_answered","sessionId":"s","interactionId":"q"}""".toByteArray(),
        )!!
        assertNull(versionless.interaction)
    }
}
