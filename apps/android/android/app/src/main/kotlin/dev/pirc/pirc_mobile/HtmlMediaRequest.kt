package dev.pirc.pirc_mobile

/** A validated, channel-independent request for an HTML audio/video resource. */
internal data class HtmlMediaOpenRequest(
    val source: String?,
    val bytes: ByteArray?,
    val mimeType: String?,
    val baseUrl: String?,
    val pairingStamp: String,
    val kind: String,
    val muted: Boolean,
    val loop: Boolean,
    val documentUrl: String? = null,
)

internal const val MAX_HTML_MEDIA_BYTES = 32 * 1024 * 1024

/** Validates untrusted Flutter arguments before any network, file, or player work begins. */
internal fun validateHtmlMediaOpenRequest(
    source: String?,
    bytes: ByteArray?,
    mimeType: String?,
    baseUrl: String?,
    pairingStamp: String?,
    kind: String?,
    muted: Boolean?,
    loop: Boolean?,
    documentUrl: String? = null,
): HtmlMediaOpenRequest {
    require((source != null) xor (bytes != null)) {
        "Provide exactly one of source or bytes"
    }
    require(kind == "audio" || kind == "video") { "kind must be audio or video" }
    val stamp = pairingStamp?.takeIf { it.isNotBlank() && it.length <= 256 }
        ?: throw IllegalArgumentException("pairingStamp is required")

    val validatedSource = source?.also {
        require(it.isNotBlank() && it.length <= 16_384 && it.none { character -> character.code < 0x20 || character.code == 0x7f }) {
            "Invalid media source"
        }
        val scheme = Regex("^([A-Za-z][A-Za-z0-9+.-]*):").find(it)?.groupValues?.get(1)
        require(scheme == null || scheme.equals("http", true) || scheme.equals("https", true)) {
            "Media source must use HTTP or HTTPS"
        }
    }
    val validatedBytes = bytes?.also {
        require(it.size <= MAX_HTML_MEDIA_BYTES) { "Media exceeds the 32 MiB limit" }
        require(mimeType != null && mimeType.matches(MIME_TYPE_PATTERN)) {
            "A valid MIME type is required for byte media"
        }
        val essence = mimeType.substringBefore(';').trim()
        require('*' !in essence.substringBefore('/') && '*' !in essence.substringAfter('/')) {
            "A concrete MIME type is required for byte media"
        }
    }?.copyOf()
    require(baseUrl == null || (baseUrl.length <= 16_384 && baseUrl.none { character -> character.code < 0x20 || character.code == 0x7f })) {
        "Invalid media baseUrl"
    }

    require(documentUrl == null || (documentUrl.length <= 16_384 && documentUrl.none { it.code < 0x20 || it.code == 0x7f })) {
        "Invalid media documentUrl"
    }

    return HtmlMediaOpenRequest(
        source = validatedSource,
        bytes = validatedBytes,
        mimeType = mimeType,
        baseUrl = baseUrl,
        pairingStamp = stamp,
        kind = kind,
        muted = muted ?: false,
        loop = loop ?: false,
        documentUrl = documentUrl,
    )
}

private val MIME_TYPE_PATTERN = Regex(
    """^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$""",
)
