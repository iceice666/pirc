package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.core.timeline.reduce
import dev.pirc.android.core.timeline.snapshotState
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

enum class Connection { Connecting, Live, Reconnecting, Stopped }

/**
 * One open session: its snapshot, kept current by the event stream while the
 * screen is visible. When events can no longer be applied (new runner epoch,
 * lifecycle change, reset) it takes a new snapshot and resumes from there.
 */
class SessionViewModel(
    private val api: PircApi,
    val sessionId: String,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow<SessionState?>(null)
    val state: StateFlow<SessionState?> = _state.asStateFlow()

    private val _connection = MutableStateFlow(Connection.Connecting)
    val connection: StateFlow<Connection> = _connection.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var visible = false
    private var stream: Job? = null
    private var loading: Job? = null

    /** The screen is visible: load if needed and follow live events. */
    fun start() {
        visible = true
        if (_state.value == null || _state.value!!.needsSnapshot) reload() else follow()
    }

    /** The screen is hidden: stop streaming (resumes from the cursor on [start]). */
    fun stop() {
        visible = false
        stream?.cancel()
        stream = null
        _connection.value = Connection.Stopped
    }

    fun reload() {
        if (loading?.isActive == true) return
        stream?.cancel()
        loading = viewModelScope.launch {
            try {
                _state.value = snapshotState(api.snapshot(sessionId))
                _error.value = null
                if (visible) follow()
            } catch (error: IOException) {
                fail(error)
            }
        }
    }

    private fun follow() {
        val cursor = _state.value?.cursor ?: return
        stream?.cancel()
        _connection.value = Connection.Connecting
        stream = viewModelScope.launch {
            api.events(sessionId, cursor).collect { signal ->
                when (signal) {
                    StreamSignal.Connected -> _connection.value = Connection.Live
                    StreamSignal.Reconnecting -> _connection.value = Connection.Reconnecting
                    is StreamSignal.Closed -> {
                        _connection.value = Connection.Stopped
                        fail(signal.error)
                    }
                    is StreamSignal.Event -> {
                        val next = _state.value?.reduce(signal.envelope) ?: return@collect
                        _state.value = next
                        // The snapshot's watermark is where the new stream resumes.
                        if (next.needsSnapshot) reload()
                    }
                }
            }
        }
    }

    private fun fail(error: IOException) {
        if (error is ApiException && error.unauthorized) onUnauthorized(error)
        _error.value = error.message ?: "Network error"
    }
}
