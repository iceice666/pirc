package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.Schedule
import dev.pirc.android.core.ScheduleInput
import dev.pirc.android.core.ScheduleRun
import dev.pirc.android.core.Workspace
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

/** How often the visible schedules reload: runs start, finish and wait meanwhile. */
private const val POLL_MS = 15_000L

/** One more reload this long after an action. */
private const val FOLLOW_UP_MS = 2_000L

data class SchedulesState(
    val schedules: List<Schedule> = emptyList(),
    val loading: Boolean = true,
    /** Why the list could not load; the last list stays. */
    val error: String? = null,
    /** The schedule shown in detail, and its runs (newest first). */
    val openId: String? = null,
    val runs: List<ScheduleRun> = emptyList(),
    /** Key of the action in flight; one at a time. */
    val busy: String? = null,
    /** Node workspaces a schedule may run in, and the models it may pick. */
    val workspaces: List<Workspace> = emptyList(),
    val models: List<ModelOption> = emptyList(),
) {
    val open get() = schedules.firstOrNull { it.id == openId }
    val attention get() = schedules.sumOf { it.attention }
}

/**
 * Scheduled tasks (plans/cron.md): list, open with their runs, make, change,
 * pause, run now, delete; allow or dismiss missed runs. A device gets no push
 * about schedules, so the shown screen polls.
 */
class SchedulesViewModel(
    private val api: PircApi,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow(SchedulesState())
    val state: StateFlow<SchedulesState> = _state.asStateFlow()

    /** A failed action, shown once. */
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private var watching: Job? = null

    fun dismissMessage() {
        _message.value = null
    }

    /** On screen: load, then keep current. */
    fun watch() {
        watching?.cancel()
        watching = viewModelScope.launch {
            launch { Connectivity.regained.collect { load() } }
            while (isActive) {
                load()
                delay(POLL_MS)
            }
        }
    }

    fun unwatch() {
        watching?.cancel()
        watching = null
    }

    fun refresh() {
        _state.value = _state.value.copy(loading = true)
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        try {
            val schedules = api.schedules()
            _state.value = _state.value.copy(schedules = schedules, loading = false, error = null)
            val open = _state.value.openId
            if (open != null && schedules.none { it.id == open }) close() else if (open != null) loadRuns(open)
        } catch (error: IOException) {
            (error as? ApiException)?.takeIf { it.unauthorized }?.let(onUnauthorized)
            _state.value = _state.value.copy(
                loading = false,
                error = if (!Connectivity.online.value) "You're offline. The list may be out of date." else error.message ?: "Network error",
            )
        }
    }

    private suspend fun loadRuns(id: String) {
        try {
            val detail = api.schedule(id)
            if (_state.value.openId == id) {
                val schedules = _state.value.schedules.map { if (it.id == id) detail.schedule else it }
                _state.value = _state.value.copy(schedules = schedules, runs = detail.runs)
            }
        } catch (error: IOException) {
            (error as? ApiException)?.takeIf { it.unauthorized }?.let(onUnauthorized)
        }
    }

    fun open(id: String) {
        _state.value = _state.value.copy(openId = id, runs = emptyList())
        viewModelScope.launch { loadRuns(id) }
    }

    fun close() {
        _state.value = _state.value.copy(openId = null, runs = emptyList())
    }

    /** What the form offers: node workspaces and the gateway's models. */
    fun loadFormOptions() {
        viewModelScope.launch {
            try {
                val workspaces = api.workspaces().filter { it.id.contains(':') }.sortedBy { it.displayName.lowercase() }
                val models = runCatching { api.allModels() }.getOrDefault(_state.value.models)
                _state.value = _state.value.copy(workspaces = workspaces, models = models)
            } catch (error: IOException) {
                (error as? ApiException)?.takeIf { it.unauthorized }?.let(onUnauthorized)
            }
        }
    }

    /** Run one change, then reload (the gateway's view is the truth). */
    private fun act(key: String, fallback: String, action: suspend () -> Unit) {
        if (_state.value.busy != null) return
        _state.value = _state.value.copy(busy = key)
        _message.value = null
        viewModelScope.launch {
            try {
                action()
            } catch (error: IOException) {
                (error as? ApiException)?.takeIf { it.unauthorized }?.let(onUnauthorized)
                _message.value = (error as? ApiException)?.message ?: fallback
            } finally {
                _state.value = _state.value.copy(busy = null)
                load()
            }
            // A started run usually settles (or fails) within seconds: show it without waiting for the poll.
            delay(FOLLOW_UP_MS)
            load()
        }
    }

    fun pause(id: String) = act(id, "Could not pause the schedule.") { api.setScheduleStatus(id, "paused") }

    fun resume(id: String) = act(id, "Could not resume the schedule.") { api.setScheduleStatus(id, "active") }

    fun runNow(id: String) = act(id, "Could not start the run.") { api.runSchedule(id) }

    /** Run a missed run now. */
    fun allow(id: String, runId: String) = act(runId, "Could not start the run.") { api.runSchedule(id, runId) }

    fun dismiss(id: String, runId: String) = act(runId, "Could not dismiss the run.") { api.dismissRun(id, runId) }

    fun delete(id: String, onDone: () -> Unit) = act(id, "Could not delete the schedule.") {
        api.deleteSchedule(id)
        close()
        onDone()
    }

    /**
     * Create ([id] null) or change a schedule. On success [onDone] gets it; a
     * refusal (a bad cron, a past time) goes to [onError] for the form to show.
     */
    fun save(id: String?, input: ScheduleInput, onError: (String) -> Unit, onDone: (Schedule) -> Unit) {
        if (_state.value.busy != null) return
        _state.value = _state.value.copy(busy = "save")
        viewModelScope.launch {
            try {
                val saved = if (id == null) api.createSchedule(input) else api.updateSchedule(id, input)
                onDone(saved)
            } catch (error: IOException) {
                (error as? ApiException)?.takeIf { it.unauthorized }?.let(onUnauthorized)
                onError((error as? ApiException)?.message ?: "Could not save the schedule.")
            } finally {
                _state.value = _state.value.copy(busy = null)
                load()
            }
        }
    }

    override fun onCleared() {
        unwatch()
    }
}
