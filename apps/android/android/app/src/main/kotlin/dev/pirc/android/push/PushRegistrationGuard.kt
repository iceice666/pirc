package dev.pirc.android.push

import dev.pirc.android.core.Pairing

/** The connector's instance name before this app started assigning per-attempt IDs. */
internal const val LEGACY_UNIFIED_PUSH_INSTANCE = "default"

/** Identity captured by one asynchronous endpoint registration attempt. */
internal data class PushRegistrationAttempt(
    val instance: String,
    val pairing: Pairing,
)

/** A snapshot of the persisted registration state used to accept service callbacks. */
internal data class PushRegistrationSnapshot(
    val enabled: Boolean,
    val instance: String?,
    val pairing: Pairing?,
) {
    private val effectiveInstance: String
        get() = instance?.takeIf(String::isNotBlank) ?: LEGACY_UNIFIED_PUSH_INSTANCE

    fun acceptsCallback(callbackInstance: String): Boolean =
        enabled && callbackInstance == effectiveInstance

    fun accepts(attempt: PushRegistrationAttempt): Boolean =
        acceptsCallback(attempt.instance) && pairing == attempt.pairing

    /** A successful gateway POST must be deleted if its attempt is no longer current. */
    fun shouldCompensate(attempt: PushRegistrationAttempt): Boolean = !accepts(attempt)
}

/**
 * Return the connector instance that disable must unregister. Missing instance IDs are
 * legacy records written by versions which registered under the connector's default.
 */
internal fun unifiedPushInstanceToUnregister(
    instance: String?,
    enabled: Boolean,
    endpoint: String?,
    error: String?,
): String? = instance?.takeIf(String::isNotBlank)
    ?: if (enabled || endpoint != null || error != null) LEGACY_UNIFIED_PUSH_INSTANCE else null


/**
 * Register a replacement before retiring old instances. The connector clears its saved
 * distributor when unregister removes its last registration, so cleanup must follow a
 * successful replacement. Failed unregisters stay queued for a later retry or disable.
 */
internal data class PushRegistrationReplacementResult(
    val registered: Boolean,
    val pendingRetiredInstances: Set<String>,
)

internal fun registerBeforeRetiring(
    activeInstance: String,
    retiredInstances: Set<String>,
    register: () -> Boolean,
    unregister: (String) -> Unit,
): PushRegistrationReplacementResult {
    if (!register()) {
        return PushRegistrationReplacementResult(
            registered = false,
            pendingRetiredInstances = retiredInstances - activeInstance,
        )
    }

    val pending = mutableSetOf<String>()
    retiredInstances.asSequence()
        .filter { it != activeInstance }
        .forEach { instance ->
            if (runCatching { unregister(instance) }.isFailure) pending += instance
        }
    return PushRegistrationReplacementResult(
        registered = true,
        pendingRetiredInstances = pending,
    )
}
