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
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.TerminalInfo
import dev.pirc.android.core.syncControl
import dev.pirc.android.core.timeline.TimelineEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
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

/** The tabs showing a `panel_changed` section (memory, background, team, git). */
internal fun tabsFor(sections: List<String>): Set<PanelTab> = sections.mapNotNullTo(HashSet()) { section ->
    when (section) {
        "memory" -> PanelTab.Memory
        "background", "team" -> PanelTab.Tasks
        "git" -> PanelTab.Git
        else -> null
    }
}

private const val POLL_MS = 5_000L
private const val SIGNAL_DEBOUNCE_MS = 300L

/**
 * Git, tasks, memory and terminals of one session, refreshed while visible:
 * on the session stream's `panel_changed` events (and run changes) when the
 * session's cursor is known, else by polling. Terminals are always polled.
 */
class PanelsViewModel(
    private val api: PircApi,
    val sessionId: String,
    clientId: String,
    initialTab: PanelTab,
    private val onUnauthorized: (ApiException) -> Unit,
    /** Where the session screen's stream stands; null: poll instead. */
    private val cursor: () -> String? = { null },
    private val events: (cursor: String) -> Flow<StreamSignal> = { api.events(sessionId, it) },
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

    private val _filesChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** The workspace may have changed (run ended, Git moved, pull): the Files tab re-lists its folder. */
    val filesChanged: SharedFlow<Unit> = _filesChanged.asSharedFlow()

    private var poll: Job? = null
    private var signals: Job? = null
    private var reloading: Job? = null

    /** The stream is connected, so tasks and memory need no polling. */
    @Volatile
    private var live = false

    fun select(tab: PanelTab) {
        _tab.value = tab
        refresh(tab, quiet = true)
    }

    /** Visible: keep control and follow the live tabs (tasks and memory change as the agent works). */
    fun start() {
        control.start()
        poll?.cancel()
        poll = viewModelScope.launch {
            refresh(_tab.value, quiet = true)
            while (isActive) {
                delay(POLL_MS)
                when (_tab.value) {
                    PanelTab.Tasks, PanelTab.Memory -> if (!live) loadPanel(quiet = true)
                    PanelTab.Terminal -> loadTerminals(quiet = true)
                    else -> Unit
                }
            }
        }
        signals?.cancel()
        live = false
        val from = cursor() ?: return
        signals = viewModelScope.launch {
            var connected = false
            events(from).collect { signal ->
                when (signal) {
                    StreamSignal.Connected -> {
                        live = true
                        // Anything may have changed while the stream was down.
                        if (connected) changed(PanelTab.entries.toSet())
                        connected = true
                    }
                    StreamSignal.Reconnecting -> live = false
                    is StreamSignal.Closed -> {
                        live = false
                        fail(signal.error)
                    }
                    is StreamSignal.Event -> when (val event = signal.envelope.event) {
                        // A Git change is a change to the workspace's files too.
                        is TimelineEvent.PanelChanged -> changed(tabsFor(event.sections).let { if (PanelTab.Git in it) it + PanelTab.Files else it })
                        // Run starts and ends, runner restarts: tasks, Git and files may have moved.
                        is TimelineEvent.Reset -> changed(setOf(PanelTab.Tasks, PanelTab.Memory, PanelTab.Git, PanelTab.Files))
                        else -> Unit
                    }
                }
            }
        }
    }

    /** Reload the shown tab if [tabs] covers it; a burst of signals is one reload. */
    private fun changed(tabs: Set<PanelTab>) {
        if (_tab.value !in tabs || reloading?.isActive == true) return
        reloading = viewModelScope.launch {
            delay(SIGNAL_DEBOUNCE_MS)
            refresh(_tab.value, quiet = true)
        }
    }

    fun stop() {
        control.stop()
        poll?.cancel()
        signals?.cancel()
        reloading?.cancel()
        live = false
    }

    fun refresh(tab: PanelTab = _tab.value, quiet: Boolean = false) {
        when (tab) {
            PanelTab.Files -> _filesChanged.tryEmit(Unit)
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

    /** Exited terminals hidden here without control; the node still lists them until someone closes them. */
    private val dismissedTerminals = HashSet<String>()

    private suspend fun loadTerminals(quiet: Boolean) = load(_terminals, quiet, "Could not list terminals.") {
        api.terminals(sessionId).filterNot { it.exited && it.id in dismissedTerminals }
    }

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

    /**
     * Take an exited terminal off the list. With control the node forgets it;
     * without, it is only hidden here (as on the web), since there is nothing left to stop.
     */
    fun removeExitedTerminal(terminal: TerminalInfo) {
        if (control.generation != null) return closeTerminal(terminal.id)
        dismissedTerminals += terminal.id
        (_terminals.value as? Loadable.Ready)?.let { ready -> _terminals.value = Loadable.Ready(ready.value.filterNot { it.id == terminal.id }) }
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
