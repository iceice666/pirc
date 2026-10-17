package dev.pirc.pirc_mobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class HtmlMediaRequestTest {
    @Test fun acceptsHttpSourceAndPreservesElementOptions() {
        val request = validateHtmlMediaOpenRequest(
            source = "https://media.example.test/clip.webm",
            bytes = null,
            mimeType = null,
            baseUrl = "https://media.example.test/page/",
            pairingStamp = "stamp-1",
            kind = "video",
            muted = true,
            loop = true,
        )

        assertEquals("video", request.kind)
        assertEquals("https://media.example.test/clip.webm", request.source)
        assertEquals("https://media.example.test/page/", request.baseUrl)
        assertTrue(request.muted)
        assertTrue(request.loop)
    }

    @Test fun acceptsByteMediaAndCopiesItBeforeAsyncUse() {
        val bytes = byteArrayOf(0, 1, -1)
        val request = validateHtmlMediaOpenRequest(
            source = null,
            bytes = bytes,
            mimeType = "audio/ogg; codecs=opus",
            baseUrl = null,
            pairingStamp = "stamp-2",
            kind = "audio",
            muted = null,
            loop = null,
        )
        bytes[0] = 8

        assertArrayEquals(byteArrayOf(0, 1, -1), request.bytes)
        assertEquals("audio/ogg; codecs=opus", request.mimeType)
        assertFalse(request.muted)
        assertFalse(request.loop)
    }

    @Test fun rejectsInvalidKindsSourceSchemesAndSourceByteCombinations() {
        assertRejected(kind = "image")
        assertRejected(source = "file:///sdcard/clip.mp4")
        assertRejected(source = "https://media.example.test/clip.mp4", bytes = byteArrayOf(1))
        assertRejected(source = null, bytes = null)
        assertRejected(source = "javascript:alert(1)")
    }

    @Test fun rejectsMissingOrMalformedByteMimeTypesAndOversizePayloads() {
        assertRejected(source = null, bytes = byteArrayOf(1), mimeType = null)
        assertRejected(source = null, bytes = byteArrayOf(1), mimeType = "audio/*")
        assertRejected(source = null, bytes = byteArrayOf(1), mimeType = "audio/ogg\r\nX-Test: yes")
        assertRejected(
            source = null,
            bytes = ByteArray(MAX_HTML_MEDIA_BYTES + 1),
            mimeType = "video/mp4",
        )
    }

    private fun assertRejected(
        source: String? = "https://media.example.test/clip.webm",
        bytes: ByteArray? = null,
        mimeType: String? = null,
        kind: String? = "audio",
    ) {
        try {
            validateHtmlMediaOpenRequest(
                source = source,
                bytes = bytes,
                mimeType = mimeType,
                baseUrl = null,
                pairingStamp = "stamp",
                kind = kind,
                muted = null,
                loop = null,
            )
            fail("Invalid media request should be rejected")
        } catch (_: IllegalArgumentException) { }
    }
}
