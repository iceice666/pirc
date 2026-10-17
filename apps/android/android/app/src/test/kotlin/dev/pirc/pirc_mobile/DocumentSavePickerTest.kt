package dev.pirc.pirc_mobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DocumentSavePickerTest {
    @Test
    fun acceptsBasenameConcreteMimeAndEmptyBytes() {
        val payload = validateDocumentSavePayload(
            name = "résumé.html",
            mimeType = "Text/HTML",
            bytes = byteArrayOf(),
        )

        assertEquals("résumé.html", payload.name)
        assertEquals("text/html", payload.mimeType)
        assertArrayEquals(byteArrayOf(), payload.bytes)
    }

    @Test
    fun acceptsTheMaximumSaveSize() {
        val bytes = ByteArray(DocumentSavePicker.MAX_BYTES)

        val payload = validateDocumentSavePayload("large.bin", "application/octet-stream", bytes)

        assertEquals(DocumentSavePicker.MAX_BYTES, payload.bytes.size)
    }

    @Test
    fun rejectsPathNamesDotSegmentsAndControlCharacters() {
        listOf("../report.txt", "folder\\report.txt", ".", "..", "bad\nname.txt", "bad\u0000name.txt")
            .forEach { name ->
                assertThrows(IllegalArgumentException::class.java) {
                    validateDocumentSavePayload(name, "text/plain", byteArrayOf(1))
                }
            }
    }

    @Test
    fun rejectsWildcardMalformedAndParameterizedMimeTypes() {
        listOf("*/*", "text/*", "text", "text/html; charset=utf-8", "text/html/")
            .forEach { mimeType ->
                assertThrows(IllegalArgumentException::class.java) {
                    validateDocumentSavePayload("report.txt", mimeType, byteArrayOf(1))
                }
            }
    }

    @Test
    fun rejectsMissingValuesAndPayloadsOverThirtyTwoMib() {
        assertThrows(IllegalArgumentException::class.java) {
            validateDocumentSavePayload(null, "text/plain", byteArrayOf())
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateDocumentSavePayload("report.txt", null, byteArrayOf())
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateDocumentSavePayload("report.txt", "text/plain", null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateDocumentSavePayload(
                "large.bin",
                "application/octet-stream",
                ByteArray(DocumentSavePicker.MAX_BYTES + 1),
            )
        }
    }
}
