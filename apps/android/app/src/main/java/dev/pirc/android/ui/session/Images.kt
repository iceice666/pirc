package dev.pirc.android.ui.session

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import kotlin.math.max

/** What the gateway accepts as an upload, and what it takes at most (well under its 10 MiB default). */
private val ACCEPTED = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
private const val MAX_BYTES = 8 * 1024 * 1024
private const val MAX_SIDE = 2560

data class PickedImage(val name: String, val mimeType: String, val bytes: ByteArray)

/**
 * Read a picked image. Formats the gateway refuses (HEIC from the camera) and
 * oversized files are re-encoded as JPEG, at most [MAX_SIDE] pixels on a side.
 * Call off the main thread.
 */
fun readImage(context: Context, uri: Uri): PickedImage? {
    val resolver = context.contentResolver
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: uri.lastPathSegment ?: "image"
    val mime = resolver.getType(uri) ?: "application/octet-stream"
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    if (mime in ACCEPTED && bytes.size <= MAX_BYTES) return PickedImage(name, mime, bytes)

    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(bytes)) { decoder, info, _ ->
        val side = max(info.size.width, info.size.height)
        if (side > MAX_SIDE) {
            val scale = MAX_SIDE.toFloat() / side
            decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    var quality = 88
    while (true) {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (out.size() <= MAX_BYTES || quality <= 40)
            return PickedImage(name.substringBeforeLast('.') + ".jpg", "image/jpeg", out.toByteArray())
        quality -= 16
    }
}
