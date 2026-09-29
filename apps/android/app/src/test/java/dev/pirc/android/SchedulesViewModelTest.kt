package dev.pirc.android

import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Schedule
import dev.pirc.android.core.ScheduleDetail
import dev.pirc.android.core.ScheduleInput
import dev.pirc.android.core.ScheduleRun
import dev.pirc.android.core.ScheduleWorkspace
import dev.pirc.android.core.Workspace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SchedulesViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    private fun sample(id: String, attention: Int = 0) = Schedule(
        id = id,
        title = "Schedule $id",
        prompt = "Do it.",
        workspaceId = "work:test",
        workspace = ScheduleWorkspace("work:test", "Test", "directory", "work", true),
        cron = "0 9 * * *",
        timezone = "UTC",
        status = "active",
        attention = attention,
    )

    private val missed = ScheduleRun("r1", "s1", dueAt = 1, status = "missed")

    private inner class Api : FakeApi() {
        var list = listOf(sample("s1", attention = 1), sample("s2"))
        var refuse: ApiException? = null

        override suspend fun schedules(): List<Schedule> {
            calls += "schedules"
            return list
        }

        override suspend fun schedule(id: String): ScheduleDetail {
            calls += "schedule:$id"
            return ScheduleDetail(list.first { it.id == id }, listOf(missed))
        }

        override suspend fun workspaces() = listOf(
            Workspace("work:test", "work", "Test"),
            Workspace("local", "local", "Local"),
        )

        override suspend fun allModels() = emptyList<dev.pirc.android.core.ModelOption>()

        override suspend fun setScheduleStatus(id: String, status: String): Schedule {
            calls += "status:$id:$status"
            return list.first { it.id == id }
        }

        override suspend fun runSchedule(id: String, runId: String?): ScheduleRun {
            calls += "run:$id:$runId"
            return missed.copy(status = "running")
        }

        override suspend fun dismissRun(id: String, runId: String): ScheduleRun {
            calls += "dismiss:$id:$runId"
            return missed.copy(status = "dismissed")
        }

        override suspend fun deleteSchedule(id: String) {
            calls += "delete:$id"
            list = list.filterNot { it.id == id }
        }

        override suspend fun createSchedule(input: ScheduleInput): Schedule {
            calls += "create:${input.cron}"
            refuse?.let { throw it }
            return sample("s3").also { list = list + it }
        }
    }

    private val api = Api()

    @Before
    fun main() = Dispatchers.setMain(dispatcher)

    @After
    fun reset() = Dispatchers.resetMain()

    @Test
    fun pollsWhileShownAndCountsWhatWaits() = runTest(dispatcher) {
        val model = SchedulesViewModel(api) {}
        model.watch()
        runCurrent()
        assertEquals(listOf("s1", "s2"), model.state.value.schedules.map { it.id })
        assertEquals(1, model.state.value.attention)
        advanceTimeBy(15_001)
        assertEquals(2, api.calls.count { it == "schedules" })
        model.unwatch()
        advanceTimeBy(60_000)
        assertEquals(2, api.calls.count { it == "schedules" })
    }

    @Test
    fun opensOneWithItsRunsAndActsOnThem() = runTest(dispatcher) {
        val model = SchedulesViewModel(api) {}
        model.refresh()
        runCurrent()
        model.open("s1")
        runCurrent()
        assertEquals("s1", model.state.value.open?.id)
        assertEquals(listOf(missed), model.state.value.runs)

        model.allow("s1", "r1")
        runCurrent()
        // It reloads at once, and again shortly after (the run may have settled by then).
        val loads = api.calls.count { it == "schedules" }
        advanceTimeBy(2_001)
        assertEquals(loads + 1, api.calls.count { it == "schedules" })
        model.dismiss("s1", "r1")
        runCurrent()
        model.pause("s1")
        runCurrent()
        assertEquals(listOf("run:s1:r1", "dismiss:s1:r1", "status:s1:paused"), api.calls.filter { ':' in it && !it.startsWith("schedule:") })

        // Deleted: the detail closes.
        model.delete("s1") {}
        runCurrent()
        assertNull(model.state.value.openId)
        assertEquals(listOf("s2"), model.state.value.schedules.map { it.id })
    }

    @Test
    fun theFormOffersNodeWorkspacesAndShowsRefusals() = runTest(dispatcher) {
        val model = SchedulesViewModel(api) {}
        model.loadFormOptions()
        runCurrent()
        assertEquals(listOf("work:test"), model.state.value.workspaces.map { it.id })

        val input = ScheduleInput("work:test", "", "x", "bad", null, "UTC", null, null)
        api.refuse = ApiException(400, "invalid_input", "Invalid cron \"bad\"")
        var error: String? = null
        var saved: Schedule? = null
        model.save(null, input, onError = { error = it }, onDone = { saved = it })
        runCurrent()
        assertEquals("Invalid cron \"bad\"", error)
        assertNull(saved)

        api.refuse = null
        model.save(null, input.copy(cron = "0 9 * * *"), onError = { error = it }, onDone = { saved = it })
        runCurrent()
        assertEquals("s3", saved?.id)
        assertNull(model.state.value.busy)
    }

    @Test
    fun aDeadTokenUnpairs() = runTest(dispatcher) {
        val dead = ApiException(401, "unauthenticated", "Pair again.")
        val failing = object : FakeApi() {
            override suspend fun schedules(): List<Schedule> = throw dead
        }
        var unpaired: ApiException? = null
        val model = SchedulesViewModel(failing) { unpaired = it }
        model.refresh()
        runCurrent()
        assertEquals(dead, unpaired)
        assertEquals("Pair again.", model.state.value.error)
    }
}
