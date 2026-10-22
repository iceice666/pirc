package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * What the engine shows of a session (plans/rewrite/12-android.md, decision
 * 4): its record, its run and its runner, for the header and the panes. No
 * transcript: sessions are workers' machinery, and their conversations
 * happen in rooms and threads.
 */
data class SessionMeta(
    val session: JsonObject,
    val run: JsonObject?,
    val runnerStatus: String?,
    val runnerEpoch: String?,
    val cursor: String?,
) {
    fun wire(): Map<String, Any?> = mapOf(
        "session" to session.wire(),
        "run" to run?.wire(),
        "runnerStatus" to runnerStatus,
        "runnerEpoch" to runnerEpoch,
        "cursor" to cursor,
    )

    companion object {
        /** From `GET /api/sessions/:id/snapshot`, keeping only what the engine shows. */
        fun from(snapshot: JsonElement?): SessionMeta = readingReply {
            SessionMeta(
                session = snapshot["session"] as? JsonObject ?: error("no session in the snapshot"),
                run = snapshot["run"] as? JsonObject,
                runnerStatus = snapshot["runnerStatus"].text,
                runnerEpoch = snapshot["runnerEpoch"].text,
                cursor = snapshot["cursor"].text,
            )
        }
    }
}

/**
 * The session domain: a session's watch (snapshot, then what its stream
 * says changed) and its control lease for the panes that act (terminals),
 * split out of GatewayRuntime, which keeps the transport (decision 2).
 */
