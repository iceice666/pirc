package dev.pirc.pirc_mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import dev.pirc.android.core.ApiException
import io.flutter.plugin.common.MethodChannel
import java.io.IOException
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class DocumentSavePayload(
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
)

internal fun validateDocumentSavePayload(
    name: String?,
    mimeType: String?,
    bytes: ByteArray?,
): DocumentSavePayload {
    val validName = name?.takeIf(String::isNotBlank)
        ?: throw IllegalArgumentException("name must be a nonempty file name")
    require(validName != "." && validName != "..") {
        "name must be a file name, not a directory"
    }
    require('/' !in validName && '\\' !in validName) {
        "name must be a basename without path separators"
    }
    require(validName.none { it.code <= 0x1f || it.code in 0x7f..0x9f }) {
        "name must not contain control characters"
    }

    val validMimeType = mimeType?.trim()?.lowercase(Locale.ROOT)
        ?: throw IllegalArgumentException("mimeType must be a concrete MIME type")
    require(MIME_TYPE_PATTERN.matches(validMimeType)) {
        "mimeType must be a concrete MIME type"
    }

    val validBytes = bytes
        ?: throw IllegalArgumentException("bytes are required")
    require(validBytes.size <= DocumentSavePicker.MAX_BYTES) {
        "bytes exceed the 32 MiB save limit"
    }

    return DocumentSavePayload(validName, validMimeType, validBytes)
}

private val MIME_TYPE_PATTERN = Regex(
    "[a-z0-9!#\$&^_.+-]+/[a-z0-9!#\$&^_.+-]+",
)

internal fun createDocumentSaveIntent(payload: DocumentSavePayload): Intent =
    Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(payload.mimeType)
        .putExtra(Intent.EXTRA_TITLE, payload.name)

internal fun writeDocumentSaveBytes(
    context: Context,
    destination: Uri,
    bytes: ByteArray,
): Int {
    val output = context.contentResolver.openOutputStream(destination, "w")
        ?: throw IOException("Unable to open the selected document")
    output.use {
        it.write(bytes)
        it.flush()
    }
    return bytes.size
}

