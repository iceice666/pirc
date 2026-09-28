package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Commit
import dev.pirc.android.core.ControlApi
import dev.pirc.android.core.ControlLease
import dev.pirc.android.core.GitStatus
import dev.pirc.android.core.PanelState
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.TerminalInfo
import dev.pirc.android.core.syncControl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Keeps this client's control lease alive while a screen that acts on the
 * session is visible (the chat does the same on its own). Never forces except
 * on [take].
 */
class ControlKeeper(
    private val scope: CoroutineScope,
    private val api: PircApi,
    private val sessionId: String,
    private val clientId: String,
    private val onError: (IOException) -> Unit,
) {
    private val _lease = MutableStateFlow(ControlLease())
    val lease: StateFlow<ControlLease> = _lease.asStateFlow()
    private var loop: Job? = null

    private val control = object : ControlApi {
        override suspend fun control() = api.control(sessionId, clientId)
        override suspend fun acquire() = api.acquireControl(sessionId, clientId, force = false)
        override suspend fun heartbeat(generation: Long) = api.heartbeatControl(sessionId, clientId, generation)
    }

    fun start() {
        loop?.cancel()
        loop = scope.launch {
            while (isActive) {
                try {
                    syncControl(control, _lease.value, mayAcquire = true)?.let { _lease.value = it }
                } catch (error: IOException) {
                    onError(error)
                }
                delay(10_000)
            }
        }
    }

    fun stop() {
        loop?.cancel()
    }

    fun take() {
        scope.launch {
            try {
                _lease.value = api.acquireControl(sessionId, clientId, force = true)
            } catch (error: IOException) {
                onError(error)
            }
        }
    }

    /** The lease generation if this client holds control. */
    val generation get() = _lease.value.generation?.takeIf { _lease.value.heldByCurrentClient }
}

enum class PanelTab(val label: String) { Files("Files"), Git("Git"), Tasks("Tasks"), Memory("Memory"), Terminal("Terminal") }

/** Git, tasks, memory and terminals of one session, refreshed while visible. */
class PanelsViewModel(
    private val api: PircApi,
    val sessionId: String,
    clientId: String,
    initialTab: PanelTab,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    val control = ControlKeeper(viewModelScope, api, sessionId, clientId, ::fail)
    val clientId = clientId

    private val _tab = MutableStateFlow(initialTab)
    val tab: StateFlow<PanelTab> = _tab.asStateFlow()

    private val _panel = MutableStateFlow<Loadable<PanelState>>(Loadable.Loading)
    val panel: StateFlow<Loadable<PanelState>> = _panel.asStateFlow()

    private val _git = MutableStateFlow<Loadable<GitStatus>>(Loadable.Loading)
    val git: StateFlow<Loadable<GitStatus>> = _git.asStateFlow()

    data class History(val commits: List<Commit> = emptyList(), val more: Boolean = true, val loading: Boolean = false, val error: String? = null)

    private val _history = MutableStateFlow(History())
    val history: StateFlow<History> = _history.asStateFlow()

    private val _terminals = MutableStateFlow<Loadable<List<TerminalInfo>>>(Loadable.Loading)
    val terminals: StateFlow<Loadable<List<TerminalInfo>>> = _terminals.asStateFlow()

    private val _actionError = MutableStateFlow<String?>(null)
    val actionError: StateFlow<String?> = _actionError.asStateFlow()

    private var poll: Job? = null

    fun select(tab: PanelTab) {
        _tab.value = tab
        refresh(tab, quiet = true)
    }

    /** Visible: keep control and poll the live tabs (tasks and memory change as the agent works). */
    fun start() {
        control.start()
        poll?.cancel()
        poll = viewModelScope.launch {
            refresh(_tab.value, quiet = true)
            while (isActive) {
                delay(5_000)
                when (_tab.value) {
                    PanelTab.Tasks, PanelTab.Memory -> loadPanel(quiet = true)
                    PanelTab.Terminal -> loadTerminals(quiet = true)
                    else -> Unit
                }
            }
        }
    }

    fun stop() {
        control.stop()
        poll?.cancel()
    }

    fun refresh(tab: PanelTab = _tab.value, quiet: Boolean = false) {
        when (tab) {
            PanelTab.Files -> Unit
            PanelTab.Git -> viewModelScope.launch { loadGit(quiet) }
            PanelTab.Tasks, PanelTab.Memory -> viewModelScope.launch { loadPanel(quiet) }
            PanelTab.Terminal -> viewModelScope.launch { loadTerminals(quiet) }
        }
    }

    fun dismissActionError() {
        _actionError.value = null
    }

    private suspend fun <T> load(target: MutableStateFlow<Loadable<T>>, quiet: Boolean, fallback: String, fetch: suspend () -> T) {
        if (!quiet || target.value !is Loadable.Ready) target.value = Loadable.Loading
        target.value = try {
            Loadable.Ready(fetch())
        } catch (error: IOException) {
            fail(error)
            // A background refresh keeps what is shown.
            if (quiet && target.value is Loadable.Ready) return
            Loadable.Failed(error.message ?: fallback)
        }
    }

    private suspend fun loadPanel(quiet: Boolean) = load(_panel, quiet, "Could not load the panel.") { api.panelState(sessionId) }

    private suspend fun loadTerminals(quiet: Boolean) = load(_terminals, quiet, "Could not list terminals.") { api.terminals(sessionId) }

    private suspend fun loadGit(quiet: Boolean) {
        load(_git, quiet, "Could not read Git status.") { api.gitStatus(sessionId) }
        if (_history.value.commits.isEmpty() || !quiet) {
            _history.value = History()
            loadMoreHistory()
        }
    }

    fun loadMoreHistory() {
        val current = _history.value
        if (current.loading || !current.more) return
        _history.value = current.copy(loading = true, error = null)
        viewModelScope.launch {
            _history.value = try {
                val page = api.gitLog(sessionId, current.commits.size)
                History(current.commits + page.commits, page.more)
            } catch (error: IOException) {
                fail(error)
                current.copy(loading = false, error = error.message ?: "Could not load the history.")
            }
        }
    }

    fun stopTask(taskId: String) = act("The task could not be stopped.") { generation ->
        val task = api.stopBackground(sessionId, taskId, clientId, generation)
        val panel = (_panel.value as? Loadable.Ready)?.value ?: return@act
        _panel.value = Loadable.Ready(panel.copy(backgroundTasks = panel.backgroundTasks.map { if (it.id == task.id) task else it }))
    }

    fun createTerminal(onCreated: (TerminalInfo) -> Unit) = act("Could not open a terminal.") { generation ->
        val terminal = api.createTerminal(sessionId, clientId, generation, 80, 24)
        loadTerminals(quiet = true)
        onCreated(terminal)
    }

    fun closeTerminal(terminalId: String) = act("Could not close the terminal.") { generation ->
        api.closeTerminal(sessionId, terminalId, clientId, generation)
        loadTerminals(quiet = true)
    }

    private fun act(fallback: String, action: suspend (Long) -> Unit) {
        val generation = control.generation
        if (generation == null) {
            _actionError.value = "Take control of this session first."
            return
        }
        viewModelScope.launch {
            try {
                action(generation)
            } catch (error: IOException) {
                fail(error)
                _actionError.value = (error as? ApiException)?.message ?: fallback
            }
        }
    }

    private fun fail(error: IOException) {
        if (error is ApiException && error.unauthorized) onUnauthorized(error)
    }

    override fun onCleared() {
        stop()
    }
}
