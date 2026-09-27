package dev.pirc.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.CredentialStore
import dev.pirc.android.core.InvalidPairingLink
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.Pairing
import dev.pirc.android.core.PairingLink
import dev.pirc.android.core.PircApi
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
    val loading: Boolean = true,
    val error: String? = null,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val store: CredentialStore = KeystoreCredentialStore(application)

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
                _pairState.value = PairState.Failed(
                    if (error.unauthorized) "The gateway refused this token. It may have expired; pair again from the web."
                    else error.message ?: "The gateway refused the request.",
                )
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
                val groups = coroutineScope {
                    val sessions = async { api.sessions() }
                    val workspaces = async { api.workspaces() }
                    val nodes = async { api.nodes() }
                    groupSessions(sessions.await(), workspaces.await(), nodes.await())
                }
                _sessions.value = SessionsState(groups = groups, loading = false)
            } catch (error: IOException) {
                handle(error)
                _sessions.value = _sessions.value.copy(loading = false, error = error.message ?: "Network error")
            }
        }
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
