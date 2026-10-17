package dev.pirc.pirc_mobile

import android.media.MediaPlayer
import dev.pirc.android.core.ApiException
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.view.TextureRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Native audio/video elements decoded to Flutter textures without a WebView. */
internal class HtmlMediaPlayer(
    private val activity: MainActivity,
    private val engine: FlutterEngine,
    private val runtime: GatewayRuntime,
    private val accountContextMutationLock: Mutex,
) {
    private data class PendingOpen(val contextId: String, val pairingStamp: String)

    private class Entry(
        val player: MediaPlayer,
        val surface: TextureRegistry.SurfaceProducer,
        val file: File,
        val access: GatewayRuntime.HtmlMediaAccess,
        val mimeType: String,
        val finalUrl: String,
        val headersRelevant: Map<String, String>,
        val prepared: CompletableDeferred<Unit> = CompletableDeferred(),
        val released: AtomicBoolean = AtomicBoolean(false),
        var ready: Boolean = false,
        var error: String? = null,
        var rate: Float = 1f,
        var loop: Boolean = false,
        var volume: Float = 1f,
        var muted: Boolean = false,
        var seekSequence: Long = 0L,
        var activeSeek: SeekOperation? = null,
        var queuedSeek: SeekOperation? = null,
    )

    private class SeekOperation(
        val sequence: Long,
        val position: Long,
        val completed: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    private val stateLock = Any()
    private val foregroundLock = Any()
    private val entries = mutableMapOf<Long, Entry>()
    private val pending = mutableMapOf<Job, PendingOpen>()
    private var generation = 0L
    private var disposed = false
    private var foreground = true

    suspend fun open(request: HtmlMediaOpenRequest, contextId: String?): Map<String, Any?> {
        val ownerId = contextId ?: ContextRegistry.PRIMARY_CONTEXT_ID
        val job = currentCoroutineContext().job
        val ticket = synchronized(stateLock) {
            check(!disposed) { "HTML media player is disposed" }
            pending[job] = PendingOpen(ownerId, request.pairingStamp)
            generation
        }

        var file: File? = null
        var producer: TextureRegistry.SurfaceProducer? = null
        var player: MediaPlayer? = null
        var entry: Entry? = null
        var id: Long? = null
        var opened = false
        try {
            val mediaAccess = accountContextMutationLock.withLock {
                runtime.captureHtmlMediaAccess(contextId, request.pairingStamp)
            }
            closeStalePairingStamp(mediaAccess.pairingStamp)
            ensureOpenCurrent(job, ticket)

            val resource = if (request.bytes != null) {
                GatewayRuntime.HtmlMediaResource(
                    bytes = request.bytes,
                    mimeType = checkNotNull(request.mimeType),
                    finalUrl = "",
                    headersRelevant = emptyMap(),
                )
            } else {
                runtime.loadHtmlMediaResource(
                    access = mediaAccess,
                    source = checkNotNull(request.source),
                    baseUrl = request.baseUrl,
                    documentUrl = request.documentUrl,
                )
            }
            val bytes = resource.bytes
            require(bytes.size <= MAX_HTML_MEDIA_BYTES) { "Media exceeds the 32 MiB limit" }
            accountContextMutationLock.withLock { runtime.validateHtmlMediaAccess(mediaAccess) }
            ensureOpenCurrent(job, ticket)

            val directory = File(activity.cacheDir, "native-html-media")
            check(directory.isDirectory || directory.mkdirs()) { "Unable to create media cache" }
            val mediaFile = File.createTempFile("html-media-", ".bin", directory)
            file = mediaFile
            withContext(Dispatchers.IO) {
                mediaFile.outputStream().use { it.write(bytes) }
            }
            currentCoroutineContext().ensureActive()
            accountContextMutationLock.withLock { runtime.validateHtmlMediaAccess(mediaAccess) }
            ensureOpenCurrent(job, ticket)

            val createdProducer = engine.renderer.createSurfaceProducer()
            producer = createdProducer
            val createdPlayer = MediaPlayer()
            player = createdPlayer
            val mediaEntry = Entry(
                player = createdPlayer,
                surface = createdProducer,
                file = mediaFile,
                access = mediaAccess,
                mimeType = resource.mimeType,
                finalUrl = resource.finalUrl,
                headersRelevant = resource.headersRelevant,
                loop = request.loop,
                muted = request.muted,
            )
            entry = mediaEntry
            val textureId = createdProducer.id()
            id = textureId
            synchronized(stateLock) {
                check(!disposed && generation == ticket && job.isActive) {
                    "HTML media request expired"
                }
                entries[textureId] = mediaEntry
            }

            createdProducer.setSize(1, 1)
            createdProducer.setCallback(object : TextureRegistry.SurfaceProducer.Callback {
                override fun onSurfaceAvailable() {
                    if (isCurrent(textureId, mediaEntry)) {
                        runCatching { createdPlayer.setSurface(createdProducer.surface) }
                    }
                }

                override fun onSurfaceCleanup() {
                    if (isCurrent(textureId, mediaEntry)) {
                        runCatching {
                            if (mediaEntry.ready && createdPlayer.isPlaying) createdPlayer.pause()
                            createdPlayer.setSurface(null)
                        }
                    }
                }
            })
            createdPlayer.setSurface(createdProducer.surface)
            createdPlayer.setDataSource(mediaFile.absolutePath)
            createdPlayer.isLooping = request.loop
            val initialVolume = if (request.muted) 0f else 1f
            createdPlayer.setVolume(initialVolume, initialVolume)
            createdPlayer.setOnPreparedListener { preparedPlayer ->
                if (!isCurrent(textureId, mediaEntry)) return@setOnPreparedListener
                mediaEntry.ready = true
                createdProducer.setSize(
                    preparedPlayer.videoWidth.coerceAtLeast(1),
                    preparedPlayer.videoHeight.coerceAtLeast(1),
                )
                mediaEntry.prepared.complete(Unit)
            }
            createdPlayer.setOnSeekCompleteListener {
                onSeekComplete(textureId, mediaEntry)
            }
            createdPlayer.setOnErrorListener { _, what, extra ->
                if (isCurrent(textureId, mediaEntry)) {
                    mediaEntry.error = "Unable to play this media ($what/$extra)."
                    mediaEntry.prepared.completeExceptionally(IllegalStateException(mediaEntry.error))
                }
                true
            }
            createdPlayer.prepareAsync()
            withTimeout(PREPARE_TIMEOUT_MS) { mediaEntry.prepared.await() }
            accountContextMutationLock.withLock { runtime.validateHtmlMediaAccess(mediaAccess) }
            ensureOpenCurrent(job, ticket)
            synchronized(stateLock) {
                check(entries[textureId] === mediaEntry) { "HTML media player expired" }
            }
            val result = status(textureId, mediaEntry)
            opened = true
            return result
        } finally {
            synchronized(stateLock) { pending.remove(job) }
            if (!opened) {
                val textureId = id
                val mediaEntry = entry
                if (textureId != null && mediaEntry != null) {
                    detach(textureId, mediaEntry)
                    release(mediaEntry)
                } else {
                    player?.let { runCatching { it.release() } }
                    producer?.let {
                        runCatching { it.setCallback(null) }
                        runCatching { it.release() }
                    }
                    file?.delete()
                }
            }
        }
    }

    suspend fun control(
        id: Long,
        contextId: String?,
        action: String,
        position: Long?,
        volume: Double?,
        rate: Double?,
        loop: Boolean?,
    ): Map<String, Any?> {
        val entry = synchronized(stateLock) { entries[id] }
            ?: throw IllegalStateException("HTML media player closed")
        requireOwner(entry, contextId)
        if (action == "seek") {
            return seek(id, entry, requireNotNull(position) { "Missing media position" })
        }
        return accountContextMutationLock.withLock {
            runtime.validateHtmlMediaAccess(entry.access)
            checkCurrentEntry(id, entry)
            check(entry.ready) { "HTML media is not ready" }
            entry.error?.let { throw IllegalStateException(it) }
            val media = entry.player
            when (action) {
                "status" -> Unit
                "play" -> synchronized(foregroundLock) {
                    check(foreground) { "HTML media cannot play while the app is backgrounded" }
                    checkCurrentEntry(id, entry)
                    if (!media.isPlaying) media.start()
                }
                "pause" -> if (media.isPlaying) media.pause()
                "volume" -> {
                    val level = requireNotNull(volume) { "Missing media volume" }
                    require(level.isFinite()) { "Media volume must be finite" }
                    val normalized = level.coerceIn(0.0, 1.0).toFloat()
                    entry.volume = normalized
                    entry.muted = normalized == 0f
                    media.setVolume(normalized, normalized)
                }
                "rate" -> {
                    val speed = requireNotNull(rate) { "Missing media rate" }
                    require(speed.isFinite() && speed > 0.0) { "Media rate must be positive and finite" }
                    val nativeSpeed = speed.toFloat()
                    require(nativeSpeed.isFinite() && nativeSpeed > 0f) {
                        "Media rate is outside the supported range"
                    }
                    val wasPlaying = media.isPlaying
                    try {
                        media.playbackParams = media.playbackParams.allowDefaults().setSpeed(nativeSpeed)
                        entry.rate = nativeSpeed
                    } finally {
                        // Applying nonzero playback params can start a paused MediaPlayer.
                        // Keep it paused even if the platform rejects the requested rate.
                        if (!wasPlaying && runCatching { media.isPlaying }.getOrDefault(false)) {
                            runCatching { media.pause() }
                        }
                    }
                }
                "loop" -> {
                    val enabled = requireNotNull(loop) { "Missing loop value" }
                    media.isLooping = enabled
                    entry.loop = enabled
                }
                else -> throw IllegalArgumentException("Unknown HTML media action")
            }
            checkCurrentEntry(id, entry)
            status(id, entry)
        }
    }

    /** Reads the already-loaded resource without issuing another HTTP request. */
    suspend fun read(id: Long, contextId: String?): Map<String, Any?> {
        val entry = synchronized(stateLock) { entries[id] }
            ?: throw IllegalStateException("HTML media player closed")
        requireOwner(entry, contextId)
        accountContextMutationLock.withLock {
            runtime.validateHtmlMediaAccess(entry.access)
            checkCurrentEntry(id, entry)
        }
        val bytes = try {
            withContext(Dispatchers.IO) {
                check(entry.file.isFile) { "Loaded media is unavailable" }
                val data = entry.file.readBytes()
                check(data.size <= MAX_HTML_MEDIA_BYTES) { "Loaded media exceeds the 32 MiB limit" }
                data
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            throw IllegalStateException("Unable to read loaded media")
        }
        accountContextMutationLock.withLock {
            runtime.validateHtmlMediaAccess(entry.access)
            checkCurrentEntry(id, entry)
        }
        return mapOf(
            "bytes" to bytes,
            "mimeType" to entry.mimeType,
            "finalUrl" to entry.finalUrl,
            "headersRelevant" to entry.headersRelevant,
            "pairingStamp" to entry.access.pairingStamp,
        )
    }

    /** Closing is local cleanup; the owning context ID prevents another window closing it. */
    fun close(id: Long, contextId: String?) {
        val entry = synchronized(stateLock) { entries[id] } ?: return
        requireOwner(entry, contextId)
        detach(id, entry)?.let(::release)
    }

    fun closeContext(contextId: String) {
        val normalized = contextId.ifBlank { ContextRegistry.PRIMARY_CONTEXT_ID }
        val (jobs, removed) = synchronized(stateLock) {
            val jobs = pending.filterValues { it.contextId == normalized }.keys.toList()
            val removed = entries.filterValues { it.access.contextLease.contextId == normalized }
            removed.keys.forEach(entries::remove)
            jobs to removed.values.toList()
        }
        jobs.forEach { it.cancel(CancellationException("HTML media context closed")) }
        removed.forEach(::release)
    }

    /** Drops elements and pending opens from previous pairings. */
    fun closeStalePairingStamp(currentStamp: String?) {
        val (jobs, removed) = synchronized(stateLock) {
            val jobs = pending.filterValues { it.pairingStamp != currentStamp }.keys.toList()
            val removed = entries.filterValues { it.access.pairingStamp != currentStamp }
            removed.keys.forEach(entries::remove)
            jobs to removed.values.toList()
        }
        jobs.forEach { it.cancel(CancellationException("HTML media account changed")) }
        removed.forEach(::release)
    }

    fun pauseAll() {
        synchronized(foregroundLock) {
            foreground = false
            val current = synchronized(stateLock) { entries.values.toList() }
            current.forEach { entry ->
                if (entry.ready && entry.error == null) {
                    runCatching { if (entry.player.isPlaying) entry.player.pause() }
                }
            }
        }
    }

    fun resumeAll() {
        synchronized(foregroundLock) { foreground = true }
    }

    fun closeAll() {
        val (jobs, removed) = synchronized(stateLock) {
            generation++
            val jobs = pending.keys.toList()
            val removed = entries.values.toList()
            entries.clear()
            jobs to removed
        }
        jobs.forEach { it.cancel(CancellationException("HTML media invalidated")) }
        removed.forEach(::release)
    }

    fun dispose() {
        synchronized(stateLock) { disposed = true }
        closeAll()
    }

    private fun ensureOpenCurrent(job: Job, ticket: Long) {
        job.ensureActive()
        synchronized(stateLock) {
            check(!disposed && generation == ticket && pending.containsKey(job)) {
                "HTML media request expired"
            }
        }
    }

    private fun isCurrent(id: Long, entry: Entry): Boolean =
        synchronized(stateLock) { entries[id] === entry }

    private fun checkCurrentEntry(id: Long, entry: Entry) {
        check(synchronized(stateLock) { !disposed && entries[id] === entry }) {
            "HTML media player closed"
        }
    }

    private fun requireOwner(entry: Entry, contextId: String?) {
        val requestedOwner = contextId ?: ContextRegistry.PRIMARY_CONTEXT_ID
        if (entry.access.contextLease.contextId != requestedOwner) {
            throw ApiException(409, "context_expired", "HTML media belongs to another native context.")
        }
    }

    private fun status(id: Long, entry: Entry): Map<String, Any?> {
        checkCurrentEntry(id, entry)
        check(entry.ready) { "HTML media is not ready" }
        entry.error?.let { throw IllegalStateException(it) }
        val media = entry.player
        return mapOf(
            "id" to id,
            "width" to media.videoWidth,
            "height" to media.videoHeight,
            "duration" to media.duration.coerceAtLeast(0),
            "position" to media.currentPosition.coerceAtLeast(0),
            "playing" to media.isPlaying,
            "rate" to entry.rate.toDouble(),
            "mimeType" to entry.mimeType,
            "volume" to entry.volume.toDouble(),
            "muted" to entry.muted,
            "loop" to entry.loop,
        )
    }

    /** Serializes native seeks so a stale callback can never acknowledge a newer request. */
    private suspend fun seek(id: Long, entry: Entry, requestedPosition: Long): Map<String, Any?> {
        val operation = accountContextMutationLock.withLock {
            runtime.validateHtmlMediaAccess(entry.access)
            checkCurrentEntry(id, entry)
            check(entry.ready) { "HTML media is not ready" }
            entry.error?.let { throw IllegalStateException(it) }
            val target = requestedPosition.coerceIn(
                0L,
                entry.player.duration.toLong().coerceAtLeast(0L),
            )
            var shouldStart = false
            val next = synchronized(stateLock) {
                check(!disposed && entries[id] === entry) { "HTML media player closed" }
                val created = SeekOperation(++entry.seekSequence, target)
                if (entry.activeSeek == null) {
                    entry.activeSeek = created
                    shouldStart = true
                } else {
                    // Keep only the newest queued target. The displaced caller wakes and
                    // follows the latest ticket instead of receiving an obsolete ack.
                    entry.queuedSeek?.completed?.complete(Unit)
                    entry.queuedSeek = created
                }
                created
            }
            if (shouldStart) startSeek(id, entry, next)
            next
        }

        var waitingFor = operation
        while (true) {
            try {
                withTimeout(SEEK_TIMEOUT_MS) { waitingFor.completed.await() }
            } catch (error: TimeoutCancellationException) {
                // MediaPlayer exposes no cancellation API for an in-flight seek. Releasing
                // the entry is the only way to guarantee it cannot block future seeks.
                detach(id, entry)?.let(::release)
                throw IllegalStateException("HTML media seek timed out")
            } catch (error: CancellationException) {
                abandonSeek(entry, waitingFor)
                throw error
            }

            val decision: Pair<Map<String, Any?>?, SeekOperation?> = accountContextMutationLock.withLock {
                runtime.validateHtmlMediaAccess(entry.access)
                checkCurrentEntry(id, entry)
                check(entry.ready) { "HTML media is not ready" }
                entry.error?.let { throw IllegalStateException(it) }
                val newer = synchronized(stateLock) {
                    sequenceOf(entry.activeSeek, entry.queuedSeek)
                        .filterNotNull()
                        .maxByOrNull { it.sequence }
                        ?.takeIf { it.sequence > waitingFor.sequence }
                }
                if (newer == null) status(id, entry) to null else null to newer
            }
            decision.first?.let { return it }
            waitingFor = checkNotNull(decision.second)
        }
    }

    private fun startSeek(id: Long, entry: Entry, operation: SeekOperation) {
        val shouldStart = synchronized(stateLock) {
            !disposed && entries[id] === entry && entry.activeSeek === operation && !entry.released.get()
        }
        if (!shouldStart) return
        try {
            entry.player.seekTo(operation.position, MediaPlayer.SEEK_CLOSEST)
        } catch (_: Exception) {
            failSeek(id, entry, operation, IllegalStateException("Unable to seek HTML media"))
        }
    }

    private fun onSeekComplete(id: Long, entry: Entry) {
        val (completed, next) = synchronized(stateLock) {
            if (disposed || entries[id] !== entry || entry.released.get()) return
            val completed = entry.activeSeek ?: return
            val next = entry.queuedSeek
            entry.activeSeek = next
            entry.queuedSeek = null
            completed to next
        }
        completed.completed.complete(Unit)
        next?.let { startSeek(id, entry, it) }
    }

    private fun failSeek(id: Long, entry: Entry, operation: SeekOperation, error: Exception) {
        val next = synchronized(stateLock) {
            if (entries[id] !== entry || entry.activeSeek !== operation) return
            val next = entry.queuedSeek
            entry.activeSeek = next
            entry.queuedSeek = null
            next
        }
        operation.completed.completeExceptionally(error)
        next?.let { startSeek(id, entry, it) }
    }

    private fun cancelSeeks(entry: Entry) {
        val pending = synchronized(stateLock) {
            entry.seekSequence++
            listOfNotNull(entry.activeSeek, entry.queuedSeek).also {
                entry.activeSeek = null
                entry.queuedSeek = null
            }
        }
        pending.forEach { it.completed.cancel(CancellationException("HTML media entry released")) }
    }

    private fun abandonSeek(entry: Entry, operation: SeekOperation) {
        synchronized(stateLock) {
            if (entry.queuedSeek === operation) entry.queuedSeek = null
        }
    }

    private fun detach(id: Long, entry: Entry): Entry? = synchronized(stateLock) {
        if (entries[id] !== entry) null else entries.remove(id)
    }

    private fun release(entry: Entry) {
        if (!entry.released.compareAndSet(false, true)) return
        cancelSeeks(entry)
        entry.prepared.cancel()
        runCatching { entry.surface.setCallback(null) }
        runCatching { entry.player.setOnPreparedListener(null) }
        runCatching { entry.player.setOnSeekCompleteListener(null) }
        runCatching { entry.player.setOnErrorListener(null) }
        runCatching { entry.player.release() }
        runCatching { entry.surface.release() }
        entry.file.delete()
    }

    private companion object {
        const val PREPARE_TIMEOUT_MS = 30_000L
        const val SEEK_TIMEOUT_MS = 15_000L
    }
}
