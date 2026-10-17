package dev.pirc.android.push

import android.content.Context
import android.os.Build
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.PircApi
import dev.pirc.android.core.Pairing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import java.io.IOException
import java.util.UUID

/** Where this phone stands with push notifications. */
sealed interface PushStatus {
    data object Off : PushStatus
    /** Registered with the distributor; its endpoint is on its way to the gateway. */
    data object Connecting : PushStatus
    /** The gateway has this phone's endpoint. */
    data class On(val distributor: String?) : PushStatus
    data class Failed(val reason: String) : PushStatus
}

/**
 * This phone's UnifiedPush registration (docs/history/cron.md, phase 4): the
 * distributor (ntfy, ...) gives an endpoint with Web Push keys, which goes to
 * the gateway; the gateway pushes there, encrypted for this app.
 */
object PushRegistration {
    private const val PREFS = "push"
    private const val ENDPOINT = "endpoint"
    private const val ENABLED = "enabled"
    private const val ERROR = "error"
    private const val INSTANCE = "instance"
    private const val RETIRED_INSTANCES = "retired_instances"

    /** Endpoint callbacks come from the push service, which may stop at any time. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val stateLock = Any()
    private val _status = MutableStateFlow<PushStatus>(PushStatus.Off)
    val status: StateFlow<PushStatus> = _status.asStateFlow()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Read the stored state (once, at start). */
    fun load(context: Context) {
        synchronized(stateLock) {
            val prefs = prefs(context)
            val error = prefs.getString(ERROR, null)
            _status.value = when {
                error != null -> PushStatus.Failed(error)
                prefs.getString(ENDPOINT, null) != null -> PushStatus.On(UnifiedPush.getAckDistributor(context))
                prefs.getBoolean(ENABLED, false) -> PushStatus.Connecting
                else -> PushStatus.Off
            }
        }
    }

    /** Non-secret gateway id for identifying this phone in notification settings. */
    fun subscriptionId(context: Context): String? = synchronized(stateLock) {
        prefs(context).getString("subscription_id", null)
    }

    /** Decrypted messages still belong to a particular live registration attempt. */
    internal fun acceptsMessage(context: Context, instance: String): Boolean = synchronized(stateLock) {
        registrationSnapshot(context, pairing = null).acceptsCallback(instance)
    }

    /** The distributors installed on this phone. */
    fun distributors(context: Context): List<String> = UnifiedPush.getDistributors(context)

    /**
     * Register with the chosen distributor, signed for the gateway's VAPID key.
     * The endpoint arrives later in [onEndpoint].
     */
    suspend fun enable(context: Context, api: PircApi) {
        val pairing = withContext(Dispatchers.IO) { KeystoreCredentialStore(context).load() }
            ?: throw IllegalStateException("Pairing changed; pair this device again.")
        check(api.pairing == pairing) { "Pairing changed; reopen notification settings and retry." }
        val attempt = PushRegistrationAttempt(UUID.randomUUID().toString(), pairing)
        val previous = synchronized(stateLock) {
            val state = prefs(context)
            val previousInstance = unifiedPushInstanceToUnregister(
                instance = state.getString(INSTANCE, null),
                enabled = state.getBoolean(ENABLED, false),
                endpoint = state.getString(ENDPOINT, null),
                error = state.getString(ERROR, null),
            )
            val previousEndpoint = state.getString(ENDPOINT, null)
            // Keep old connector rows around until the replacement register call succeeds.
            // UnifiedPush.unregister removes the global saved distributor when it removes
            // the last registration; a later register then has no distributor to target.
            val retiredInstances = state.getStringSet(RETIRED_INSTANCES, emptySet())
                .orEmpty()
                .toMutableSet()
            previousInstance?.takeIf { it != attempt.instance }?.let(retiredInstances::add)
            state.edit()
                .putBoolean(ENABLED, true)
                .putString(INSTANCE, attempt.instance)
                .putStringSet(RETIRED_INSTANCES, retiredInstances)
                .remove(ENDPOINT)
                .remove("subscription_id")
                .remove(ERROR)
                .apply()
            _status.value = PushStatus.Connecting
            previousEndpoint to retiredInstances.toSet()
        }

        previous.first?.let { oldEndpoint ->
            runCatching { api.unsubscribePush(endpoint = oldEndpoint) }
        }

        try {
            val key = api.pushInfo().publicKey
            val pairingNow = withContext(Dispatchers.IO) { KeystoreCredentialStore(context).load() }
            val current = synchronized(stateLock) {
                registrationSnapshot(context, pairingNow).accepts(attempt)
            }
            if (!current) return

            // Keep the final guard and broadcast atomic with disable's invalidation,
            // then retire old instances only after the connector accepts this registration.
            val latestPairing = withContext(Dispatchers.IO) { KeystoreCredentialStore(context).load() }
            val replacement = registerBeforeRetiring(
                activeInstance = attempt.instance,
                retiredInstances = previous.second,
                register = {
                    synchronized(stateLock) {
                        if (registrationSnapshot(context, latestPairing).accepts(attempt)) {
                            UnifiedPush.register(context, instance = attempt.instance, vapid = key)
                            true
                        } else {
                            false
                        }
                    }
                },
                unregister = { oldInstance -> UnifiedPush.unregister(context, oldInstance) },
            )
            if (replacement.registered) {
                storeRetiredInstances(context, attempt, replacement.pendingRetiredInstances)
            }
        } catch (error: CancellationException) {
            fail(context, attempt, "Push registration was cancelled.")
            throw error
        } catch (error: Exception) {
            fail(context, attempt, error.message ?: "Could not register with the distributor.")
            throw error
        }
    }

