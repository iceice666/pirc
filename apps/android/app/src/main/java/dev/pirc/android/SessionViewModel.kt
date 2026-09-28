package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.Commands
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.ControlApi
import dev.pirc.android.core.ControlLease
import dev.pirc.android.core.Drafts
import dev.pirc.android.core.InteractionAnswer
import dev.pirc.android.core.ModelOption
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.readingReply
import dev.pirc.android.core.StreamSignal
import dev.pirc.android.core.syncControl
import dev.pirc.android.core.timeline.Interaction
import dev.pirc.android.core.timeline.QueueItem
import dev.pirc.android.core.timeline.SessionState
import dev.pirc.android.core.timeline.reduce
import dev.pirc.android.core.timeline.snapshotState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import dev.pirc.android.core.timeline.TimelineEvent
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

enum class Connection { Connecting, Live, Reconnecting, Stopped }

/**
 * A file picked for the next message; [uploadId] is set once the node stored
 * it. Images ride in the model's context ([kind] "image"); anything else
 * ("file") is copied into the workspace for the agent's file tools to read.
 */
data class Attachment(
    val localId: String,
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
    val uploadId: String? = null,
    val kind: String = "image",
) {
    val uploading get() = uploadId == null
    override fun equals(other: Any?) = other is Attachment && other.localId == localId && other.uploadId == uploadId
    override fun hashCode() = localId.hashCode()
}

private val ACTIVE_RUN = setOf("queued", "running", "waiting_input", "stopping")
private const val HEARTBEAT_MS = 10_000L

/** A rotation or a glance at another app stops the screen only briefly: keep the stream that long. */
internal const val STOP_GRACE_MS = 5_000L

/** Hidden longer than this, the cursor may have expired: start over from a snapshot (as the web does). */
internal const val RESNAPSHOT_AFTER_MS = 15_000L

/** Streamed text is published at most this often; every other event at once. */
internal const val DELTA_BATCH_MS = 32L

