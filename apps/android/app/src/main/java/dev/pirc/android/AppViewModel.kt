package dev.pirc.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.CredentialStore
import dev.pirc.android.core.InvalidPairingLink
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.LocalStore
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PairingLink
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.NodeSummary
import dev.pirc.android.core.Session
import dev.pirc.android.core.Workspace
import dev.pirc.android.core.WorkspaceGroup
import dev.pirc.android.core.groupSessions
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

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

    private val _pairing = MutableStateFlow(store.load())
    val pairing: StateFlow<Pairing?> = _pairing.asStateFlow()

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

    private var refreshJob: Job? = null

    init {
        if (_pairing.value != null) refresh()
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
                store.save(pairing)
                _pairing.value = pairing
                _pairState.value = PairState.Idle
                refresh()
            } catch (error: ApiException) {
                // A 401 carries the gateway's reason (expired, revoked, ...).
                _pairState.value = PairState.Failed(error.message ?: "The gateway refused the request.")
            } catch (error: IOException) {
                _pairState.value = PairState.Failed("Cannot reach ${pairing.baseUrl}: ${error.message ?: "network error"}")
            }
        }
    }

    fun refresh() {
        val api = api() ?: return
        refreshJob?.cancel()
        _sessions.value = _sessions.value.copy(loading = true, error = null)
        refreshJob = viewModelScope.launch {
            try {
                _sessions.value = coroutineScope {
                    val sessions = async { api.sessions() }
                    val workspaces = async { api.workspaces() }
                    val nodes = async { api.nodes() }
                    listed(sessions.await(), workspaces.await(), nodes.await())
                }
            } catch (error: IOException) {
                handle(error)
                _sessions.value = _sessions.value.copy(loading = false, error = error.message ?: "Network error")
            }
        }
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

    private fun act(fallback: String, action: suspend (PircApi) -> Unit) {
        val api = api() ?: return
        _actionError.value = null
        viewModelScope.launch {
            try {
                action(api)
            } catch (error: IOException) {
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

    fun updateSession(session: Session, name: String? = null, pinned: Boolean? = null, settled: Boolean? = null) =
        act("Could not update the session.") { api -> replaceSession(api.updateSession(session.id, name, pinned, settled)) }

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
        refreshJob?.cancel()
        store.clear()
        _pairing.value = null
        _sessions.value = SessionsState()
        _notice.value = reason
    }
}
