package dev.pirc.pirc_mobile

/** One context's event identity for a pooled session stream. */
internal data class SessionWatchSubscription(
    val sessionId: String,
    val contextId: String,
    val eventTag: String?,
)

internal data class SessionLeasePolicy(
    val mayAcquire: Boolean,
    val intervalMs: Long,
)

internal fun sessionLeasePolicy(visible: Boolean): SessionLeasePolicy =
    if (visible) SessionLeasePolicy(mayAcquire = true, intervalMs = 10_000L)
    else SessionLeasePolicy(mayAcquire = false, intervalMs = 15_000L)

/**
 * Refcounts session streams across native contexts. It owns no coroutine or
 * Android state, so watcher lifecycle decisions can be tested without a
 * GatewayRuntime or device.
 */
internal class SessionWatchHub {
    internal data class Change(
        val startedSessions: List<String> = emptyList(),
        val stoppedSessions: List<String> = emptyList(),
        val subscription: SessionWatchSubscription? = null,
        val removed: Boolean = false,
        val staleTag: Boolean = false,
        val staleVisibility: Boolean = false,
        val leasePolicyChangedSessions: List<String> = emptyList(),
        val sessionDeleted: Boolean = false,
    )

    private val byContext = linkedMapOf<String, SessionWatchSubscription>()
    private val bySession = linkedMapOf<String, LinkedHashMap<String, SessionWatchSubscription>>()
    private val visibilityByContext = linkedMapOf<String, Boolean>()
    private val visibilityRevisionByContext = linkedMapOf<String, Long>()
    private val deletedSessions = linkedSetOf<String>()

    @Synchronized
    fun subscribe(
        sessionId: String,
        contextId: String,
        eventTag: String?,
    ): Change {
        require(sessionId.isNotBlank()) { "sessionId is required" }
        require(contextId.isNotBlank()) { "contextId is required" }
        if (sessionId in deletedSessions) return Change(sessionDeleted = true)
        val old = byContext[contextId]
        if (old?.sessionId == sessionId && old.eventTag == eventTag) {
            return Change(subscription = old)
        }

        visibilityByContext.putIfAbsent(contextId, true)
        val affectedSessions = listOfNotNull(old?.sessionId, sessionId).distinct()
        val previousPolicies = affectedSessions.associateWith(::leasePolicy)

        val stopped = mutableListOf<String>()
        if (old != null) remove(old)?.let(stopped::add)

        val subscription = SessionWatchSubscription(sessionId, contextId, eventTag)
        val subscribers = bySession.getOrPut(sessionId) { linkedMapOf() }
        val starts = if (subscribers.isEmpty()) listOf(sessionId) else emptyList()
        subscribers[contextId] = subscription
        byContext[contextId] = subscription
        return Change(
            startedSessions = starts,
            stoppedSessions = stopped,
            subscription = subscription,
            removed = old != null,
            leasePolicyChangedSessions = affectedSessions.filter {
                previousPolicies[it] != leasePolicy(it)
            },
        )
    }

    /** Retires all subscriptions for a deleted session and blocks stale re-watches. */
    @Synchronized
    fun markDeleted(sessionId: String): Change {
        require(sessionId.isNotBlank()) { "sessionId is required" }
        deletedSessions.add(sessionId)
        val removedSubscriptions = bySession.remove(sessionId)?.values?.toList().orEmpty()
        removedSubscriptions.forEach { subscription ->
            if (byContext[subscription.contextId] == subscription) {
                byContext.remove(subscription.contextId)
            }
        }
        return Change(
            stoppedSessions = if (removedSubscriptions.isNotEmpty()) listOf(sessionId) else emptyList(),
            removed = removedSubscriptions.isNotEmpty(),
            sessionDeleted = true,
        )
    }

    /** A supplied tag protects a newer subscription from a delayed unwatch. */
    @Synchronized
    fun unsubscribe(contextId: String, eventTag: String? = null): Change {
        val current = byContext[contextId] ?: return Change()
        if (eventTag != null && current.eventTag != eventTag) {
            return Change(subscription = current, staleTag = true)
        }
        val previousPolicy = leasePolicy(current.sessionId)
        val stopped = remove(current)
        return Change(
            stoppedSessions = listOfNotNull(stopped),
            removed = true,
            leasePolicyChangedSessions = if (previousPolicy != leasePolicy(current.sessionId)) {
                listOf(current.sessionId)
            } else {
                emptyList()
            },
        )
    }