    /** Stop: at the distributor and at the gateway (best effort there). */
    suspend fun disable(context: Context, api: PircApi?) {
        val old = synchronized(stateLock) {
            val state = prefs(context)
            val endpoint = state.getString(ENDPOINT, null)
            val instance = unifiedPushInstanceToUnregister(
                instance = state.getString(INSTANCE, null),
                enabled = state.getBoolean(ENABLED, false),
                endpoint = endpoint,
                error = state.getString(ERROR, null),
            )
            val instances = state.getStringSet(RETIRED_INSTANCES, emptySet())
                .orEmpty()
                .toMutableSet()
            instance?.let(instances::add)
            // Invalidate callbacks before either the distributor or gateway can reply.
            state.edit().clear().apply()
            _status.value = PushStatus.Off
            instances to endpoint
        }
        old.first.forEach { instance ->
            runCatching { UnifiedPush.unregister(context, instance) }
        }
        old.second?.let { endpoint ->
            try {
                api?.unsubscribePush(endpoint = endpoint)
            } catch (_: IOException) {
                /* The subscription also goes with the device token. */
            }
        }
    }

    /** Persist connector IDs whose post-replacement cleanup failed. */
    private suspend fun storeRetiredInstances(
        context: Context,
        attempt: PushRegistrationAttempt,
        retiredInstances: Set<String>,
    ) {
        val pairingNow = withContext(Dispatchers.IO) { KeystoreCredentialStore(context).load() }
        synchronized(stateLock) {
            if (!registrationSnapshot(context, pairingNow).accepts(attempt)) return
            val state = prefs(context)
            if (retiredInstances.isEmpty()) {
                state.edit().remove(RETIRED_INSTANCES).apply()
            } else {
                state.edit().putStringSet(RETIRED_INSTANCES, retiredInstances).apply()
            }
        }
    }

    internal fun onEndpoint(context: Context, instance: String, endpoint: PushEndpoint) {
        val keys = endpoint.pubKeySet
        if (keys == null) {
            fail(context, instance, "The distributor gave no Web Push keys; update it to a UnifiedPush 3 distributor.")
            return
        }
        scope.launch {
            val pairing = KeystoreCredentialStore(context).load() ?: return@launch
            val attempt = PushRegistrationAttempt(instance, pairing)
            if (!isCurrent(context, attempt)) return@launch
            try {
                val saved = PircApi(pairing).subscribePush(endpoint.url, keys.pubKey, keys.auth, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                var previousEndpoint: String? = null
                val accepted = synchronized(stateLock) {
                    val pairingNow = KeystoreCredentialStore(context).load()
                    val state = registrationSnapshot(context, pairingNow)
                    if (state.shouldCompensate(attempt)) {
                        false
                    } else {
                        val currentPrefs = prefs(context)
                        previousEndpoint = currentPrefs.getString(ENDPOINT, null)
                        currentPrefs.edit()
                            .putString(ENDPOINT, endpoint.url)
                            .putString("subscription_id", saved.id)
                            .remove(ERROR)
                            .apply()
                        _status.value = PushStatus.On(UnifiedPush.getAckDistributor(context))
                        true
                    }
                }
                if (!accepted) {
                    // The endpoint was accepted by the gateway after disable/account change.
                    // Compensate with the same account that created the subscription.
                    runCatching { PircApi(pairing).unsubscribePush(endpoint = endpoint.url) }
                    return@launch
                }
                previousEndpoint?.takeIf { it != endpoint.url }?.let { oldEndpoint ->
                    runCatching { PircApi(pairing).unsubscribePush(endpoint = oldEndpoint) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: IOException) {
                fail(
                    context,
                    attempt,
                    (error as? ApiException)?.message ?: "Could not reach the gateway: ${error.message}",
                )
            } catch (error: Exception) {
                fail(context, attempt, error.message ?: "Could not register this endpoint.")
            }
        }
    }

    internal fun fail(context: Context, instance: String, reason: String) {
        synchronized(stateLock) {
            val state = prefs(context)
            if (!registrationSnapshot(context, pairing = null).acceptsCallback(instance)) return
            if (state.getString(ENDPOINT, null) != null) return
            state.edit().putString(ERROR, reason).apply()
            _status.value = PushStatus.Failed(reason)
        }
    }

    private fun fail(context: Context, attempt: PushRegistrationAttempt, reason: String) {
        synchronized(stateLock) {
            // Pair/unpair invalidates the persisted instance before replacing credentials,
            // so the attempt ID is enough here and avoids a Keystore read on the caller thread.
            val state = registrationSnapshot(context, pairing = null)
            if (!state.acceptsCallback(attempt.instance)) return
            val currentPrefs = prefs(context)
            if (currentPrefs.getString(ENDPOINT, null) != null) return
            currentPrefs.edit().putString(ERROR, reason).apply()
            _status.value = PushStatus.Failed(reason)
        }
    }

    internal fun onUnregistered(context: Context, instance: String) {
        synchronized(stateLock) {
            val state = registrationSnapshot(context, pairing = null)
            if (!state.acceptsCallback(instance)) return
            prefs(context).edit().clear().apply()
            _status.value = PushStatus.Off
        }
    }

    private fun isCurrent(context: Context, attempt: PushRegistrationAttempt): Boolean =
        synchronized(stateLock) {
            registrationSnapshot(context, KeystoreCredentialStore(context).load()).accepts(attempt)
        }

    private fun registrationSnapshot(context: Context, pairing: Pairing?): PushRegistrationSnapshot {
        val state = prefs(context)
        return PushRegistrationSnapshot(
            enabled = state.getBoolean(ENABLED, false),
            instance = state.getString(INSTANCE, null),
            pairing = pairing,
        )
    }
}