class SessionRuntime internal constructor(private val gateway: GatewayRuntime) {
    private val local get() = gateway.local
    private val scope get() = gateway.scope
    private val activeApi get() = gateway.activeApiOrNull
    private suspend fun api() = gateway.api()
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
        var latest: SessionMeta? = null,
        var connection: String = "connecting",
        var watcher: Job? = null,
        var heartbeats: Job? = null,
        var heartbeatWake: Channel<Unit>? = null,
        var pendingSnapshot: Job? = null,
    )
    private val watchHub = SessionWatchHub()
    private val sessionWatches = mutableMapOf<String, SessionWatchState>()
    internal var watched: String? = null
    private val heldGenerations = mutableMapOf<String, Long>()

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
    }

    private fun emitToSubscriber(subscription: SessionWatchSubscription, type: String, data: Any?) {
        val lease = try {
            contextLease(subscription.contextId)
        } catch (_: ApiException) {
            return
        }
        scope.launch {
            if (!contextLeaseIsCurrent(lease) ||
                !watchHub.isCurrent(subscription.sessionId, subscription.contextId, subscription.eventTag)
            ) return@launch
            emitEvent(type, data, subscription.sessionId, contextId = subscription.contextId, eventTag = subscription.eventTag)
        }
    }

    private fun emitSessionWatch(entry: SessionWatchState, type: String, data: Any?) {
        if (sessionWatches[entry.sessionId] !== entry) return
        watchHub.subscribers(entry.sessionId).forEach { emitToSubscriber(it, type, data) }
    }

    suspend fun snapshot(id: String): SessionMeta = SessionMeta.from(api().snapshot(id))

    /** True only when at least one subscribed app context currently shows this session. */
    fun hasVisibleSessionSubscriber(sessionId: String): Boolean = watchHub.hasVisibleSubscriber(sessionId)

    fun watch(id: String, contextId: String? = null, eventTag: String? = null) {
        val context = contextLease(contextId)
        require(eventTag == null || (eventTag.isNotBlank() && eventTag.length <= 128)) { "Invalid eventTag" }
        val scopedTag = eventTag ?: context.contextId.takeUnless {
            it == ContextRegistry.PRIMARY_CONTEXT_ID
        }?.let { UUID.randomUUID().toString() }
        val change = watchHub.subscribe(id, context.contextId, scopedTag)
        if (change.sessionDeleted) {
            emitEvent("sessionDeleted", mapOf("sessionId" to id), id, contextId = context.contextId, eventTag = scopedTag)
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
        }
        change.leasePolicyChangedSessions
            .filterNot { it == id && startsWatcher }
            .forEach(::wakeSessionHeartbeat)
    }

    fun unwatch(contextId: String?, eventTag: String? = null, release: Boolean = false) {
        val context = contextLease(contextId)
        val current = watchHub.subscription(context.contextId) ?: return
        if (eventTag != null && current.eventTag != eventTag) return
        val change = watchHub.unsubscribe(context.contextId, eventTag)
        change.stoppedSessions.forEach { stopSessionWatch(it, release) }
        change.leasePolicyChangedSessions.forEach(::wakeSessionHeartbeat)
        if (context.contextId == ContextRegistry.PRIMARY_CONTEXT_ID) {
            watched = watchHub.subscription(ContextRegistry.PRIMARY_CONTEXT_ID)?.sessionId
        }
    }

    fun setWatchVisibility(contextId: String?, visible: Boolean, visibilityRevision: Long, eventTag: String? = null): Boolean {
        val context = contextLease(contextId)
        require(eventTag == null || (eventTag.isNotBlank() && eventTag.length <= 128)) { "Invalid eventTag" }
        val change = watchHub.setVisibility(context.contextId, visible, visibilityRevision, eventTag)
        change.leasePolicyChangedSessions.forEach(::wakeSessionHeartbeat)
        return !change.staleTag && !change.staleVisibility
    }

    /** Read the session again soon, once for a burst of changes. */
    private fun refreshSoon(entry: SessionWatchState) {
        if (entry.pendingSnapshot?.isActive == true) return
        entry.pendingSnapshot = scope.launch {
            delay(250)
            if (sessionWatches[entry.sessionId] !== entry) return@launch
            try {
                val meta = snapshot(entry.sessionId)
                if (sessionWatches[entry.sessionId] !== entry) return@launch
                entry.latest = meta
                emitSessionWatch(entry, "snapshot", meta.wire())
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The next change or reconnect reads it again.
            }
        }
    }

    private fun startSessionWatch(entry: SessionWatchState) {
        entry.connection = "connecting"
        entry.watcher = scope.launch {
            var attempt = 0
            while (isActive && sessionWatches[entry.sessionId] === entry) {
                try {
                    entry.connection = "connecting"
                    emitSessionWatch(entry, "connection", entry.connection)
                    val meta = snapshot(entry.sessionId)
                    if (sessionWatches[entry.sessionId] !== entry) break
                    entry.latest = meta
                    emitSessionWatch(entry, "snapshot", meta.wire())
                    EventStream(api(), onChange = { type ->
                        scope.launch {
                            if (sessionWatches[entry.sessionId] === entry) emitSessionWatch(entry, "indexChange", type)
                        }
                    }).open(entry.sessionId, meta.cursor).collect { signal ->
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
                            is StreamSignal.Event -> when (val change = sessionChange(signal.frame)) {
                                SessionChange.Deleted -> {
                                    emitSessionWatch(entry, "sessionDeleted", mapOf("sessionId" to entry.sessionId))
                                    watchHub.markDeleted(entry.sessionId)
                                    stopSessionWatch(entry.sessionId, release = false)
                                }
                                is SessionChange.PanelChanged -> emitSessionWatch(entry, "panelChange", change.sections)
                                is SessionChange.Renamed -> entry.latest?.let { latest ->
                                    val renamed = latest.copy(
                                        session = JsonObject(latest.session + ("name" to JsonPrimitive(change.name))),
                                    )
                                    entry.latest = renamed
                                    emitSessionWatch(entry, "snapshot", renamed.wire())
                                }
                                SessionChange.Refresh -> refreshSoon(entry)
                                SessionChange.None -> Unit
                            }
                        }
                    }
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
                // or another heartbeat replaces this one.
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
        if (watched == sessionId && watchHub.subscription(ContextRegistry.PRIMARY_CONTEXT_ID) == null) watched = null
        val oldApi = activeApi
        val generation = heldGenerations.remove(sessionId)
        // Only the final subscription reaches here, so another context's lease
        // heartbeat cannot be invalidated by this context closing.
        if (release && generation != null && oldApi != null) scope.launch {
            runCatching { oldApi.releaseControl(sessionId, local.clientId, generation) }
        }
    }

    /** The control lease the panes act under (a terminal needs it). */
    suspend fun lease(id: String, acquire: Boolean = false, force: Boolean = false): Map<String, Any?> {
        val api = api()
        var lease = api.control(id, local.clientId)
        lease = when {
            force -> api.acquireControl(id, local.clientId, true)
            lease.heldByCurrentClient && lease.generation != null -> api.heartbeatControl(id, local.clientId, lease.generation)
            acquire && lease.free -> api.acquireControl(id, local.clientId, false)
            else -> lease
        }
        if (lease.heldByCurrentClient && lease.generation != null) heldGenerations[id] = lease.generation
        else heldGenerations.remove(id)
        return mapOf(
            "held" to lease.heldByCurrentClient,
            "holder" to lease.holderClientId,
            "generation" to lease.generation,
            "expiresAt" to lease.expiresAt,
        )
    }

    /** `POST /api/delegations/:id/stop`; no lease. */
    suspend fun stopDelegation(delegationId: String): Map<String, Any?> =
        mapOf("status" to api().stopDelegation(delegationId))
}
