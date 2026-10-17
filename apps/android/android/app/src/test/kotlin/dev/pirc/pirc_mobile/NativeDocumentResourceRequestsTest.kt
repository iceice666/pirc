package dev.pirc.pirc_mobile

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class NativeDocumentResourceRequestsTest {
    @Test fun moduleReferrersRequireSuccessfulUrlsFromTheSameLiveDocument() {
        val a = NativeDocumentResourceRequests()
        val b = NativeDocumentResourceRequests()
        val document = "https://doc.example/page"
        val module = "https://cdn.example/redirected/main.js"
        assertEquals(document, a.requireScriptReferrer(document, document))
        assertThrows(IllegalArgumentException::class.java) { a.requireScriptReferrer(module, document) }
        a.recordScriptUrl(module)
        assertEquals(module, a.requireScriptReferrer(module, document))
        assertThrows(IllegalArgumentException::class.java) { b.requireScriptReferrer(module, document) }
        assertThrows(IllegalArgumentException::class.java) {
            a.requireScriptReferrer("https://cdn.example/redirected/main.js?secret=1", document)
        }
        a.close()
        assertThrows(IllegalStateException::class.java) { a.requireScriptReferrer(module, document) }
        assertThrows(IllegalStateException::class.java) { a.recordScriptUrl(module) }
    }

    @Test fun cancellationIsPerDocumentAndDoesNotCancelAnotherRequest() {
        val a = NativeDocumentResourceRequests()
        val b = NativeDocumentResourceRequests()
        val first = a.begin("fetch-1")
        val other = a.begin("fetch-2")
        val otherDocument = b.begin("fetch-1")
        a.cancel("fetch-1")
        assertThrows(IOException::class.java) { first.throwIfCancelled() }
        other.throwIfCancelled()
        otherDocument.throwIfCancelled()
        a.cancel("fetch-99")
        other.throwIfCancelled()
    }

    @Test fun finishedTokenCannotRemoveReusedIdentityOrCancelItsOldSuccess() {
        val resources = NativeDocumentResourceRequests()
        val first = resources.begin("fetch-1")
        resources.finish("fetch-1", first)
        resources.cancel("fetch-1")
        first.throwIfCancelled()
        val next = resources.begin("fetch-1")
        resources.finish("fetch-1", first)
        resources.cancel("fetch-1")
        assertThrows(IOException::class.java) { next.throwIfCancelled() }
        first.throwIfCancelled()
    }

    @Test fun closeCancelsAllKindsAndPermanentlyRejectsNewResources() {
        val resources = NativeDocumentResourceRequests()
        val tokens = listOf("fetch-1", "script-1", "image-1", "stylesheet-1").map(resources::begin)
        resources.close()
        tokens.forEach { token -> assertThrows(IOException::class.java) { token.throwIfCancelled() } }
        assertThrows(IllegalStateException::class.java) { resources.begin("fetch-2") }
        resources.close()
    }

    @Test fun malformedAndDuplicateIdentifiersCannotReplaceAnActiveToken() {
        val resources = NativeDocumentResourceRequests()
        val token = resources.begin("fetch-1")
        assertThrows(IllegalStateException::class.java) { resources.begin("fetch-1") }
        listOf("fetch-0", "fetch--1", "other-1", "fetch-1 ", "fetch-1\n", "fetch-10000000000000000").forEach { id ->
            assertThrows(IllegalArgumentException::class.java) { resources.begin(id) }
        }
        token.throwIfCancelled()
        resources.cancel("fetch-1")
        assertThrows(IOException::class.java) { token.throwIfCancelled() }
    }

    @Test fun stylesheetRequestsUseTheSamePerDocumentCancellationLease() {
        val resources = NativeDocumentResourceRequests()
        val token = resources.begin("stylesheet-23")
        resources.cancel("stylesheet-23")
        assertThrows(IOException::class.java) { token.throwIfCancelled() }
        assertThrows(IllegalArgumentException::class.java) { resources.begin("stylesheet-0") }
    }

    @Test fun aWorkerRegisteredBeforeCloseCannotContinueAfterRetirement() {
        val executor = Executors.newSingleThreadExecutor()
        val resume = CountDownLatch(1)
        try {
            val resources = NativeDocumentResourceRequests()
            val registered = CountDownLatch(1)
            val worker = executor.submit<Class<*>> {
                val token = resources.begin("fetch-1")
                registered.countDown()
                check(resume.await(2, TimeUnit.SECONDS))
                try {
                    token.throwIfCancelled()
                    String::class.java
                } catch (error: IOException) { error.javaClass }
                finally { resources.finish("fetch-1", token) }
            }
            assertTrue(registered.await(2, TimeUnit.SECONDS))
            resources.close()
            resume.countDown()
            assertEquals(IOException::class.java, worker.get(2, TimeUnit.SECONDS))
            assertThrows(IllegalStateException::class.java) { resources.begin("fetch-2") }
        } finally { resume.countDown(); executor.shutdownNow() }
    }
}