/** Owns one ACTION_CREATE_DOCUMENT request and its single MethodChannel result. */
internal class DocumentSavePicker(
    private val activity: Activity,
    private val runtime: GatewayRuntime,
    private val contextGeneration: java.util.concurrent.atomic.AtomicLong,
    private val accountContextMutationLock: Mutex,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) {
    private data class SaveSnapshot(
        val pairingStamp: String,
        val contextId: String?,
        val generation: Long,
    )

    private class PendingSave(
        val result: MethodChannel.Result,
        val payload: DocumentSavePayload,
        val requestedPairingStamp: String,
        val contextId: String?,
        val invocationGeneration: Long,
    ) {
        val completed = AtomicBoolean(false)
        val activityResultConsumed = AtomicBoolean(false)
        var snapshot: SaveSnapshot? = null
        var job: Job? = null
    }

    @Volatile
    private var pending: PendingSave? = null

    @Volatile
    private var disposed = false

    val isPending: Boolean
        get() = pending != null

    fun start(
        result: MethodChannel.Result,
        payload: DocumentSavePayload,
        pairingStamp: String,
        contextId: String?,
    ) {
        if (disposed) {
            result.success(null)
            return
        }
        if (pending != null) {
            result.error("BUSY", NativeI18n.text("A document save picker is already open."), null)
            return
        }
        if (pairingStamp.isBlank()) {
            result.error("INVALID", "pairingStamp is required", null)
            return
        }

        val request = PendingSave(
            result = result,
            payload = payload,
            requestedPairingStamp = pairingStamp,
            contextId = contextId,
            invocationGeneration = contextGeneration.get(),
        )
        pending = request
        request.job = runtime.scope.launch {
            try {
                request.snapshot = accountContextMutationLock.withLock {
                    captureSnapshot(request)
                }
                mainHandler.post {
                    if (!isCurrent(request)) return@post
                    try {
                        activity.startActivityForResult(
                            createDocumentSaveIntent(payload),
                            REQUEST_CODE,
                        )
                    } catch (_: Exception) {
                        finishError(request)
                    }
                }
            } catch (_: CancellationException) {
                finishCancelled(request)
            } catch (_: Exception) {
                finishError(request)
            }
        }
    }

    fun onActivityResult(resultCode: Int, intent: Intent?) {
        val request = pending ?: return
        if (disposed || request.completed.get()) return
        if (!request.activityResultConsumed.compareAndSet(false, true)) return
        if (resultCode != Activity.RESULT_OK) {
            finishCancelled(request)
            return
        }
        val destination = intent?.data
        if (destination == null) {
            finishError(request)
            return
        }

        request.job = runtime.scope.launch {
            try {
                val snapshot = request.snapshot ?: throw StaleDocumentSaveException()
                val written = accountContextMutationLock.withLock {
                    validateSnapshot(request, snapshot)
                    withContext(Dispatchers.IO) {
                        ensureCurrent(request)
                        if (contextGeneration.get() != snapshot.generation) {
                            throw StaleDocumentSaveException()
                        }
                        writeDocumentSaveBytes(activity, destination, request.payload.bytes)
                    }
                }
                finishSuccess(
                    request,
                    mapOf("name" to request.payload.name, "bytesWritten" to written),
                )
            } catch (_: CancellationException) {
                finishCancelled(request)
            } catch (_: Exception) {
                finishError(request)
            }
        }
    }

    /** Invalidates a request when its account/context event stream is torn down. */
    fun cancelForContextInvalidation() {
        pending?.let(::cancelRequest)
    }

    fun dispose() {
        disposed = true
        pending?.let(::cancelRequest)
    }

    private suspend fun captureSnapshot(request: PendingSave): SaveSnapshot {
        ensureCurrent(request)
        val boot = runtime.boot()
        val stamp = boot["pairingStamp"] as? String
        requirePairingStamp(request.requestedPairingStamp, stamp)
        runtime.validateContext(request.contextId)
        ensureInvocationContext(request)
        return SaveSnapshot(
            pairingStamp = stamp ?: throw ApiException(401, "unpaired", NativeI18n.text("Device is not paired")),
            contextId = request.contextId,
            generation = request.invocationGeneration,
        )
    }

    private suspend fun validateSnapshot(request: PendingSave, snapshot: SaveSnapshot) {
        ensureCurrent(request)
        if (contextGeneration.get() != snapshot.generation) {
            throw StaleDocumentSaveException()
        }
        val currentStamp = runtime.boot()["pairingStamp"] as? String
        requirePairingStamp(snapshot.pairingStamp, currentStamp)
        runtime.validateContext(snapshot.contextId)
        if (contextGeneration.get() != snapshot.generation) {
            throw StaleDocumentSaveException()
        }
    }

    private fun ensureInvocationContext(request: PendingSave) {
        if (contextGeneration.get() != request.invocationGeneration) {
            throw StaleDocumentSaveException()
        }
    }

    private fun ensureCurrent(request: PendingSave) {
        if (disposed || request.completed.get() || pending !== request) {
            throw CancellationException("Document save request was cancelled")
        }
        ensureInvocationContext(request)
    }

    private fun isCurrent(request: PendingSave): Boolean =
        !disposed && !request.completed.get() && pending === request

    private fun cancelRequest(request: PendingSave) {
        request.job?.cancel(CancellationException("Document save request cancelled"))
        finishCancelled(request)
    }

    private fun finishCancelled(request: PendingSave) = finish(request) {
        it.success(null)
    }

    private fun finishSuccess(request: PendingSave, value: Any) = finish(request) {
        it.success(value)
    }

    private fun finishError(request: PendingSave) = finish(request) {
        it.error(
            "SAVE",
            NativeI18n.text("Could not save this document. Choose a location and try again."),
            null,
        )
    }

    private inline fun finish(request: PendingSave, crossinline complete: (MethodChannel.Result) -> Unit) {
        if (!request.completed.compareAndSet(false, true)) return
        if (pending === request) pending = null
        mainHandler.post { complete(request.result) }
    }

    private class StaleDocumentSaveException : Exception()

    companion object {
        const val REQUEST_CODE = 82
        const val MAX_BYTES = 32 * 1024 * 1024
    }
}
