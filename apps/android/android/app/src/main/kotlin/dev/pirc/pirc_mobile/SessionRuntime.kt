package dev.pirc.pirc_mobile

import android.content.Context
import dev.pirc.android.core.*
import dev.pirc.android.core.timeline.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

/*
 * The session domain (plans/rewrite/12-android.md, decision 2): a session's
 * watch, its control lease, commands and answers, split out of
 * GatewayRuntime, which keeps the transport (pairing, contexts, HTTP,
 * documents, sockets). The conversation half of this file goes when the app
 * no longer shows sessions as conversations (decision 4); the lease stays for
 * the engine's panes.
 */

fun SessionState.wire(): Map<String, Any?> = mapOf(
    "session" to PircJson.encodeToJsonElement(Session.serializer(), session).wire(),
    "run" to run?.let { mapOf("id" to it.id, "status" to it.status, "failureReason" to it.failureReason) },
    "runnerStatus" to runnerStatus, "runnerEpoch" to runnerEpoch, "cursor" to cursor,
    "modelId" to selectedModelId, "modelProvider" to selectedModelProvider, "thinking" to thinkingLevel,
    "approvalMode" to approvalMode, "defaultApprovalMode" to defaultApprovalMode,
    "widgets" to widgets, "statuses" to statuses,
    "sandbox" to sandbox?.let { mapOf("active" to it.active, "reason" to it.reason) },
    "queue" to queue.map { mapOf("id" to it.id, "kind" to it.kind, "content" to it.content, "index" to it.index) },
    "interactions" to interactions.map { it.wire() },
    "delegations" to delegations.map { it.wire() },
    "messages" to messages.map { m -> mapOf(
        "id" to m.id, "role" to m.role, "content" to m.content, "createdAt" to m.createdAt,
        "entryId" to m.entryId,
        "branches" to m.branches.map { mapOf("entryId" to it.entryId, "text" to it.text, "selected" to it.selected) },
        "partial" to m.isPartial, "thinking" to m.thinking, "error" to m.errorMessage,
        "label" to m.label, "systemKind" to m.systemKind, "level" to m.level, "meta" to m.meta,
        "thinkingRedacted" to m.thinkingRedacted, "stopReason" to m.stopReason, "model" to m.model,
        "images" to m.images.map { mapOf("mimeType" to it.mimeType, "base64" to it.base64) },
        "tools" to m.tools.map { it.wire() }
    ) }
)
private fun ToolCall.wire(): Map<String, Any?> = mapOf(
    "id" to id, "name" to name, "title" to title, "status" to status,
    "input" to input.wire(), "output" to output, "diff" to diff,
    "recording" to recording, "startedAt" to startedAt, "endedAt" to endedAt,
    "images" to images.map { mapOf("mimeType" to it.mimeType, "base64" to it.base64) },
    "operations" to operations.map { it.wire() },
)
fun Interaction.wire() = mapOf("id" to id, "epoch" to runnerEpoch, "kind" to kind,
    "title" to title, "description" to description, "expiresAt" to expiresAt, "status" to status,
    "toolCallId" to toolCallId,
    "multiple" to multiple, "placeholder" to placeholder, "initialValue" to initialValue,
    "confirmLabel" to confirmLabel, "cancelLabel" to cancelLabel, "language" to language,
    "options" to options.map { mapOf("value" to it.value, "label" to it.label, "description" to it.description) },
    "relayed" to relayed?.let { mapOf("sessionId" to it.sessionId, "sessionName" to it.sessionName,
        "workspace" to it.workspace, "delegationId" to it.delegationId) })
fun ChatDelegation.wire() = mapOf("id" to id, "title" to title, "workspace" to workspace, "status" to status,
    "dispatch" to dispatch, "targetSessionId" to targetSessionId)

/**
 * The control generation an answer must carry, or null for a relayed (`relay.`)
 * delegation approval: the gateway answers those without the chat's lease, so
 * acquiring it would only take control away from another device.
 */