/** What the composer shows of the session, so streamed text does not recompose it. */
data class ComposerSettings(
    val runStatus: String? = null,
    val modelId: String? = null,
    val modelProvider: String? = null,
    val thinkingLevel: String? = null,
)

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
    /** Shared with the side panels, which follow the same stream from here. */
    private val cursors: MutableMap<String, String> = HashMap(),
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

    /**
     * The composer owns the text while typing (a TextFieldState, so IME
     * composition never round-trips through here); it reports the text,
     * debounced, and the view model only writes back through [draftResets].
     */
    private var draftText = drafts.draft(sessionId)

    /** The saved draft, the text field's starting value. */
    val initialDraft: String get() = draftText

    private val _draftResets = Channel<String>(Channel.CONFLATED)

    /** Text the composer must replace its content with (after a message is sent). */
    val draftResets: Flow<String> = _draftResets.receiveAsFlow()

    val composerSettings: StateFlow<ComposerSettings> = _state
        .map { ComposerSettings(it?.run?.status, it?.selectedModelId, it?.selectedModelProvider, it?.thinkingLevel) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ComposerSettings())

    init {
        viewModelScope.launch { _state.collect { state -> state?.cursor?.let { cursors[sessionId] = it } } }
    }

    private val _attachments = MutableStateFlow<List<Attachment>>(emptyList())
    val attachments: StateFlow<List<Attachment>> = _attachments.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private var visible = false
    private var stream: Job? = null
    private var loading: Job? = null
    private var heartbeat: Job? = null
    private var syncing: Job? = null

    /** The pending [stop], cancelled if the screen comes back first. */
    private var stopping: Job? = null

    /** When the screen was last hidden (monotonic clock, ms), or null while visible. */
    private var hiddenAt: Long? = null

    /** Streamed text reduced but not yet published, and the job that publishes it. */
    private var unpublished: SessionState? = null
    private var publishing: Job? = null

    private val controlApi = object : ControlApi {
        override suspend fun control() = api.control(sessionId, clientId)
        override suspend fun acquire() = api.acquireControl(sessionId, clientId, force = false)
        override suspend fun heartbeat(generation: Long) = api.heartbeatControl(sessionId, clientId, generation)
    }

    fun runActive(state: SessionState? = _state.value) = state?.run?.status in ACTIVE_RUN

    // ---- lifecycle ----

    /** The screen is visible: load if needed, follow live events and keep control. */
    fun start() {
        stopping?.cancel()
        stopping = null
        visible = true
        val hiddenFor = hiddenAt?.let { System.nanoTime() / 1_000_000 - it }
        hiddenAt = null
        val current = _state.value
        if (current == null || current.needsSnapshot || (hiddenFor != null && hiddenFor > RESNAPSHOT_AFTER_MS)) reload()
        else if (stream?.isActive != true) follow()
        // Back in the foreground mid-backoff: reconnect now (the web's visibilitychange).
        else if (_connection.value == Connection.Reconnecting) Connectivity.wake()
        heartbeat?.cancel()
        heartbeat = viewModelScope.launch {
            while (isActive) {
                syncNow()
                delay(HEARTBEAT_MS)
            }
        }
        loadModels()
    }

    private var loadingModels: Job? = null

    /** Until the list arrives: a runner still starting has none yet, so each (re)connect asks again. */
    private fun loadModels() {
        if (_models.value.isNotEmpty() || loadingModels?.isActive == true) return
        loadingModels = viewModelScope.launch {
            runCatching { api.models(sessionId) }.onSuccess { _models.value = it }
        }
    }

    /**
     * The screen is hidden: after [STOP_GRACE_MS], stop streaming and renewing
     * (the lease lapses on its own). Coming back sooner keeps the stream.
     */
    fun stop() {
        visible = false
        hiddenAt = System.nanoTime() / 1_000_000
        drafts.saveDraft(sessionId, draftText)
        stopping?.cancel()
        stopping = viewModelScope.launch {
            delay(STOP_GRACE_MS)
            halt()
        }
    }

    private fun halt() {
        stream?.cancel()
        heartbeat?.cancel()
        stream = null
        publishDeltas()
        _connection.value = Connection.Stopped
    }

    /** Leaving the session: hand control back at once instead of waiting out the TTL. */
    override fun onCleared() {
        drafts.saveDraft(sessionId, draftText)
        val lease = _control.value
        val generation = lease.generation
        if (lease.heldByCurrentClient && generation != null)
            CoroutineScope(Dispatchers.IO).launch { runCatching { api.releaseControl(sessionId, clientId, generation) } }
    }

    fun reload() {
        if (loading?.isActive == true) return
        stream?.cancel()
        dropDeltas()
        loading = viewModelScope.launch {
            try {
                val raw = api.snapshot(sessionId)
                _state.value = readingReply { snapshotState(raw) }
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
        publishDeltas()
        _connection.value = Connection.Connecting
        stream = viewModelScope.launch {
            api.events(sessionId, cursor).collect { signal ->
                when (signal) {
                    StreamSignal.Connected -> {
                        _connection.value = Connection.Live
                        syncNow()
                        loadModels()
                    }
                    StreamSignal.Reconnecting -> _connection.value = Connection.Reconnecting
                    is StreamSignal.Closed -> {
                        _connection.value = Connection.Stopped
                        fail(signal.error)
                    }
                    is StreamSignal.Event -> apply(signal)
                }
            }
        }
    }

    /**
     * Streamed text arrives as dozens of deltas a second; each would copy the
     * state and recompose the screen. Deltas are reduced into [unpublished] and
     * published every [DELTA_BATCH_MS]; any other event publishes at once.
     */
    private fun apply(signal: StreamSignal.Event) {
        if (signal.envelope.event is TimelineEvent.MessageDelta) {
            val next = (unpublished ?: _state.value)?.reduce(signal.envelope) ?: return
            if (!next.needsSnapshot) {
                unpublished = next
                if (publishing?.isActive != true) publishing = viewModelScope.launch {
                    delay(DELTA_BATCH_MS)
                    publishDeltas()
                }
                return
            }
        }
        publishDeltas()
        val next = _state.value?.reduce(signal.envelope) ?: return
        _state.value = next
        // The snapshot's watermark is where the new stream resumes.
        if (next.needsSnapshot) reload()
    }

    /** A delta only changes the messages and the cursor; anything else may have been updated meanwhile. */
    private fun publishDeltas() {
        publishing?.cancel()
        publishing = null
        val pending = unpublished ?: return
        unpublished = null
        _state.update { it?.copy(messages = pending.messages, cursor = pending.cursor) }
    }

    private fun dropDeltas() {
        publishing?.cancel()
        publishing = null
        unpublished = null
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

    /** The composer's text changed (debounced); kept so it survives leaving the session. */
    fun setDraft(text: String) {
        if (text == draftText) return
        draftText = text
        drafts.saveDraft(sessionId, text)
    }

    fun dismissActionError() {
        _actionError.value = null
    }

    fun attach(name: String, mimeType: String, bytes: ByteArray) {
        val isImage = mimeType.startsWith("image/")
        val attachment = Attachment("local-${UUID.randomUUID()}", name, mimeType, bytes, kind = if (isImage) "image" else "file")
        _attachments.update { it + attachment }
        viewModelScope.launch {
            try {
                val upload = api.upload(sessionId, bytes, mimeType, filename = if (isImage) null else name)
                _attachments.update { list -> list.map { if (it.localId == attachment.localId) it.copy(uploadId = upload.id, kind = upload.kind) else it } }
            } catch (error: IOException) {
                _attachments.update { list -> list.filterNot { it.localId == attachment.localId } }
                act(error, "Could not upload $name.")
            }
        }
    }

    fun removeAttachment(localId: String) {
        _attachments.update { list -> list.filterNot { it.localId == localId } }
    }

    /** A prompt when idle; while a run is active, a steer (it joins after the current tool batch). */
    fun send(draft: String) {
        val text = draft.trim()
        val attachments = _attachments.value
        if (text.isEmpty() || attachments.any { it.uploading }) return
        val kind = if (runActive()) "steer" else "prompt"
        perform("The message was not accepted.") { generation ->
            if (kind == "prompt") applySettings(generation)
            val receipt = api.command(
                sessionId, clientId, generation, UUID.randomUUID().toString(),
                Commands.message(kind, text, attachments.mapNotNull { it.uploadId }),
            )
            if (!receipt.accepted) throw ApiException(503, receipt.status, receipt.message ?: "The message was not accepted.")
            setDraft("")
            _draftResets.trySend("")
            _attachments.value = emptyList()
        }
    }

    /** Settings chosen before this phone had control only reach the agent with a command. */
    private suspend fun applySettings(generation: Long) {
        val state = _state.value ?: return
        val model = selectedModel(state)
        if (model != null) command(generation, Commands.setModel(model.provider, model.id))
        command(generation, Commands.setThinking(thinkingLevel(state)))
    }

    fun stopRun() = perform("The run could not be stopped.") { command(it, Commands.simple("stop")) }

    /** Deliver a queued message now; a no-op if the run already took or dropped it. */
    fun sendQueuedNow(item: QueueItem) = perform("The message could not be sent now.") { generation ->
        val receipt = api.command(sessionId, clientId, generation, UUID.randomUUID().toString(), Commands.sendNow(item))
        if (!receipt.accepted && receipt.message?.contains("no longer queued") != true)
            throw ApiException(503, receipt.status, receipt.message ?: "The message could not be sent now.")
    }

    fun clearQueue() = perform("The queue could not be cleared.") { command(it, Commands.simple("clear_queue")) }

    /** Rename, pin or settle this session; needs no control (it is the owner's list, not the agent). */
    fun updateSession(name: String? = null, pinned: Boolean? = null, settled: Boolean? = null, onChanged: (dev.pirc.android.core.Session) -> Unit) {
        viewModelScope.launch {
            try {
                val session = api.updateSession(sessionId, name, pinned, settled)
                _state.update { it?.copy(session = session) }
                onChanged(session)
            } catch (error: IOException) {
                act(error, "Could not update the session.")
            }
        }
    }

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

    fun selectedModel(state: SessionState? = _state.value): ModelOption? =
        selectedModel(state?.selectedModelId, state?.selectedModelProvider)

    fun selectedModel(settings: ComposerSettings): ModelOption? = selectedModel(settings.modelId, settings.modelProvider)

    private fun selectedModel(id: String?, provider: String?): ModelOption? {
        val models = _models.value
        return models.firstOrNull { it.id == id && (provider == null || it.provider == provider) } ?: models.firstOrNull()
    }

    /** The thinking level shown and sent: the session's, else the web's default. */
    fun thinkingLevel(state: SessionState? = _state.value): String = state?.thinkingLevel ?: "medium"

    fun thinkingLevel(settings: ComposerSettings): String = settings.thinkingLevel ?: "medium"

    fun runActive(settings: ComposerSettings) = settings.runStatus in ACTIVE_RUN

    /**
     * Pick a model and thinking level together. Only what changed is sent,
     * and only with control; otherwise it applies with the next prompt.
     */
    fun selectSettings(model: ModelOption?, level: String) {
        val before = _state.value
        val modelChanged = model != null && model != selectedModel(before)
        val levelChanged = level != thinkingLevel(before)
        if (!modelChanged && !levelChanged) return
        _state.update { state ->
            state?.copy(
                selectedModelId = if (modelChanged) model!!.id else state.selectedModelId,
                selectedModelProvider = if (modelChanged) model!!.provider else state.selectedModelProvider,
                thinkingLevel = level,
            )
        }
        if (_control.value.heldByCurrentClient)
            perform("The model settings could not be changed.") { generation ->
                if (modelChanged) command(generation, Commands.setModel(model!!.provider, model.id))
                if (levelChanged) command(generation, Commands.setThinking(level))
            }
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
