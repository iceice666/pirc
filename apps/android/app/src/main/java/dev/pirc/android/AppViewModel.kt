package dev.pirc.android

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.CredentialStore
import dev.pirc.android.core.InvalidPairingLink
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.LastSession
import dev.pirc.android.core.LocalStore
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PairingLink
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.PushTarget
import dev.pirc.android.push.PushRegistration
import dev.pirc.android.core.NodeSummary
import dev.pirc.android.core.Session
import dev.pirc.android.core.Workspace
import dev.pirc.android.core.WorkspaceGroup
import dev.pirc.android.core.groupSessions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/** How often the visible sessions list reloads (run states, node dots). */
private const val LIST_POLL_MS = 20_000L

sealed interface PairState {
    data object Idle : PairState
    data class Verifying(val origin: String) : PairState
    data class Failed(val message: String) : PairState
}

data class SessionsState(
    val groups: List<WorkspaceGroup> = emptyList(),
    val sessions: List<Session> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
    val nodes: List<NodeSummary> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
) {
    /** A workspace can take new sessions while its node is connected. */
    fun online(workspace: Workspace) = nodes.any { node -> node.workspaces.any { "${node.id}:${it.id}" == workspace.id } }
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val store: CredentialStore = KeystoreCredentialStore(application)
    val local = LocalStore(application)

    private val _pairing = MutableStateFlow<Pairing?>(null)
    val pairing: StateFlow<Pairing?> = _pairing.asStateFlow()

    /** The stored pairing has been read (the Keystore is slow on first use, so not on the main thread). */
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    /**
     * The newest event cursor seen per open session, so the side panels can
     * follow the same stream from there instead of replaying it all.
     */
    val cursors: MutableMap<String, String> = ConcurrentHashMap()

    private val _pairState = MutableStateFlow<PairState>(PairState.Idle)
    val pairState: StateFlow<PairState> = _pairState.asStateFlow()

    /** A pairing link opened from outside the app; it waits for the user's confirmation. */
    private val _pendingLink = MutableStateFlow<Pairing?>(null)
    val pendingLink: StateFlow<Pairing?> = _pendingLink.asStateFlow()

    private val _sessions = MutableStateFlow(SessionsState())
    val sessions: StateFlow<SessionsState> = _sessions.asStateFlow()

    /** Why the phone was unpaired, shown once on the pairing screen. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /** Scheduled runs waiting for you, shown on the list's menu. */
    private val _scheduleAttention = MutableStateFlow(0)
    val scheduleAttention: StateFlow<Int> = _scheduleAttention.asStateFlow()

    /** What a tapped notification asks to open; PircApp navigates, then clears it. */
    private val _pendingTarget = MutableStateFlow<PushTarget?>(null)
    val pendingTarget: StateFlow<PushTarget?> = _pendingTarget.asStateFlow()

    fun openTarget(target: PushTarget) {
        _pendingTarget.value = target
    }

    fun takeTarget(): PushTarget? = _pendingTarget.value.also { _pendingTarget.value = null }

    /** The schedule a notification was about, for the Schedules screen to open. */
    var focusSchedule by mutableStateOf<String?>(null)

    private var refreshJob: Job? = null
    private var watching: Job? = null

    /** The session open when the app was last closed, reopened once at launch. */
    private var restore: LastSession? = local.lastSession

    fun takeRestore(): LastSession? = restore.also { restore = null }

    init {
        Connectivity.start(application)
        PushRegistration.load(application)
        // The sessions screen refreshes itself when it appears.
        viewModelScope.launch {
            val stored = withContext(Dispatchers.IO) { store.load() }
            // A link confirmed meanwhile wins over what was stored.
            if (!_loaded.value) {
                _pairing.value = stored
                _loaded.value = true
            }
        }
    }

    private var cachedApi: PircApi? = null

    /** One client per pairing, so connections are pooled. */
    fun api(): PircApi? {
        val pairing = _pairing.value ?: return null
        cachedApi?.takeIf { it.pairing == pairing }?.let { return it }
        return PircApi(pairing).also { cachedApi = it }
    }

    /** A link from a deep link: never pairs without the user confirming the gateway. */
    fun offerLink(text: String) {
        try {
            _pendingLink.value = PairingLink.parse(text)
        } catch (error: InvalidPairingLink) {
            _pairState.value = PairState.Failed(error.message ?: "Invalid pairing link.")
        }
    }

    fun dismissLink() {
        _pendingLink.value = null
    }

    fun confirmLink() {
        val pairing = _pendingLink.value ?: return
        _pendingLink.value = null
        verify(pairing)
    }

    /** A link the user scanned or pasted in the app. */
    fun pair(text: String) {
        try {
            verify(PairingLink.parse(text))
        } catch (error: InvalidPairingLink) {
            _pairState.value = PairState.Failed(error.message ?: "Invalid pairing link.")
        }
    }

    private fun verify(pairing: Pairing) {
        _pairState.value = PairState.Verifying(pairing.baseUrl)
        _notice.value = null
        viewModelScope.launch {
            try {
                PircApi(pairing).sessions()
                withContext(Dispatchers.IO) { store.save(pairing) }
                val same = _pairing.value == pairing
                if (!same) closeApi()
                _pairing.value = pairing
                _loaded.value = true
                _pairState.value = PairState.Idle
                // A new pairing rebuilds the sessions screen, which loads itself.
                if (same) refresh() else _sessions.value = SessionsState()
            } catch (error: ApiException) {
                // A 401 carries the gateway's reason (expired, revoked, ...).
                _pairState.value = PairState.Failed(error.message ?: "The gateway refused the request.")
            } catch (error: IOException) {
                _pairState.value = PairState.Failed("Cannot reach ${pairing.baseUrl}: ${error.message ?: "network error"}")
            }
        }
    }

    /**
     * Reload the lists. [quiet] (polling, network back) keeps the pull
     * indicator hidden and leaves a running refresh alone.
     */
    fun refresh(quiet: Boolean = false) {
        val api = api() ?: return
        if (quiet && refreshJob?.isActive == true) return
        refreshJob?.cancel()
        if (!quiet) _sessions.value = _sessions.value.copy(loading = true)
        refreshJob = viewModelScope.launch {
            try {
                _sessions.value = coroutineScope {
                    val sessions = async { api.sessions() }
                    val workspaces = async { api.workspaces() }
                    val nodes = async { api.nodes() }
                    listed(sessions.await(), workspaces.await(), nodes.await())
                }
                local.pruneDrafts(_sessions.value.sessions.map { it.id })
                // Optional: an older gateway has no schedules, and the list must not fail for them.
                try {
                    _scheduleAttention.value = api.schedules().sumOf { it.attention }
                } catch (error: IOException) {
                    if (error is ApiException && error.unauthorized) throw error
                }
            } catch (error: IOException) {
                handle(error)
                // The last list stays; the error says it may be out of date.
                val message = if (!Connectivity.online.value) "You're offline. The list may be out of date."
                else error.message ?: "Network error"
                _sessions.value = _sessions.value.copy(loading = false, error = message)
            }
        }
    }

    /**
     * The sessions list is on screen: load it, then keep run states and node
     * dots current. The gateway pushes no list events to a device outside a
     * session, so it polls, and reloads at once when the network comes back.
     */
    fun watchSessions() {
        watching?.cancel()
        refresh()
        watching = viewModelScope.launch {
            launch { Connectivity.regained.collect { refresh(quiet = true) } }
            while (isActive) {
                delay(LIST_POLL_MS)
                refresh(quiet = true)
            }
        }
    }

    fun unwatchSessions() {
        watching?.cancel()
        watching = null
    }

    /** Retry from the list's error: streams waiting out a backoff try again too. */
    fun retry() {
        Connectivity.wake()
        refresh()
    }

    private fun listed(sessions: List<Session>, workspaces: List<Workspace>, nodes: List<NodeSummary>) = SessionsState(
        groups = groupSessions(sessions, workspaces, nodes),
        sessions = sessions,
        workspaces = workspaces,
        nodes = nodes,
        loading = false,
    )

    /** An action on the list (create, rename, ...) failed. */
    private val _actionError = MutableStateFlow<String?>(null)
    val actionError: StateFlow<String?> = _actionError.asStateFlow()

    fun dismissActionError() {
        _actionError.value = null
    }

    private fun act(fallback: String, onError: () -> Unit = {}, action: suspend (PircApi) -> Unit) {
        val api = api() ?: return
        _actionError.value = null
        viewModelScope.launch {
            try {
                action(api)
            } catch (error: IOException) {
                onError()
                handle(error)
                _actionError.value = (error as? ApiException)?.message ?: fallback
            }
        }
    }

    /** Put a changed session into the list without refetching everything. */
    fun replaceSession(session: Session) {
        val state = _sessions.value
        val sessions = state.sessions.filterNot { it.id == session.id } + session
        _sessions.value = listed(sessions, state.workspaces, state.nodes)
    }

    fun createSession(workspaceId: String, onCreated: (Session) -> Unit) = act("Could not create the session.") { api ->
        val session = api.createSession(workspaceId)
        replaceSession(session)
        onCreated(session)
    }

    /**
     * Rename, pin or settle at once (as on the web); the gateway's reply then
     * replaces the guess, and a failure puts the session back as it was.
     */
    fun updateSession(session: Session, name: String? = null, pinned: Boolean? = null, settled: Boolean? = null) {
        val before = _sessions.value.sessions.firstOrNull { it.id == session.id } ?: session
        replaceSession(before.edited(name, pinned, settled))
        act("Could not update the session.", onError = { replaceSession(before) }) { api ->
            val updated = api.updateSession(session.id, name, pinned, settled)
            replaceSession(updated)
            // Settled from the list, so not open: its unsent draft goes (as on the web).
            if (settled == true && updated.settled) local.saveDraft(updated.id, "")
        }
    }

    fun createWorkspace(nodeId: String, path: String, displayName: String, onCreated: (Workspace) -> Unit) =
        act("Could not add the workspace.") { api ->
            val workspace = api.createWorkspace(nodeId, path, displayName)
            val state = _sessions.value
            val nodes = api.nodes()
            _sessions.value = listed(state.sessions, state.workspaces.filterNot { it.id == workspace.id } + workspace, nodes)
            onCreated(workspace)
        }

    /** A dead token unpairs the phone; anything else is shown where it happened. */
    fun handle(error: Throwable) {
        if (error is ApiException && error.unauthorized) unpair(error.message)
    }

    fun unpair(reason: String? = null) {
        // Stop notifications for this gateway; with a dead token only the distributor side can go.
        val api = cachedApi
        val context = getApplication<Application>()
        viewModelScope.launch { PushRegistration.disable(context, api.takeIf { reason == null }) }
        refreshJob?.cancel()
        unwatchSessions()
        store.clear()
        local.clearDrafts()
        local.lastSession = null
        restore = null
        closeApi()
        cursors.clear()
        _pairing.value = null
        _loaded.value = true
        _sessions.value = SessionsState()
        _scheduleAttention.value = 0
        _notice.value = reason
    }

    /** Drop the old gateway's pooled connections and calls with its token. */
    private fun closeApi() {
        cachedApi?.client?.let { client ->
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
        }
        cachedApi = null
    }
}