suspend fun answerGeneration(interactionId: String, acquire: suspend () -> Long): Long? =
    if (isRelayedInteraction(interactionId)) null else acquire()

/** Recheck the exact question against a fresh snapshot. The session cursor epoch
 * belongs to the daemon stream and may differ from the node interaction epoch.
 * The answer endpoint validates the active runner and control generation. */
fun checkedAnswer(before: SessionState, interactionId: String, epoch: String, data: Map<*, *>, now: Long = System.currentTimeMillis()): InteractionAnswer {
    val question = before.interactions.find { it.id == interactionId }
        ?: throw ApiException(409, "stale", "問題已不存在，請重新整理")
    if (question.status != "pending" || question.runnerEpoch != epoch ||
        (question.expiresAt != null && question.expiresAt!! <= now)) throw ApiException(409, "stale", "問題已處理或過期")
    return when {
        data["cancelled"] == true -> InteractionAnswer.Cancel
        question.kind == "confirm" -> {
            val confirmed = data["confirmed"] as? Boolean ?: throw ApiException(400, "invalid_answer", "請選擇確認或拒絕")
            InteractionAnswer.Confirm(confirmed)
        }
        question.kind == "select" -> {
            val values = (data["values"] as? List<*>)?.mapNotNull { it as? String }.orEmpty()
            if (values.isEmpty() || values.distinct().size != values.size || (!question.multiple && values.size != 1) || values.any { v -> question.options.none { it.value == v } }) throw ApiException(400, "invalid_answer", "選项已變更，請重新選擇")
            InteractionAnswer.Choices(values)
        }
        question.kind in listOf("input", "editor") -> InteractionAnswer.Text(data["value"] as? String ?: throw ApiException(400, "invalid_answer", "請輸入答案"))
        else -> throw ApiException(400, "invalid_answer", "此問題類型尚不支援")
    }
}

data class AnswerReconciliation(val pending: Boolean, val interaction: Interaction?)

/** Resolve an uncertain answer only against the exact question in this session snapshot. */
fun answerReconciliation(
    before: SessionState,
    sessionId: String,
    interactionId: String,
    epoch: String,
    now: Long = System.currentTimeMillis(),
): AnswerReconciliation {
    if (before.session.id != sessionId)
        throw ApiException(409, "session_changed", "對話已變更，請重新檢查問題")
    val question = before.interactions.firstOrNull {
        it.id == interactionId && it.runnerEpoch == epoch
    }
    val pending = question != null && question.status == "pending" &&
        (question.expiresAt == null || question.expiresAt > now)
    return AnswerReconciliation(pending, question.takeIf { pending })
}

class SessionRuntime internal constructor(private val gateway: GatewayRuntime) {
    private val context get() = gateway.context
    private val local get() = gateway.local
    private val scope get() = gateway.scope
    private val activeApi get() = gateway.activeApiOrNull
    private val answerLock get() = gateway.answerLock
    private val pairingIdentity get() = gateway.pairingIdentity
    private val credentials get() = gateway.credentials
    private suspend fun api() = gateway.api()
    private fun ensurePairingStamp() = gateway.ensurePairingStamp()
    private suspend fun validatePairingStamp(expected: String) = gateway.validatePairingStamp(expected)
    private fun contextLease(contextId: String?) = gateway.contextLease(contextId)
    private fun contextLeaseIsCurrent(lease: ContextRegistry.Lease) = gateway.contextLeaseIsCurrent(lease)
    private fun emitEvent(
        type: String,
        data: Any?,
        sessionId: String?,
        contextId: String? = null,
        eventTag: String? = null,
    ) = gateway.emitEvent(type, data, sessionId, contextId, eventTag)

