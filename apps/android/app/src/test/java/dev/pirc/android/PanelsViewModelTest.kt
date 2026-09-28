package dev.pirc.android

import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.timeline.TimelineEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PanelsViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val api = FakeApi()

    @Before
    fun main() = Dispatchers.setMain(dispatcher)

    @After
    fun reset() = Dispatchers.resetMain()

    @Test
    fun mapsSectionsToTabs() {
        assertEquals(setOf(PanelTab.Memory, PanelTab.Tasks), tabsFor(listOf("memory", "team", "background", "other")))
        assertEquals(setOf(PanelTab.Git), tabsFor(listOf("git")))
    }

    @Test
    fun reloadsTheShownTabOnPanelChangesInsteadOfPolling() = runTest(dispatcher) {
        val model = PanelsViewModel(api, SESSION, ME, PanelTab.Memory, {}, cursor = { "$EPOCH:4" })
        model.start()
        runCurrent()
        assertEquals("events:$EPOCH:4", api.calls.first { it.startsWith("events") })
        val stream = api.streams.single()
        stream.trySend(StreamSignal.Connected)
        runCurrent()
        val loads = api.calls.count { it == "panel" }

        // Live: no polling.
        advanceTimeBy(12_000)
        assertEquals(loads, api.calls.count { it == "panel" })

        // A burst of changes is one reload; other sections are ignored.
        stream.trySend(StreamSignal.Event(envelope(5, TimelineEvent.PanelChanged(listOf("memory")))))
        stream.trySend(StreamSignal.Event(envelope(6, TimelineEvent.PanelChanged(listOf("memory")))))
        stream.trySend(StreamSignal.Event(envelope(7, TimelineEvent.PanelChanged(listOf("git")))))
        advanceTimeBy(1_000)
        assertEquals(loads + 1, api.calls.count { it == "panel" })

        // Dropped: polling again.
        stream.trySend(StreamSignal.Reconnecting)
        advanceTimeBy(5_001)
        assertEquals(loads + 2, api.calls.count { it == "panel" })
        model.stop()
    }

    @Test
    fun pollsWithoutAKnownCursor() = runTest(dispatcher) {
        val model = PanelsViewModel(api, SESSION, ME, PanelTab.Tasks, {})
        model.start()
        runCurrent()
        val loads = api.calls.count { it == "panel" }
        advanceTimeBy(10_001)
        assertEquals(loads + 2, api.calls.count { it == "panel" })
        assertEquals(0, api.streams.size)
        model.stop()
    }

    @Test
    fun asksTheFilesTabToReListWhenTheWorkspaceMayHaveChanged() = runTest(dispatcher) {
        val model = PanelsViewModel(api, SESSION, ME, PanelTab.Files, {}, cursor = { "$EPOCH:4" })
        var signals = 0
        backgroundScope.launch { model.filesChanged.collect { signals++ } }
        model.start()
        runCurrent()
        val stream = api.streams.single()
        stream.trySend(StreamSignal.Connected)
        runCurrent()
        val before = signals

        // A run ending (reset) and a Git change both reach the Files tab.
        stream.trySend(StreamSignal.Event(envelope(5, TimelineEvent.Reset("run_finished"))))
        advanceTimeBy(1_000)
        assertEquals(before + 1, signals)
        stream.trySend(StreamSignal.Event(envelope(6, TimelineEvent.PanelChanged(listOf("git")))))
        advanceTimeBy(1_000)
        assertEquals(before + 2, signals)

        // Memory changes do not.
        stream.trySend(StreamSignal.Event(envelope(7, TimelineEvent.PanelChanged(listOf("memory")))))
        advanceTimeBy(1_000)
        assertEquals(before + 2, signals)
        model.stop()
    }
}