    @Synchronized
    fun removeContext(contextId: String): Change {
        val change = unsubscribe(contextId)
        visibilityByContext.remove(contextId)
        visibilityRevisionByContext.remove(contextId)
        return change
    }

    /** Update one view's visibility without changing its stream subscription. */
    @Synchronized
    fun setVisibility(
        contextId: String,
        visible: Boolean,
        visibilityRevision: Long,
        eventTag: String? = null,
    ): Change {
        require(contextId.isNotBlank()) { "contextId is required" }
        require(visibilityRevision >= 0) { "visibilityRevision must be nonnegative" }
        val current = byContext[contextId]
        if ((current != null && current.eventTag != eventTag) ||
            (current == null && eventTag != null)
        ) {
            return Change(subscription = current, staleTag = true)
        }
        val lastRevision = visibilityRevisionByContext[contextId]
        if (lastRevision != null && visibilityRevision <= lastRevision) {
            return Change(subscription = current, staleVisibility = true)
        }
        visibilityRevisionByContext[contextId] = visibilityRevision

        val previousVisible = visibilityByContext[contextId] ?: true
        if (previousVisible == visible) return Change(subscription = current)
        val previousPolicy = current?.let { leasePolicy(it.sessionId) }
        visibilityByContext[contextId] = visible
        val changedSessions = current?.sessionId?.let { sessionId ->
            if (previousPolicy != leasePolicy(sessionId)) listOf(sessionId) else emptyList()
        }.orEmpty()
        return Change(
            subscription = current,
            leasePolicyChangedSessions = changedSessions,
        )
    }

    @Synchronized
    fun contextVisible(contextId: String): Boolean = visibilityByContext[contextId] ?: true

    @Synchronized
    fun visibilityRevision(contextId: String): Long? = visibilityRevisionByContext[contextId]

    @Synchronized
    fun hasVisibleSubscriber(sessionId: String): Boolean =
        bySession[sessionId]?.values?.any { contextVisible(it.contextId) } == true

    @Synchronized
    fun leasePolicy(sessionId: String): SessionLeasePolicy =
        sessionLeasePolicy(hasVisibleSubscriber(sessionId))

    /** Clears every pooled stream after account rotation or engine teardown. */
    @Synchronized
    fun clear(): Change {
        val stopped = bySession.keys.toList()
        byContext.clear()
        bySession.clear()
        visibilityByContext.clear()
        visibilityRevisionByContext.clear()
        deletedSessions.clear()
        return Change(stoppedSessions = stopped, removed = stopped.isNotEmpty())
    }

    @Synchronized
    fun subscription(contextId: String): SessionWatchSubscription? = byContext[contextId]

    @Synchronized
    fun subscribers(sessionId: String): List<SessionWatchSubscription> =
        bySession[sessionId]?.values?.toList().orEmpty()

    @Synchronized
    fun isCurrent(
        sessionId: String,
        contextId: String,
        eventTag: String?,
    ): Boolean = byContext[contextId] == SessionWatchSubscription(sessionId, contextId, eventTag)

    @Synchronized
    fun sessionCount(): Int = bySession.size

    @Synchronized
    fun subscriberCount(sessionId: String): Int = bySession[sessionId]?.size ?: 0

    private fun remove(subscription: SessionWatchSubscription): String? {
        byContext.remove(subscription.contextId)
        val subscribers = bySession[subscription.sessionId] ?: return null
        subscribers.remove(subscription.contextId)
        if (subscribers.isNotEmpty()) return null
        bySession.remove(subscription.sessionId)
        return subscription.sessionId
    }
}


/** Builds the stable Flutter event envelope for scoped native subscriptions. */
internal fun scopedEventWire(
    type: String,
    data: Any?,
    sessionId: String?,
    contextId: String? = null,
    watchTag: String? = null,
    scopeName: String? = null,
): Map<String, Any?> {
    val event = linkedMapOf<String, Any?>(
        "type" to type,
        "sessionId" to sessionId,
        "data" to data,
    )
    if (contextId != null && contextId != ContextRegistry.PRIMARY_CONTEXT_ID) {
        event["contextId"] = contextId
    }
    if (watchTag != null) event["watchTag"] = watchTag
    if (scopeName != null) event["scope"] = scopeName
    return event
}
