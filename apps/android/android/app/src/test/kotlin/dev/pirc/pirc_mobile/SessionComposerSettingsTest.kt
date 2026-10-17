package dev.pirc.pirc_mobile

import dev.pirc.android.core.Session
import dev.pirc.android.core.timeline.Message
import dev.pirc.android.core.timeline.SessionState
import org.junit.Assert.*
import org.junit.Test

class SessionComposerSettingsTest {
    private fun snapshot(model: String = "old", thinking: String = "medium") = SessionState(
        Session("s", "w", "Session"), "idle", null,
        listOf(Message("m", "user", "draft already sent", 1000L)),
        emptyList(), emptyList(), "cursor-7", "epoch-1",
        selectedModelId = model, selectedModelProvider = "provider", thinkingLevel = thinking,
    )

    @Test fun acceptanceWinsOverFetchStartedBeforeTheCommand() {
        val settings = SessionComposerSettings()
        val requestRevision = settings.revision
        val before = snapshot()
        assertTrue(settings.accepted(mapOf("type" to "set_model", "provider" to "local", "modelId" to "new")))
        val merged = settings.mergeFetched(before, requestRevision)
        assertEquals("new", merged.selectedModelId)
        assertEquals("local", merged.selectedModelProvider)
        assertEquals("medium", merged.thinkingLevel)
        assertSame(before.messages, merged.messages)
        assertEquals(before.cursor, merged.cursor)
        assertEquals(before.runnerEpoch, merged.runnerEpoch)
    }

    @Test fun laterFetchRemainsAuthoritativeIncludingRemoteSettings() {
        val settings = SessionComposerSettings()
        settings.accepted(mapOf("type" to "set_model", "provider" to "local", "modelId" to "picked"))
        settings.accepted(mapOf("type" to "set_thinking", "level" to "high"))
        val remote = snapshot("remote", "low")
        assertEquals(remote, settings.mergeFetched(remote, settings.revision))
    }

    @Test fun eachPreferenceMergesOnlyWhenItChangedDuringThatFetch() {
        val settings = SessionComposerSettings()
        settings.accepted(mapOf("type" to "set_model", "provider" to "local", "modelId" to "picked"))
        val requestRevision = settings.revision
        settings.accepted(mapOf("type" to "set_thinking", "level" to "high"))
        val merged = settings.mergeFetched(snapshot("remote"), requestRevision)
        assertEquals("remote", merged.selectedModelId)
        assertEquals("provider", merged.selectedModelProvider)
        assertEquals("high", merged.thinkingLevel)
    }

    @Test fun newestAcceptedChoiceWinsWhileUnrelatedPayloadsAreIgnored() {
        val settings = SessionComposerSettings()
        val requestRevision = settings.revision
        settings.accepted(mapOf("type" to "set_model", "provider" to "local", "modelId" to "first"))
        settings.accepted(mapOf("type" to "set_model", "provider" to "local", "modelId" to "second"))
        assertEquals("second", settings.mergeFetched(snapshot(), requestRevision).selectedModelId)
        val revision = settings.revision
        assertFalse(settings.accepted(mapOf("type" to "set_model", "modelId" to "missing-provider")))
        assertFalse(settings.accepted(mapOf("type" to "set_thinking", "level" to "unsupported")))
        assertFalse(settings.accepted(mapOf("type" to "prompt", "message" to "hello")))
        assertEquals(revision, settings.revision)
    }

    @Test fun acceptedApprovalModeWinsOnlyOverSnapshotsAlreadyInFlight() {
        val settings = SessionComposerSettings()
        val requestRevision = settings.revision
        assertTrue(settings.accepted(mapOf("type" to "set_approval_mode", "mode" to "full-access")))
        val staleSnapshot = snapshot().copy(approvalMode = "auto", defaultApprovalMode = "read-only")
        val mergedStale = settings.mergeFetched(staleSnapshot, requestRevision)
        assertEquals("full-access", mergedStale.approvalMode)
        assertEquals("read-only", mergedStale.defaultApprovalMode)

        val laterSnapshot = snapshot().copy(approvalMode = "read-only", defaultApprovalMode = "auto")
        assertEquals(laterSnapshot, settings.mergeFetched(laterSnapshot, settings.revision))
    }

    @Test fun liveApprovalModeChangeSupersedesAcceptedCacheAndLaterFetches() {
        val settings = SessionComposerSettings()
        val requestRevision = settings.revision
        assertTrue(settings.accepted(mapOf("type" to "set_approval_mode", "mode" to "full-access")))
        val beforeLiveEvent = settings.revision
        assertTrue(settings.authoritativeApprovalMode("read-only"))

        val inFlight = snapshot().copy(approvalMode = "auto")
        assertEquals("read-only", settings.mergeFetched(inFlight, beforeLiveEvent).approvalMode)
        val later = snapshot().copy(approvalMode = "auto")
        assertEquals("auto", settings.mergeFetched(later, settings.revision).approvalMode)
        assertTrue(requestRevision < settings.revision)
        assertFalse(settings.authoritativeApprovalMode("untrusted"))
    }
    @Test fun lateApprovalReceiptCannotOverrideAnAuthoritativeLiveMode() {
        val settings = SessionComposerSettings()
        val observed = settings.approvalObservationRevision
        assertTrue(settings.authoritativeApprovalMode("read-only"))
        val revision = settings.revision
        assertFalse(settings.accepted(mapOf("type" to "set_approval_mode", "mode" to "full-access"), observed))
        assertEquals(revision, settings.revision)
        assertEquals("read-only", settings.mergeFetched(snapshot().copy(approvalMode = "auto"), 0).approvalMode)
    }

    @Test fun lateApprovalReceiptCannotOverrideAFetchedSnapshotEvenWithTheSameMode() {
        val settings = SessionComposerSettings()
        val observed = settings.approvalObservationRevision
        settings.observedApprovalSnapshot("auto")
        assertFalse(settings.accepted(mapOf("type" to "set_approval_mode", "mode" to "full-access"), observed))
        assertEquals("auto", settings.mergeFetched(snapshot().copy(approvalMode = "auto"), 0).approvalMode)
    }

    @Test fun aNewCommandAfterTheAuthoritativeObservationCanStillProjectItsAcceptance() {
        val settings = SessionComposerSettings()
        settings.authoritativeApprovalMode("read-only")
        val observed = settings.approvalObservationRevision
        val revision = settings.revision
        assertTrue(settings.accepted(mapOf("type" to "set_approval_mode", "mode" to "auto"), observed))
        assertEquals("auto", settings.mergeFetched(snapshot().copy(approvalMode = "read-only"), revision).approvalMode)
    }

}
