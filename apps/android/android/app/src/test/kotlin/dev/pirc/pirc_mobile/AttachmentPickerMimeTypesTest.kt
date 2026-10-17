package dev.pirc.pirc_mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class AttachmentPickerMimeTypesTest {
    @Test
    fun noUsableAcceptHintLeavesTheChooserUnfiltered() {
        val result = attachmentPickerMimeTypes(listOf(".unknown", "invalid")) { null }

        assertEquals(AttachmentPickerMimeTypes("*/*", emptyList()), result)
    }

    @Test
    fun oneMimeOrExtensionUsesThePrimaryIntentType() {
        val result = attachmentPickerMimeTypes(listOf(".TXT")) { extension ->
            if (extension == "txt") "text/plain" else null
        }

        assertEquals(AttachmentPickerMimeTypes("text/plain", emptyList()), result)
    }

    @Test
    fun severalHintsBecomeAndroidExtraMimeTypesAndUnknownHintsDoNotRejectFiles() {
        val result = attachmentPickerMimeTypes(
            listOf(".txt", "image/*", "application/pdf", ".unmapped", "image/*"),
        ) { extension ->
            if (extension == "txt") "text/plain" else null
        }

        assertEquals(
            AttachmentPickerMimeTypes(
                primaryType = "*/*",
                extraTypes = listOf("text/plain", "image/*", "application/pdf"),
            ),
            result,
        )
    }
}
