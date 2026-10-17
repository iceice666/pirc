package dev.pirc.pirc_mobile

import dev.pirc.android.core.ApiException
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

class ProjectFileUploadTest {
    @Test fun streamsRawJsonAndBinaryWithoutUsingProviderLength() {
        val bytes = "{\"message\":\"你好\"}\n".toByteArray() + byteArrayOf(0, -1, 1)
        var closed = false
        val body = ProjectFileUploadBody(1024) {
            object : ByteArrayInputStream(bytes) {
                override fun close() { closed = true; super.close() }
            }
        }
        assertEquals("application/octet-stream", body.contentType().toString())
        assertEquals(-1L, body.contentLength())
        assertTrue(body.isOneShot())
        val sink = Buffer()
        body.writeTo(sink)
        assertArrayEquals(bytes, sink.readByteArray())
        assertTrue(closed)
    }

    @Test fun closesStreamsWhenEmptyOrOverLimitAndNeverWritesPastTheCap() {
        for (size in listOf(0, 33)) {
            var closed = false
            val body = ProjectFileUploadBody(32) {
                object : ByteArrayInputStream(ByteArray(size)) {
                    override fun close() { closed = true; super.close() }
                }
            }
            val sink = Buffer()
            try { body.writeTo(sink); fail("invalid file must not finish uploading") }
            catch (expected: IOException) { assertTrue(expected.message!!.isNotBlank()) }
            assertTrue(closed)
            assertTrue(sink.size <= 32)
        }
    }

    @Test fun supportsTheServerLimitAboveTheLegacyEightMiBPickerCap() {
        val bytes = ByteArray(9 * 1024 * 1024) { 65 }
        val sink = Buffer()
        ProjectFileUploadBody(10L * 1024 * 1024) { bytes.inputStream() }.writeTo(sink)
        assertEquals(bytes.size.toLong(), sink.size)
        assertEquals(65.toByte(), sink.readByte())
    }

    @Test fun rejectsAnUnavailableStreamAndInvalidProtocolLimits() {
        try { ProjectFileUploadBody(1) { null }.writeTo(Buffer()); fail("missing stream") }
        catch (expected: IOException) { assertTrue(expected.message!!.contains("Unable to read")) }
        for (limit in listOf(0L, MAX_PROJECT_FILE_BYTES + 1)) {
            try { ProjectFileUploadBody(limit) { null }; fail("invalid limit") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun providerReadFailuresRemainDistinctFromNetworkFailures() {
        try {
            ProjectFileUploadBody(32) { throw SecurityException("permission expired") }.writeTo(Buffer())
            fail("opening a provider without permission must fail")
        } catch (expected: ProjectFileReadException) {
            assertTrue(expected.message!!.contains("Choose it again"))
            assertTrue(expected.cause is SecurityException)
        }
        var closed = false
        val body = ProjectFileUploadBody(32) {
            object : InputStream() {
                override fun read(): Int = throw IOException("provider unavailable")
                override fun close() { closed = true }
            }
        }
        try { body.writeTo(Buffer()); fail("failed provider read must fail uploading") }
        catch (expected: ProjectFileReadException) { assertTrue(expected.cause is IOException) }
        assertTrue(closed)
    }

    private fun file(workspace: String = "chat:project", stamp: String = "pair-a", context: String? = "window-a") =
        ProjectFileSelections.Selection("content://documents/file", "設定 notes.json", null, workspace, stamp, context)

    private fun expired(action: () -> Unit) {
        try { action(); fail("selection must be scoped or expired") }
        catch (error: ApiException) { assertEquals(409, error.status) }
    }

    @Test fun selectionsBindToProjectPairingAndWindowAndAreConsumedOnce() {
        val selections = ProjectFileSelections()
        val selected = file()
        val token = selections.add(selected)
        expired { selections.consume(token, "another", "pair-a", "window-a") }
        expired { selections.consume(token, "chat:project", "pair-b", "window-a") }
        expired { selections.consume(token, "chat:project", "pair-a", "window-b") }
        assertEquals(selected, selections.consume(token, "chat:project", "pair-a", "window-a"))
        expired { selections.consume(token, "chat:project", "pair-a", "window-a") }
    }

    @Test fun releaseAndContextCloseDoNotDiscardAnotherWindowsSelection() {
        val selections = ProjectFileSelections()
        val a = selections.add(file())
        val b = selections.add(file(context = "window-b"))
        selections.release(listOf(b), "window-a")
        selections.closeContext("window-a")
        expired { selections.consume(a, "chat:project", "pair-a", "window-a") }
        assertEquals("window-b", selections.consume(b, "chat:project", "pair-a", "window-b").contextId)
        val root = selections.add(file(context = null))
        selections.release(listOf(root, root), null)
        expired { selections.consume(root, "chat:project", "pair-a", null) }
    }

    @Test fun pairingChangesAndDisposeDropAllStaleTokens() {
        val selections = ProjectFileSelections()
        val old = selections.add(file())
        val current = selections.add(file(stamp = "pair-b"))
        selections.bind("pair-b")
        expired { selections.consume(old, "chat:project", "pair-a", "window-a") }
        assertEquals("pair-b", selections.consume(current, "chat:project", "pair-b", "window-a").pairingStamp)
        val remaining = selections.add(file())
        selections.clear()
        expired { selections.consume(remaining, "chat:project", "pair-a", "window-a") }
    }
}
