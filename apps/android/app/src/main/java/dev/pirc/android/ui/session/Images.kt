package dev.pirc.android.ui.session

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.math.max

/** What the gateway accepts as an upload, and what it takes at most (well under its 10 MiB default). */
private val ACCEPTED = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
private const val MAX_BYTES = 8 * 1024 * 1024
private const val MAX_SIDE = 2560

data class PickedImage(val name: String, val mimeType: String, val bytes: ByteArray)

/**
 * Read a picked image. Formats the gateway refuses (HEIC from the camera) and
 * oversized files are re-encoded as JPEG, at most [MAX_SIDE] pixels on a side,
 * decoding straight from the file so a huge original is never held in memory.
 * Call off the main thread.
 */
fun readImage(context: Context, uri: Uri): PickedImage? {
    val resolver = context.contentResolver
    var name: String? = null
    var size: Long? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            name = cursor.getString(0)
            size = if (cursor.isNull(1)) null else cursor.getLong(1)
        }
    }
    val fileName = name ?: uri.lastPathSegment ?: "image"
    val mime = resolver.getType(uri) ?: "application/octet-stream"
    if (mime in ACCEPTED && (size ?: 0) <= MAX_BYTES) {
        // The provider may not know the size: read at most one byte past the limit.
        val bytes = resolver.openInputStream(uri)?.use { it.readAtMost(MAX_BYTES + 1) } ?: return null
        if (bytes.size <= MAX_BYTES) return PickedImage(fileName, mime, bytes)
    }

    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        val side = max(info.size.width, info.size.height)
        if (side > MAX_SIDE) {
            val scale = MAX_SIDE.toFloat() / side
            decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    try {
        var quality = 88
        while (true) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= MAX_BYTES || quality <= 40)
                return PickedImage(fileName.substringBeforeLast('.') + ".jpg", "image/jpeg", out.toByteArray())
            quality -= 16
        }
    } finally {
        bitmap.recycle()
    }
}

/** Up to [limit] bytes of the stream; more than that is left unread. */
internal fun InputStream.readAtMost(limit: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    while (out.size() < limit) {
        val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
        if (read < 0) break
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}