    private data class SessionWatchState(
        val sessionId: String,
        var latest: SessionState? = null,
        var connection: String = "connecting",
        var watcher: Job? = null,
        var heartbeats: Job? = null,
        var heartbeatWake: Channel<Unit>? = null,
        var pendingSnapshot: Job? = null,
        val composerSettings: SessionComposerSettings = SessionComposerSettings(),
    )
    private val watchHub = SessionWatchHub()
    private val sessionWatches = mutableMapOf<String, SessionWatchState>()
    internal var watched: String? = null
    private val heldGenerations = mutableMapOf<String, Long>()
    private val commandLock = Mutex()
    private val stopCommandLock = Mutex()
    var latest: SessionState? = null
    private val uncertain = gateway.context.getSharedPreferences("uncertain_answers", Context.MODE_PRIVATE)

    /** A context closed: stop what only it watched. */
    internal fun removeContext(contextId: String) {
        val change = watchHub.removeContext(contextId)
        change.stoppedSessions.forEach { stopSessionWatch(it, release = true) }
        change.leasePolicyChangedSessions.forEach(::wakeSessionHeartbeat)
    }

    /** Every context closed (pairing changed). */
    internal fun closeAll(releaseLeases: Boolean) {
        val change = watchHub.clear()
        change.stoppedSessions.forEach { stopSessionWatch(it, release = releaseLeases) }
        watched = null
        latest = null
    }

    /** Another account: its unresolved commands and answers are not this one's. */
    internal fun clearUncertain() {
        latest = null
        uncertain.edit().clear().commit()
    }

    private fun emitToSubscriber(
        subscription: SessionWatchSubscription,
        type: String,
        data: Any?,
    ) {
        val lease = try {
            contextLease(subscription.contextId)
        } catch (_: ApiException) {
            return
        }
        scope.launch {
            if (!contextLeaseIsCurrent(lease) ||
                !watchHub.isCurrent(subscription.sessionId, subscription.contextId, subscription.eventTag)
            ) return@launch
            emitEvent(
                type,
                data,
                subscription.sessionId,
                contextId = subscription.contextId,
                eventTag = subscription.eventTag,
            )
        }
    }
    private fun emitSessionWatch(entry: SessionWatchState, type: String, data: Any?) {
        if (sessionWatches[entry.sessionId] !== entry) return
        watchHub.subscribers(entry.sessionId).forEach { emitToSubscriber(it, type, data) }
    }
    private fun updatePrimaryProjection(entry: SessionWatchState) {
        val primary = watchHub.subscription(ContextRegistry.PRIMARY_CONTEXT_ID)
        if (primary?.sessionId == entry.sessionId) latest = entry.latest
    }
    suspend fun snapshot(id: String): SessionState {
        val owner = sessionWatches[id]
        val state = snapshotState(api().snapshot(id))
        if (owner != null && sessionWatches[id] === owner) {
            owner.composerSettings.observedApprovalSnapshot(state.approvalMode)
        }
        return state
    }

    /** True only when at least one subscribed app context currently shows this session. */
    fun hasVisibleSessionSubscriber(sessionId: String): Boolean =
        watchHub.hasVisibleSubscriber(sessionId)

    suspend fun snapshotForInteraction(id: String): Pair<SessionState, String> = answerLock.withLock {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
            ?: throw ApiException(401, "unpaired", "請先配對此裝置")
        snapshot(id) to ensurePairingStamp()
    }

