package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Commands
import dev.pirc.android.core.ControlApi
import dev.pirc.android.core.ControlLease
import dev.pirc.android.core.Drafts
import dev.pirc.android.core.InteractionAnswer
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.syncControl
import dev.pirc.android.core.timeline.Interaction
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.core.timeline.reduce
import dev.pirc.android.core.timeline.snapshotState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

enum class Connection { Connecting, Live, Reconnecting, Stopped }

/** An image picked for the next message; [uploadId] is set once the node stored it. */
data class Attachment(
    val localId: String,
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
    val uploadId: String? = null,
) {
    val uploading get() = uploadId == null
    override fun equals(other: Any?) = other is Attachment && other.localId == localId && other.uploadId == uploadId
    override fun hashCode() = localId.hashCode()
}

/** Where a message goes while a run is active. */
enum class Delivery(val command: String) { Steer("steer"), FollowUp("follow_up") }

private val ACTIVE_RUN = setOf("queued", "running", "waiting_input", "stopping")
private const val HEARTBEAT_MS = 10_000L

/**
 * One open session: its snapshot, kept current by the event stream while the
 * screen is visible, and everything this phone can do there once it holds
 * the control lease (prompt, steer, queue, stop, answer, change model).
 */
class SessionViewModel(
    private val api: PircApi,
    val sessionId: String,
    private val clientId: String,
    private val drafts: Drafts,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow<SessionState?>(null)
    val state: StateFlow<SessionState?> = _state.asStateFlow()

    private val _connection = MutableStateFlow(Connection.Connecting)
    val connection: StateFlow<Connection> = _connection.asStateFlow()

    /** Loading or streaming failed. */
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** An action (send, answer, upload, ...) failed; shown until dismissed. */
    private val _actionError = MutableStateFlow<String?>(null)
    val actionError: StateFlow<String?> = _actionError.asStateFlow()

    private val _control = MutableStateFlow(ControlLease())
    val control: StateFlow<ControlLease> = _control.asStateFlow()

    private val _models = MutableStateFlow<List<ModelOption>>(emptyList())
    val models: StateFlow<List<ModelOption>> = _models.asStateFlow()

    private val _draft = MutableStateFlow(drafts.draft(sessionId))
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _attachments = MutableStateFlow<List<Attachment>>(emptyList())
    val attachments: StateFlow<List<Attachment>> = _attachments.asStateFlow()

    private val _delivery = MutableStateFlow(Delivery.Steer)
    val delivery: StateFlow<Delivery> = _delivery.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private var visible = false
    private var stream: Job? = null
    private var loading: Job? = null
    private var heartbeat: Job? = null
    private var syncing: Job? = null

    private val controlApi = object : ControlApi {
        override suspend fun control() = api.control(sessionId, clientId)
        override suspend fun acquire() = api.acquireControl(sessionId, clientId, force = false)
        override suspend fun heartbeat(generation: Long) = api.heartbeatControl(sessionId, clientId, generation)
    }

    fun runActive(state: SessionState? = _state.value) = state?.run?.status in ACTIVE_RUN

    // ---- lifecycle ----

    /** The screen is visible: load if needed, follow live events and keep control. */
    fun start() {
        visible = true
        if (_state.value == null || _state.value!!.needsSnapshot) reload() else follow()
        heartbeat?.cancel()
        heartbeat = viewModelScope.launch {
            while (isActive) {
                syncNow()
                delay(HEARTBEAT_MS)
            }
        }
        if (_models.value.isEmpty()) viewModelScope.launch {
            runCatching { api.models(sessionId) }.onSuccess { _models.value = it }
        }
    }

    /** The screen is hidden: stop streaming and renewing (the lease lapses on its own). */
    fun stop() {
        visible = false
        stream?.cancel()
        heartbeat?.cancel()
        stream = null
        _connection.value = Connection.Stopped
        drafts.saveDraft(sessionId, _draft.value)
    }

    /** Leaving the session: hand control back at once instead of waiting out the TTL. */
    override fun onCleared() {
        drafts.saveDraft(sessionId, _draft.value)
        val lease = _control.value
        val generation = lease.generation
        if (lease.heldByCurrentClient && generation != null)
            CoroutineScope(Dispatchers.IO).launch { runCatching { api.releaseControl(sessionId, clientId, generation) } }
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
                    StreamSignal.Connected -> {
                        _connection.value = Connection.Live
                        syncNow()
                    }
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

    private fun syncNow() {
        if (syncing?.isActive == true) return
        syncing = viewModelScope.launch {
            try {
                syncControl(controlApi, _control.value, mayAcquire = visible)?.let { _control.value = it }
            } catch (error: IOException) {
                fail(error)
            }
        }
    }

    private fun fail(error: IOException) {
        if (error is ApiException && error.unauthorized) onUnauthorized(error)
        _error.value = error.message ?: "Network error"
    }

    // ---- composing ----

    fun setDraft(text: String) {
        _draft.value = text
    }

    fun setDelivery(delivery: Delivery) {
        _delivery.value = delivery
    }

    fun dismissActionError() {
        _actionError.value = null
    }

    fun attach(name: String, mimeType: String, bytes: ByteArray) {
        val attachment = Attachment("local-${UUID.randomUUID()}", name, mimeType, bytes)
        _attachments.update { it + attachment }
        viewModelScope.launch {
            try {
                val upload = api.upload(sessionId, bytes, mimeType)
                _attachments.update { list -> list.map { if (it.localId == attachment.localId) it.copy(uploadId = upload.id) else it } }
            } catch (error: IOException) {
                _attachments.update { list -> list.filterNot { it.localId == attachment.localId } }
                act(error, "Could not upload $name.")
            }
        }
    }

    fun removeAttachment(localId: String) {
        _attachments.update { list -> list.filterNot { it.localId == localId } }
    }

    /** A prompt when idle; while a run is active, a steer or a queued follow-up. */
    fun send() {
        val text = _draft.value.trim()
        val attachments = _attachments.value
        if (text.isEmpty() || attachments.any { it.uploading }) return
        val kind = if (runActive()) _delivery.value.command else "prompt"
        perform("The message was not accepted.") { generation ->
            if (kind == "prompt") applySettings(generation)
            val receipt = api.command(
                sessionId, clientId, generation, UUID.randomUUID().toString(),
                Commands.message(kind, text, attachments.mapNotNull { it.uploadId }),
            )
            if (!receipt.accepted) throw ApiException(503, receipt.status, receipt.message ?: "The message was not accepted.")
            _draft.value = ""
            _attachments.value = emptyList()
            drafts.saveDraft(sessionId, "")
        }
    }

    /** Settings chosen before this phone had control only reach the agent with a command. */
    private suspend fun applySettings(generation: Long) {
        val state = _state.value ?: return
        val model = selectedModel(state)
        if (model != null) command(generation, Commands.setModel(model.provider, model.id))
        state.thinkingLevel?.let { command(generation, Commands.setThinking(it)) }
    }

    fun stopRun() = perform("The run could not be stopped.") { command(it, Commands.simple("stop")) }

    fun clearQueue() = perform("The queue could not be cleared.") { command(it, Commands.simple("clear_queue")) }

    fun takeControl() {
        viewModelScope.launch {
            try {
                _control.value = api.acquireControl(sessionId, clientId, force = true)
            } catch (error: IOException) {
                act(error, "Control could not be transferred.")
            }
        }
    }

    fun answer(interaction: Interaction, answer: InteractionAnswer) =
        perform("Your answer was not accepted.") { generation ->
            api.answer(sessionId, interaction.id, clientId, generation, answer)
            _state.update { state -> state?.copy(interactions = state.interactions.filterNot { it.id == interaction.id }) }
        }

    fun selectedModel(state: SessionState? = _state.value): ModelOption? {
        val models = _models.value
        return models.firstOrNull {
            it.id == state?.selectedModelId && (state.selectedModelProvider == null || it.provider == state.selectedModelProvider)
        } ?: models.firstOrNull()
    }

    fun selectModel(model: ModelOption) {
        _state.update { it?.copy(selectedModelId = model.id, selectedModelProvider = model.provider) }
        if (_control.value.heldByCurrentClient)
            perform("The model could not be changed.") { command(it, Commands.setModel(model.provider, model.id)) }
    }

    fun selectThinking(level: String) {
        _state.update { it?.copy(thinkingLevel = level) }
        if (_control.value.heldByCurrentClient)
            perform("The thinking level could not be changed.") { command(it, Commands.setThinking(level)) }
    }

    private suspend fun command(generation: Long, payload: kotlinx.serialization.json.JsonObject) {
        val receipt = api.command(sessionId, clientId, generation, UUID.randomUUID().toString(), payload)
        if (!receipt.accepted) throw ApiException(503, receipt.status, receipt.message ?: "The command was not accepted.")
    }

    /** Run [action] with the lease generation; a lost lease is picked up again for the next try. */
    private fun perform(failure: String, action: suspend (Long) -> Unit) {
        val generation = _control.value.generation?.takeIf { _control.value.heldByCurrentClient }
        if (generation == null) {
            _actionError.value = "Take control of this session first."
            return
        }
        if (_busy.value) return
        _busy.value = true
        _actionError.value = null
        viewModelScope.launch {
            try {
                action(generation)
            } catch (error: IOException) {
                act(error, failure)
                if (error is ApiException && error.code == "lost_control") withContext(NonCancellable) { syncNow() }
            } finally {
                _busy.value = false
            }
        }
    }

    private fun act(error: IOException, fallback: String) {
        if (error is ApiException && error.unauthorized) onUnauthorized(error)
        _actionError.value = error.message?.takeIf { error is ApiException } ?: fallback
    }
}
