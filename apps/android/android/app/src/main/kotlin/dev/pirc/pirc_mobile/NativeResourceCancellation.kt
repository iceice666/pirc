package dev.pirc.pirc_mobile

import java.io.IOException
import java.util.IdentityHashMap
import okhttp3.Call

/**
 * Cancels the HTTP calls belonging to one native document resource request.
 *
 * Preflight, redirect and response-body work share this token. Calls are tracked by identity
 * so detaching one cannot accidentally remove another attached call.
 */
internal class NativeResourceCancellation {
    private val lock = Any()
    private val activeCalls = IdentityHashMap<Call, Unit>()
    private var cancelled = false

    fun cancel() {
        val callsToCancel = synchronized(lock) {
            if (cancelled) return
            cancelled = true
            activeCalls.keys.toList().also { activeCalls.clear() }
        }
        callsToCancel.forEach { it.cancel() }
    }

    /** Returns false and cancels [call] immediately when this token is already cancelled. */
    fun attach(call: Call): Boolean {
        val attached = synchronized(lock) {
            if (cancelled) {
                false
            } else {
                activeCalls[call] = Unit
                true
            }
        }
        if (!attached) call.cancel()
        return attached
    }

    /**
     * Detaches [call], atomically reporting cancellation that raced with its response processing.
     */
    fun detach(call: Call) {
        val wasCancelled = synchronized(lock) {
            activeCalls.remove(call)
            cancelled
        }
        if (wasCancelled) throw IOException("Canceled")
    }

    fun throwIfCancelled() {
        if (synchronized(lock) { cancelled }) throw IOException("Canceled")
    }
}
