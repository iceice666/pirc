package dev.pirc.android.ui.session

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

/**
 * [bytes] decoded for display in at most [maxWidth]×[maxHeight] pixels: bounds
 * first, then sampled down by powers of two, so a multi-megapixel screenshot
 * never becomes a full-size bitmap. Call off the main thread.
 */
internal fun decodeSampled(bytes: ByteArray, maxWidth: Int, maxHeight: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= maxWidth || bounds.outHeight / (sample * 2) >= maxHeight) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}

/**
 * An image decoded in the background for a box of [maxWidth]×[maxHeight];
 * null while decoding or if [bytes] is not an image. [bytes] runs off the main
 * thread too (base64 decoding).
 */
@Composable
internal fun rememberDecodedImage(key: Any, maxWidth: Dp, maxHeight: Dp, bytes: () -> ByteArray): ImageBitmap? {
    val density = LocalDensity.current
    val width = with(density) { maxWidth.roundToPx() }
    val height = with(density) { maxHeight.roundToPx() }
    val image by produceState<ImageBitmap?>(null, key, width, height) {
        value = withContext(Dispatchers.Default) {
            runCatching { decodeSampled(bytes(), width, height)?.asImageBitmap() }.getOrNull()
        }
    }
    return image
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
