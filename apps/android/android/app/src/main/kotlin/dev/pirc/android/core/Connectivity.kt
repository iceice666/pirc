package dev.pirc.android.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the phone has a network, and a wake-up whenever it gets one back
 * (the web's `online` event): event streams waiting out their backoff
 * reconnect at once, and the sessions list reloads.
 */
object Connectivity {
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _regained = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Emits when the network comes back (or the app asks to retry now); never replays. */
    val regained: SharedFlow<Unit> = _regained.asSharedFlow()

    private var started = false

    /** Reconnect now instead of waiting out a backoff (network back, app in the foreground, Retry). */
    fun wake() {
        _regained.tryEmit(Unit)
    }

    /** Follow the default network; idempotent, lives as long as the process. */
    @Synchronized
    fun start(context: Context) {
        if (started) return
        val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
        started = true
        var current: Network? = manager.activeNetwork
        _online.value = current?.let { manager.getNetworkCapabilities(it) }
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ?: false
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _online.value = true
                // Registering reports the current network too: only a new one
                // (back online, or Wi-Fi to mobile data) wakes.
                if (network != current) {
                    current = network
                    wake()
                }
            }

            override fun onLost(network: Network) {
                if (network != current) return
                current = null
                _online.value = false
            }
        })
    }
}