    fun watch(id: String, contextId: String? = null, eventTag: String? = null) {
        val context = contextLease(contextId)
        require(eventTag == null || (eventTag.isNotBlank() && eventTag.length <= 128)) {
            "Invalid eventTag"
        }
        val scopedTag = eventTag ?: context.contextId.takeUnless {
            it == ContextRegistry.PRIMARY_CONTEXT_ID
        }?.let { UUID.randomUUID().toString() }
        val change = watchHub.subscribe(id, context.contextId, scopedTag)
        if (change.sessionDeleted) {
            emitEvent(
                "sessionDeleted",
                mapOf("sessionId" to id),
                id,
                contextId = context.contextId,
                eventTag = scopedTag,
            )
            return
        }
        val subscription = requireNotNull(change.subscription)
        change.stoppedSessions.forEach { stopSessionWatch(it, release = true) }
        if (context.contextId == ContextRegistry.PRIMARY_CONTEXT_ID) watched = id

        val entry = sessionWatches.getOrPut(id) { SessionWatchState(id) }
        val startsWatcher = entry.watcher?.isActive != true
        if (startsWatcher) {
            startSessionWatch(entry)
        } else {
            emitToSubscriber(subscription, "connection", entry.connection)
            entry.latest?.let { emitToSubscriber(subscription, "snapshot", it.wire()) }
            // The pooled heartbeat already owns lease refresh for this session.
            // It will emit its current control result to every subscriber.
        }
        change.leasePolicyChangedSessions
            .filterNot { it == id && startsWatcher }
            .forEach(::wakeSessionHeartbeat)
        updatePrimaryProjection(entry)
    }
    fun unwatch(release: Boolean = false) = unwatch(contextId = null, eventTag = null, release = release)

    fun unwatch(contextId: String?, eventTag: String? = null, release: Boolean = false) {
        val context = contextLease(contextId)
        val current = watchHub.subscription(context.contextId) ?: return
        if (eventTag != null && current.eventTag != eventTag) return
        val change = watchHub.unsubscribe(context.contextId, eventTag)
        change.stoppedSessions.forEach { stopSessionWatch(it, release) }
        change.leasePolicyChangedSessions.forEach(::wakeSessionHeartbeat)
        if (context.contextId == ContextRegistry.PRIMARY_CONTEXT_ID) {
            watched = watchHub.subscription(ContextRegistry.PRIMARY_CONTEXT_ID)?.sessionId
            latest = watched?.let { sessionWatches[it]?.latest }
        }
    }

    fun setWatchVisibility(
        contextId: String?,
        visible: Boolean,
        visibilityRevision: Long,
        eventTag: String? = null,
    ): Boolean {
        val context = contextLease(contextId)
        require(eventTag == null || (eventTag.isNotBlank() && eventTag.length <= 128)) {
            "Invalid eventTag"
        }
        val change = watchHub.setVisibility(
            context.contextId,
            visible,
            visibilityRevision,
            eventTag,
        )
        change.leasePolicyChangedSessions.forEach(::wakeSessionHeartbeat)
        return !change.staleTag && !change.staleVisibility
    }

