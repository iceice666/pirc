package dev.pirc.android.push

import android.content.Context
import android.os.Build
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.KeystoreCredentialStore
import dev.pirc.android.core.PircApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import java.io.IOException

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
 * This phone's UnifiedPush registration (plans/cron.md, phase 4): the
 * distributor (ntfy, ...) gives an endpoint with Web Push keys, which goes to
 * the gateway; the gateway pushes there, encrypted for this app.
 */
object PushRegistration {
    private const val PREFS = "push"
    private const val ENDPOINT = "endpoint"
    private const val ENABLED = "enabled"
    private const val ERROR = "error"

    /** Endpoint callbacks come from the push service, which may stop at any time. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _status = MutableStateFlow<PushStatus>(PushStatus.Off)
    val status: StateFlow<PushStatus> = _status.asStateFlow()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Read the stored state (once, at start). */
    fun load(context: Context) {
        val prefs = prefs(context)
        _status.value = when {
            prefs.getString(ERROR, null) != null -> PushStatus.Failed(prefs.getString(ERROR, null)!!)
            prefs.getString(ENDPOINT, null) != null -> PushStatus.On(UnifiedPush.getAckDistributor(context))
            prefs.getBoolean(ENABLED, false) -> PushStatus.Connecting
            else -> PushStatus.Off
        }
    }

    /** The distributors installed on this phone. */
    fun distributors(context: Context): List<String> = UnifiedPush.getDistributors(context)

    /**
     * Register with the chosen distributor, signed for the gateway's VAPID key.
     * The endpoint arrives later in [onEndpoint].
     */
    suspend fun enable(context: Context, api: PircApi) {
        val key = api.pushInfo().publicKey
        prefs(context).edit().putBoolean(ENABLED, true).remove(ERROR).apply()
        _status.value = PushStatus.Connecting
        UnifiedPush.register(context, vapid = key)
    }

    /** Stop: at the distributor and at the gateway (best effort there). */
    suspend fun disable(context: Context, api: PircApi?) {
        val endpoint = prefs(context).getString(ENDPOINT, null)
        UnifiedPush.unregister(context)
        prefs(context).edit().clear().apply()
        _status.value = PushStatus.Off
        if (endpoint != null) try {
            api?.unsubscribePush(endpoint = endpoint)
        } catch (_: IOException) {
            /* the subscription also goes with the device token */
        }
    }

    internal fun onEndpoint(context: Context, endpoint: PushEndpoint) {
        val keys = endpoint.pubKeySet
        if (keys == null) {
            fail(context, "The distributor gave no Web Push keys; update it to a UnifiedPush 3 distributor.")
            return
        }
        scope.launch {
            val pairing = KeystoreCredentialStore(context).load() ?: return@launch
            try {
                PircApi(pairing).subscribePush(endpoint.url, keys.pubKey, keys.auth, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                prefs(context).edit().putString(ENDPOINT, endpoint.url).remove(ERROR).apply()
                _status.value = PushStatus.On(UnifiedPush.getAckDistributor(context))
            } catch (error: IOException) {
                fail(context, (error as? ApiException)?.message ?: "Could not reach the gateway: ${error.message}")
            }
        }
    }

    internal fun fail(context: Context, reason: String) {
        prefs(context).edit().putString(ERROR, reason).apply()
        _status.value = PushStatus.Failed(reason)
    }

    internal fun onUnregistered(context: Context) {
        prefs(context).edit().clear().apply()
        _status.value = PushStatus.Off
    }
}
