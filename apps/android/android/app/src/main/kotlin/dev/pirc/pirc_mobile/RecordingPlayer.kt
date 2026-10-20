package dev.pirc.pirc_mobile

import android.content.ContentValues
import android.media.MediaPlayer
import android.provider.MediaStore
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.view.TextureRegistry
import kotlinx.coroutines.*
import java.io.File

/** Decodes authenticated, session-scoped recordings into Flutter textures. */
class RecordingPlayer(private val activity: MainActivity, private val engine: FlutterEngine) {
    private data class Entry(val player: MediaPlayer, val surface: TextureRegistry.SurfaceProducer, val file: File, val prepared: CompletableDeferred<Unit> = CompletableDeferred(), var ready: Boolean = false, var error: String? = null, var rate: Float = 1f)
    private val entries = mutableMapOf<Long, Entry>()
    private var epoch = 0
    private val runtime get() = GatewayRuntime.get(activity)
    private val pathRule = Regex("""^\.pirc/recordings/[^/]+\.webm$""")
    private suspend fun download(session: String, path: String): File {
        require(pathRule.matches(path)) { "Invalid recording path" }
        val ticket = epoch
        val directory = File(activity.cacheDir, "native-recordings").apply { mkdirs() }
        val file = File.createTempFile("recording-", ".webm", directory)
        try {
            runtime.api().downloadRecording(session, path, file)
            check(ticket == epoch) { "Recording request expired" }
            return file
        } catch (e: Exception) { file.delete(); throw e }
    }
    suspend fun open(session: String, path: String): Map<String, Any?> {
        val file = download(session, path)
        val producer = engine.renderer.createSurfaceProducer()
        val player = MediaPlayer()
        val entry = Entry(player, producer, file)
        val id = producer.id()
        entries[id] = entry
        try {
            producer.setSize(1, 1)
            producer.setCallback(object: TextureRegistry.SurfaceProducer.Callback {
                override fun onSurfaceAvailable() { if (entries[id] === entry) player.setSurface(producer.surface) }
                override fun onSurfaceCleanup() { if (entries[id] === entry) { if (entry.ready && player.isPlaying) player.pause(); player.setSurface(null) } }
            })
            player.setSurface(producer.surface)
            player.setDataSource(file.absolutePath)
            player.setOnPreparedListener {
                entry.ready = true
                producer.setSize(it.videoWidth.coerceAtLeast(1), it.videoHeight.coerceAtLeast(1))
                entry.prepared.complete(Unit)
            }
            player.setOnErrorListener { _, what, extra ->
                entry.error = NativeI18n.text("Unable to play this recording ({0}/{1}).", what, extra)
                entry.prepared.completeExceptionally(IllegalStateException(entry.error))
                true
            }
            player.prepareAsync()
            withTimeout(30000) { entry.prepared.await() }
            check(entries[id] === entry) { "Recording player expired" }
            return status(id)
        } catch (e: Exception) { close(id); throw e }
    }
    fun status(id: Long): Map<String, Any?> {
        val entry = entries[id] ?: error("Recording player closed")
        check(entry.ready) { NativeI18n.text("Recording is not ready") }
        entry.error?.let { error(it) }
        val p = entry.player
        return mapOf("id" to id, "width" to p.videoWidth, "height" to p.videoHeight, "duration" to p.duration, "position" to p.currentPosition, "playing" to p.isPlaying, "rate" to entry.rate)
    }
    fun control(id: Long, action: String, position: Long?, volume: Double?, rate: Double?): Map<String, Any?> {
        val e = entries[id] ?: error("Recording player closed")
        check(e.ready) { NativeI18n.text("Recording is not ready") }; e.error?.let { error(it) }
        when(action) {
            "play" -> e.player.start()
            "pause" -> e.player.pause()
            "seek" -> e.player.seekTo((position ?: 0).coerceIn(0, e.player.duration.toLong()), MediaPlayer.SEEK_CLOSEST)
            "volume" -> { val level = (volume ?: 1.0).coerceIn(0.0, 1.0).toFloat(); e.player.setVolume(level, level) }
            "rate" -> {
                val speed = requireNotNull(rate) { "Missing playback rate" }
                require(speed in listOf(0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)) { NativeI18n.text("Unsupported playback rate") }
                val wasPlaying = e.player.isPlaying
                try {
                    e.player.playbackParams = e.player.playbackParams.allowDefaults().setSpeed(speed.toFloat())
                    e.rate = speed.toFloat()
                } finally {
                    // MediaPlayer may start when nonzero playback parameters are
                    // applied. HTML video preserves pause when changing speed.
                    if (!wasPlaying && e.player.isPlaying) e.player.pause()
                }
            }
            "status" -> Unit
            else -> error("Unknown recording action")
        }
        return status(id)
    }
    fun close(id: Long) {
        val entry = entries.remove(id) ?: return
        entry.prepared.cancel()
        entry.surface.setCallback(null)
        entry.player.release(); entry.surface.release(); entry.file.delete()
    }
    fun pauseAll() { entries.values.forEach { if (it.ready && it.error == null && it.player.isPlaying) it.player.pause() } }
    fun closeAll() { epoch++; entries.keys.toList().forEach(::close) }
    suspend fun save(session: String, path: String): String {
        val file = download(session, path)
        try {
            return withContext(Dispatchers.IO) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, path.substringAfterLast('/'))
                    put(MediaStore.Downloads.MIME_TYPE, "video/webm")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error(NativeI18n.text("Unable to create download"))
                try {
                    resolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
                    resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                    NativeI18n.text("Saved to Downloads")
                } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
            }
        } finally { file.delete() }
    }
}