    private fun startSessionWatch(entry: SessionWatchState) {
        entry.connection = "connecting"
        entry.watcher = scope.launch {
            var attempt = 0
            while (isActive && sessionWatches[entry.sessionId] === entry) {
                try {
                    entry.connection = "connecting"
                    emitSessionWatch(entry, "connection", entry.connection)
                    val settingsRevision = entry.composerSettings.revision
                    var state = snapshot(entry.sessionId)
                    if (sessionWatches[entry.sessionId] !== entry) break
                    state = entry.composerSettings.mergeFetched(state, settingsRevision)
                    entry.latest = state
                    updatePrimaryProjection(entry)
                    GatewayNotifications.sync(context, state, questionPairingStamp = ensurePairingStamp())
                    emitSessionWatch(entry, "snapshot", state.wire())
                    EventStream(api(), onChange = { type ->
                        scope.launch {
                            if (sessionWatches[entry.sessionId] === entry) {
                                emitSessionWatch(entry, "indexChange", type)
                            }
                        }
                    }).open(entry.sessionId, state.cursor).collect { signal ->
                        if (sessionWatches[entry.sessionId] !== entry) return@collect
                        when (signal) {
                            StreamSignal.Connected -> {
                                attempt = 0
                                entry.connection = "live"
                                emitSessionWatch(entry, "connection", entry.connection)
                            }
                            StreamSignal.Reconnecting -> {
                                entry.connection = "reconnecting"
                                emitSessionWatch(entry, "connection", entry.connection)
                            }
                            is StreamSignal.Closed -> throw signal.error
                            is StreamSignal.Event -> {
                                val before = entry.latest ?: state
                                val event = signal.envelope.event
                                if (event == TimelineEvent.SessionDeleted) {
                                    emitSessionWatch(
                                        entry,
                                        "sessionDeleted",
                                        mapOf("sessionId" to entry.sessionId),
                                    )
                                    watchHub.markDeleted(entry.sessionId)
                                    stopSessionWatch(entry.sessionId, release = false)
                                    return@collect
                                }
                                if (event is TimelineEvent.PanelChanged) {
                                    emitSessionWatch(entry, "panelChange", event.sections)
                                }
                                state = before.reduce(signal.envelope)
                                if (!state.needsSnapshot && event is TimelineEvent.ApprovalModeChanged) {
                                    entry.composerSettings.authoritativeApprovalMode(event.mode)
                                }
                                GatewayNotifications.sync(context, state, before, ensurePairingStamp())
                                if (state.needsSnapshot) throw Resnapshot()
                                entry.latest = state
                                updatePrimaryProjection(entry)
                                if (entry.pendingSnapshot?.isActive != true) {
                                    entry.pendingSnapshot = scope.launch {
                                        delay(32)
                                        if (sessionWatches[entry.sessionId] === entry) {
                                            entry.latest?.let {
                                                emitSessionWatch(entry, "snapshot", it.wire())
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (_: Resnapshot) {
                    continue
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (sessionWatches[entry.sessionId] !== entry) break
                    emitSessionWatch(entry, "error", e.message)
                    if (e is ApiException && e.status in listOf(401, 403, 404)) {
                        entry.connection = "stopped"
                        emitSessionWatch(entry, "connection", entry.connection)
                        break
                    }
                    entry.connection = "reconnecting"
                    emitSessionWatch(entry, "connection", entry.connection)
                    delay(minOf(20_000L, 750L shl minOf(attempt++, 5)))
                }
            }
        }
        startSessionHeartbeat(entry)
    }

    private fun startSessionHeartbeat(entry: SessionWatchState) {
        entry.heartbeats?.cancel()
        entry.heartbeatWake?.close()
        val wake = Channel<Unit>(Channel.CONFLATED)
        entry.heartbeatWake = wake
        entry.heartbeats = scope.launch {
            while (isActive && sessionWatches[entry.sessionId] === entry && entry.heartbeatWake === wake) {
                val policy = watchHub.leasePolicy(entry.sessionId)
                val control = try {
                    lease(entry.sessionId, acquire = policy.mayAcquire)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
                // A lease request can finish after the final subscriber leaves
                // or another heartbeat replaces this one. Do not publish stale
                // control state or wait on the retired wake channel.
                if (!isActive || sessionWatches[entry.sessionId] !== entry || entry.heartbeatWake !== wake) break
                if (control != null) emitSessionWatch(entry, "control", control)
                if (!awaitSessionHeartbeatWake(wake, policy.intervalMs)) break
            }
        }
    }

    private fun wakeSessionHeartbeat(sessionId: String) {
        sessionWatches[sessionId]?.heartbeatWake?.trySend(Unit)
    }

    private fun stopSessionWatch(sessionId: String, release: Boolean) {
        val entry = sessionWatches.remove(sessionId) ?: return
        entry.watcher?.cancel()
        entry.heartbeats?.cancel()
        entry.heartbeatWake?.close()
        entry.pendingSnapshot?.cancel()
        GatewayNotifications.manager(context).cancel(("progress:$sessionId").hashCode())
        if (watched == sessionId && watchHub.subscription(ContextRegistry.PRIMARY_CONTEXT_ID) == null) {
            watched = null
            latest = null
        }
        val oldApi = activeApi
        val generation = heldGenerations.remove(sessionId)
        // Only the final subscription reaches here, so another context's lease
        // heartbeat cannot be invalidated by this context closing.
        if (release && generation != null && oldApi != null) scope.launch {
            runCatching { oldApi.releaseControl(sessionId, local.clientId, generation) }
        }
    }
    suspend fun lease(id: String, acquire: Boolean = false, force: Boolean = false, commandApi: PircApi? = null): Map<String, Any?> {
        val api = commandApi ?: api()
        var lease = api.control(id, local.clientId)
        lease = when {
            force -> api.acquireControl(id, local.clientId, true)
            lease.heldByCurrentClient && lease.generation != null -> api.heartbeatControl(id, local.clientId, lease.generation!!)
            acquire && lease.free -> api.acquireControl(id, local.clientId, false)
            else -> lease
        }
        if (lease.heldByCurrentClient && lease.generation != null) heldGenerations[id] = lease.generation!!
        else heldGenerations.remove(id)
        return mapOf("held" to lease.heldByCurrentClient, "holder" to lease.holderClientId,
            "generation" to lease.generation, "expiresAt" to lease.expiresAt)
    }
    suspend fun generation(id: String, commandApi: PircApi? = null): Long {
        val lease = lease(id, acquire = true, commandApi = commandApi)
        if (lease["held"] != true) throw ApiException(409, "lost_control", "控制權在其他裝置，請先明確取得控制權")
        return lease["generation"] as Long
    }
    fun unknownCommand(id: String) = uncertain.contains("command:$id") || uncertain.contains("command-stop:$id")
    suspend fun acknowledgeCommand(id: String): Boolean {
        val expectedStamp = ensurePairingStamp()
        return commandLock.withLock {
            stopCommandLock.withLock {
                requirePairingStamp(expectedStamp, pairingIdentity.getString("stamp", null))
                // Never reconcile a still-running POST or another pairing's marker.
                uncertain.edit().remove("command:$id").remove("command-stop:$id").commit()
            }
        }
    }
    suspend fun command(id: String, payload: Map<*, *>, commandId: String): Map<String, Any?> {
        // Stop must reach the server even while a different command POST is
        // waiting for its response. Independent durable markers prevent either
        // completion from clearing the other's unresolved delivery state.
        val expectedStamp = ensurePairingStamp()
        val commandApi = api()
        val stopping = payload["type"] == "stop"
        val lock = if (stopping) stopCommandLock else commandLock
        return lock.withLock { deliverCommand(id, payload, commandId, stopping, commandApi, expectedStamp) }
    }
    private suspend fun deliverCommand(id: String, payload: Map<*, *>, commandId: String, stopping: Boolean, api: PircApi, expectedStamp: String): Map<String, Any?> {
        fun currentPairing() = expectedStamp == pairingIdentity.getString("stamp", null)
        requirePairingStamp(expectedStamp, pairingIdentity.getString("stamp", null))
        if (unknownCommand(id) && payload["type"] != "stop") throw ApiException(409, "outcome_unknown", "先前送出結果不明，請先檢查對話並確認繼續")
        val generation = generation(id, commandApi = api)
        requirePairingStamp(expectedStamp, pairingIdentity.getString("stamp", null))
        val key = if (stopping) "command-stop:$id" else "command:$id"
        val pendingBefore = uncertain.getString(key, null)
        uncertain.edit().putString(key, commandId).commit()
        val settingsOwner = sessionWatches[id]
        val observedApprovalRevision = settingsOwner?.composerSettings?.approvalObservationRevision
        try {
            val receipt = api.command(id, local.clientId, generation, commandId, payload.json() as JsonObject)
            if (currentPairing() && receipt.status == "accepted") {
                sessionWatches[id]?.takeIf { payload["type"] != "set_approval_mode" || it === settingsOwner }?.let { entry ->
                    val revision = entry.composerSettings.revision
                    if (entry.composerSettings.accepted(payload, observedApprovalRevision ?: entry.composerSettings.approvalObservationRevision)) {
                        entry.latest?.let { cached ->
                            val updated = entry.composerSettings.mergeFetched(cached, revision)
                            entry.latest = updated
                            updatePrimaryProjection(entry)
                            emitSessionWatch(entry, "snapshot", updated.wire())
                        }
                    }
                }
            }
            if (currentPairing() && receipt.status != "outcome_unknown") {
                if (pendingBefore != null) uncertain.edit().putString(key, pendingBefore).commit()
                else uncertain.edit().remove(key).commit()
            }
            return mapOf("commandId" to receipt.commandId, "status" to receipt.status, "message" to receipt.message)
        } catch (e: ApiException) {
            if (currentPairing() && e.status in 400..499) {
                if (pendingBefore != null) uncertain.edit().putString(key, pendingBefore).commit()
                else uncertain.edit().remove(key).commit()
            }
            throw e
        }
    }
    suspend fun answer(id: String, interactionId: String, epoch: String, pairingStamp: String, data: Map<*, *>): Map<String, Any?> = answerLock.withLock {
        validatePairingStamp(pairingStamp)
        val key = "$id:$interactionId:$epoch"
        // Check the durable marker before reading the question. If the prior
        // POST was accepted, a fresh snapshot may no longer contain it; the
        // caller still needs the explicit reconciliation action in that case.
        if (uncertain.getBoolean(key, false)) throw ApiException(409, "outcome_unknown", "先前回答結果不明，請檢查最新狀態，不可重送")
        val before = snapshot(id)
        val answer = checkedAnswer(before, interactionId, epoch, data)
        val generation = answerGeneration(interactionId) { generation(id) }
        // Persist before the POST: process death must not turn uncertainty into a retry.
        if (!uncertain.edit().putBoolean(key, true).commit())
            throw ApiException(503, "outcome_unknown", "無法保存回答狀態，回答未送出；請檢查最新狀態")
        try {
            api().answer(id, interactionId, local.clientId, generation, answer)
            if (!uncertain.edit().remove(key).commit())
                throw ApiException(503, "outcome_unknown", "回答可能已收到，請檢查最新狀態")
        } catch (e: ApiException) {
            if (e.status in 400..499 && !uncertain.edit().remove(key).commit())
                throw ApiException(503, "outcome_unknown", "回答未送出但無法保存狀態，請檢查最新狀態")
            throw e
        }
        snapshot(id).wire()
    }
    /**
     * Allow or deny a relayed delegation approval from outside its chat (the
     * session list's "Needs you"). The exact question is read from the chat's
     * fresh snapshot, then answered like any other, without the lease.
     */
    suspend fun answerRelayed(chatId: String, interactionId: String, pairingStamp: String, confirmed: Boolean): Map<String, Any?> {
        if (!isRelayedInteraction(interactionId))
            throw ApiException(400, "invalid_answer", "Not a relayed approval")
        val question = snapshot(chatId).interactions.find { it.id == interactionId }
            ?: throw ApiException(409, "stale", "問題已不存在，請重新整理")
        return answer(chatId, interactionId, question.runnerEpoch, pairingStamp, mapOf("confirmed" to confirmed))
    }
    /** `POST /api/delegations/:id/stop`; no lease. */
    suspend fun stopDelegation(delegationId: String): Map<String, Any?> =
        mapOf("status" to api().stopDelegation(delegationId))
    suspend fun reconcileAnswer(id: String, interactionId: String, epoch: String, pairingStamp: String): Map<String, Any?> = answerLock.withLock {
        validatePairingStamp(pairingStamp)
        // Do not clear the durable uncertainty marker until this fresh read has
        // proved what happened to this exact question on this exact session.
        val before = snapshot(id)
        val result = answerReconciliation(before, id, interactionId, epoch)
        if (!uncertain.edit().remove("$id:$interactionId:$epoch").commit())
            throw ApiException(503, "outcome_unknown", "無法保存最新回答狀態，請稍後再檢查")
        mapOf(
            "sessionId" to id,
            "status" to if (result.pending) "pending" else "resolved",
            "interaction" to result.interaction?.wire(),
        )
    }
    private class Resnapshot: Exception()
}
