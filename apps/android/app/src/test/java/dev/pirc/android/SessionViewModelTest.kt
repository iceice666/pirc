package dev.pirc.android

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.CommandReceipt
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.timeline.TimelineEvent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val api = FakeApi()
    private val drafts = MemoryDrafts()
    private val unauthorized = mutableListOf<ApiException>()
    private val cursors = HashMap<String, String>()

    @Before
    fun main() = Dispatchers.setMain(dispatcher)

    @After
    fun reset() = Dispatchers.resetMain()

    private val store = ViewModelStore()

    /** Kept in a store, so each test ends by clearing it (its heartbeat loop would run forever). */
    private fun viewModel(): SessionViewModel = ViewModelProvider.create(
        store,
        viewModelFactory { initializer { SessionViewModel(api, SESSION, ME, drafts, { unauthorized += it }, cursors) } },
    )[SessionViewModel::class]

    private fun test(body: suspend TestScope.() -> Unit) = runTest(dispatcher) {
        try {
            body()
        } finally {
            store.clear()
        }
    }

    /** Started, loaded, the stream live and control held (heartbeat loop left waiting). */
    private fun TestScope.live(): SessionViewModel {
        val model = viewModel()
        model.start()
        runCurrent()
        api.streams.last().trySend(StreamSignal.Connected)
        runCurrent()
        return model
    }

    private fun SessionViewModel.text() = state.value!!.messages.lastOrNull()?.content

    @Test
    fun loadsTheSnapshotAndFollowsFromItsCursor() = test {
        val model = live()
        assertEquals("Test", model.state.value!!.session.name)
        assertEquals(Connection.Live, model.connection.value)
        assertTrue(model.control.value.heldByCurrentClient)
        assertTrue("events:$EPOCH:0" in api.calls)
        assertEquals("$EPOCH:0", cursors[SESSION])
    }

    @Test
    fun anUnreadableSnapshotIsAnErrorNotACrash() = test {
        api.snapshotJson = """{"history":[]}"""
        val model = viewModel()
        model.start()
        runCurrent()
        assertNull(model.state.value)
        assertNotNull(model.error.value)
    }

    @Test
    fun batchesStreamedTextAndPublishesOtherEventsAtOnce() = test {
        val model = live()
        val stream = api.streams.last()
        stream.trySend(StreamSignal.Event(envelope(1, TimelineEvent.MessageDelta("Hel", thinking = false))))
        stream.trySend(StreamSignal.Event(envelope(2, TimelineEvent.MessageDelta("lo", thinking = false))))
        runCurrent()
        assertTrue(model.state.value!!.messages.isEmpty())

        advanceTimeBy(DELTA_BATCH_MS + 1)
        assertEquals("Hello", model.text())
        assertEquals("$EPOCH:2", model.state.value!!.cursor)

        // A delta still waiting is published before any other event applies.
        stream.trySend(StreamSignal.Event(envelope(3, TimelineEvent.MessageDelta("!", thinking = false))))
        stream.trySend(StreamSignal.Event(envelope(4, TimelineEvent.SessionRenamed("Renamed"))))
        runCurrent()
        assertEquals("Hello!", model.text())
        assertEquals("Renamed", model.state.value!!.session.name)
        assertEquals("$EPOCH:4", model.state.value!!.cursor)
    }

    @Test
    fun aDeltaFromAnotherEpochTakesANewSnapshot() = test {
        val model = live()
        api.streams.last().trySend(StreamSignal.Event(envelope(1, TimelineEvent.MessageDelta("x", thinking = false), epoch = "e2")))
        runCurrent()
        assertEquals(2, api.calls.count { it == "snapshot" })
        assertFalse(model.state.value!!.needsSnapshot)
    }

    @Test
    fun sendsAPromptAndClearsTheDraft() = test {
        val model = live()
        model.setDraft("hello")
        assertEquals("hello", drafts.saved[SESSION])
        model.send("  hello ")
        runCurrent()
        assertTrue(api.calls.any { it == "command:prompt:7" })
        assertEquals("", drafts.saved[SESSION])
        assertEquals("", model.draftResets.first())
        assertFalse(model.busy.value)
    }

    @Test
    fun ignoresASecondActionWhileBusy() = test {
        val model = live()
        api.commandGate = CompletableDeferred()
        model.send("one")
        runCurrent()
        assertTrue(model.busy.value)
        model.send("two")
        model.stopRun()
        runCurrent()
        assertEquals(1, api.calls.count { it.startsWith("command:") })
        api.commandGate!!.complete(Unit)
        runCurrent()
        assertFalse(model.busy.value)
    }

    @Test
    fun actingWithoutControlAsksToTakeIt() = test {
        api.lease = api.lease.copy(holderClientId = "web", heldByCurrentClient = false)
        val model = live()
        model.send("hello")
        runCurrent()
        assertEquals("Take control of this session first.", model.actionError.value)
        assertTrue(api.calls.none { it.startsWith("command:") })
    }

    @Test
    fun aLostLeaseIsReportedAndResynced() = test {
        val model = live()
        api.receipt = { throw ApiException(409, "lost_control", "Another client took control") }
        val before = api.calls.count { it.startsWith("heartbeat") || it == "control" }
        model.stopRun()
        runCurrent()
        assertEquals("Another client took control", model.actionError.value)
        assertTrue(api.calls.count { it.startsWith("heartbeat") || it == "control" } > before)
        assertFalse(model.busy.value)
    }

    @Test
    fun aRejectedCommandShowsTheNodesReason() = test {
        val model = live()
        api.receipt = { CommandReceipt("c", "rejected", "The agent is busy") }
        model.send("hi")
        runCurrent()
        assertEquals("The agent is busy", model.actionError.value)
        // The text stays in the composer for another try.
        assertNull(drafts.saved[SESSION])
        assertFalse(model.busy.value)
    }

    @Test
    fun aBriefStopKeepsTheStream() = test {
        val model = live()
        model.stop()
        advanceTimeBy(STOP_GRACE_MS / 2)
        model.start()
        runCurrent()
        assertEquals(1, api.streams.size)
        assertEquals(Connection.Live, model.connection.value)

        model.stop()
        advanceTimeBy(STOP_GRACE_MS + 1)
        assertEquals(Connection.Stopped, model.connection.value)
        model.start()
        runCurrent()
        assertEquals(2, api.streams.size)
    }

    @Test
    fun aDeadTokenOnTheStreamUnpairs() = test {
        val model = live()
        api.streams.last().trySend(StreamSignal.Closed(ApiException(401, "unauthenticated", "revoked")))
        runCurrent()
        assertEquals(1, unauthorized.size)
        assertEquals("revoked", model.error.value)
    }
}
