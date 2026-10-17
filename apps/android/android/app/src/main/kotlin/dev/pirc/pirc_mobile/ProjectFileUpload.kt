package dev.pirc.pirc_mobile

import dev.pirc.android.core.ApiException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.io.InputStream
import java.util.UUID

internal const val MAX_PROJECT_FILE_BYTES = 11L * 1024 * 1024

/** A selected file stays native until its turn to upload, avoiding batch-sized byte arrays. */
internal class ProjectFileSelections {
    data class Selection(
        val uri: String,
        val name: String,
        val byteSize: Long?,
        val workspaceId: String,
        val pairingStamp: String,
        val contextId: String?,
    )
    private val selected = mutableMapOf<String, Selection>()

    @Synchronized fun add(selection: Selection): String = UUID.randomUUID().toString().also {
        selected[it] = selection
    }

    @Synchronized fun consume(token: String, workspaceId: String, pairingStamp: String, contextId: String?): Selection {
        val file = selected[token]
            ?: throw ApiException(409, "selected_file_expired", "The selected file is no longer available. Choose it again.")
        if (file.workspaceId != workspaceId || file.pairingStamp != pairingStamp || file.contextId != contextId)
            throw ApiException(409, "selected_file_expired", "The project or account changed. Choose the file again.")
        selected.remove(token)
        return file
    }

    @Synchronized fun release(tokens: List<String>, contextId: String?) {
        for (token in tokens) if (selected[token]?.contextId == contextId) selected.remove(token)
    }
    @Synchronized fun closeContext(contextId: String?) {
        selected.entries.removeAll { it.value.contextId == contextId }
    }
    @Synchronized fun bind(pairingStamp: String?) {
        selected.entries.removeAll { it.value.pairingStamp != pairingStamp }
    }
    @Synchronized fun clear() = selected.clear()
}

internal class ProjectFileReadException(message: String, cause: Throwable? = null) : IOException(message, cause)

/** Unknown length is intentional: provider metadata must not truncate the stored bytes. */
internal class ProjectFileUploadBody(
    private val maxBytes: Long,
    private val open: () -> InputStream?,
) : RequestBody() {
    init { require(maxBytes in 1..MAX_PROJECT_FILE_BYTES) { "Invalid project file size limit" } }
    override fun contentType() = "application/octet-stream".toMediaType()
    override fun contentLength(): Long = -1
    override fun isOneShot() = true
    override fun writeTo(sink: BufferedSink) {
        val input = try { open() } catch (error: Exception) {
            throw ProjectFileReadException("Unable to read the selected file. Choose it again.", error)
        } ?: throw ProjectFileReadException("Unable to read the selected file. Choose it again.")
        input.use {
            val buffer = ByteArray(8192)
            var total = 0L
            while (true) {
                val count = try {
                    val read = it.read(buffer)
                    if (read != 0) read else {
                        val next = it.read()
                        if (next < 0) -1 else { buffer[0] = next.toByte(); 1 }
                    }
                } catch (error: IOException) {
                    throw ProjectFileReadException("Unable to read the selected file. Choose it again.", error)
                }
                if (count < 0) break
                if (total + count > maxBytes) throw ProjectFileReadException("File exceeds the project file size limit.")
                sink.write(buffer, 0, count)
                total += count
            }
            if (total == 0L) throw ProjectFileReadException("The selected file is empty.")
        }
    }
}
