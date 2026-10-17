package dev.pirc.pirc_mobile

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okio.BufferedSink
import org.junit.Assert.*
import org.junit.Test

class NativeResourceCancellationTest {
    @Test fun preCanceledTokenDoesNotSendARequest() {
        MockWebServer().use { server ->
            server.start()
            val cancellation = NativeResourceCancellation()
            cancellation.cancel()

            assertThrows(IOException::class.java) {
                transport().load(
                    sourceOrigin = "https://document.example",
                    request = request(server, "/pre-canceled"),
                    cancellation = cancellation,
                )
            }
            assertEquals(0, server.requestCount)
        }
    }

    @Test fun cancelWhileWaitingForHeadersUnblocksTheOkHttpCall() {
        MockWebServer().use { server ->
            val requestReceived = CountDownLatch(1)
            val releaseResponse = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requestReceived.countDown()
                    releaseResponse.await(5, TimeUnit.SECONDS)
                    return corsResponse("headers")
                }
            }
            server.start()

            val cancellation = NativeResourceCancellation()
            val executor = Executors.newSingleThreadExecutor()
            try {
                val result = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    transport().load(
                        sourceOrigin = "https://document.example",
                        request = request(server, "/slow-headers"),
                        cancellation = cancellation,
                    )
                }
                assertTrue(requestReceived.await(5, TimeUnit.SECONDS))
                cancellation.cancel()
                assertCanceled(result)
                assertEquals(1, server.requestCount)
            } finally {
                releaseResponse.countDown()
                executor.shutdownNow()
            }
        }
    }

    @Test fun cancelWhileReadingTheBodyUnblocksTheResponseRead() {
        MockWebServer().use { server ->
            val bodyStarted = CountDownLatch(1)
            val releaseBody = CountDownLatch(1)
            server.enqueue(
                corsResponse(
                    object : MockResponseBody {
                        override val contentLength: Long = -1L

                        override fun writeTo(sink: BufferedSink) {
                            sink.writeUtf8("prefix")
                            sink.flush()
                            bodyStarted.countDown()
                            releaseBody.await(5, TimeUnit.SECONDS)
                            sink.writeUtf8("suffix")
                        }
                    },
                ),
            )
            server.start()

            val cancellation = NativeResourceCancellation()
            val executor = Executors.newSingleThreadExecutor()
            try {
                val result = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    transport().load(
                        sourceOrigin = "https://document.example",
                        request = request(server, "/slow-body"),
                        cancellation = cancellation,
                    )
                }
                assertTrue(bodyStarted.await(5, TimeUnit.SECONDS))
                cancellation.cancel()
                assertCanceled(result)
                assertEquals(1, server.requestCount)
            } finally {
                releaseBody.countDown()
                executor.shutdownNow()
            }
        }
    }

    @Test fun cancelingOptionsNeverStartsThePost() {
        MockWebServer().use { server ->
            val optionsReceived = CountDownLatch(1)
            val releaseResponse = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    optionsReceived.countDown()
                    releaseResponse.await(5, TimeUnit.SECONDS)
                    return MockResponse.Builder()
                        .code(204)
                        .addHeader("Access-Control-Allow-Origin", "https://document.example")
                        .addHeader("Access-Control-Allow-Methods", "POST")
                        .build()
                }
            }
            server.start()

            val cancellation = NativeResourceCancellation()
            val executor = Executors.newSingleThreadExecutor()
            try {
                val result = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    transport().load(
                        sourceOrigin = "https://document.example",
                        request = NativeScriptResourceTransport.ResourceRequest(
                            url = server.url("/preflight-upload").toString(),
                            method = "POST",
                            body = "payload".toByteArray(),
                            forcePreflight = true,
                        ),
                        cancellation = cancellation,
                    )
                }
                assertTrue(optionsReceived.await(5, TimeUnit.SECONDS))
                cancellation.cancel()
                assertCanceled(result)
                assertEquals("OPTIONS", server.takeRequest(1, TimeUnit.SECONDS)?.method)
                assertEquals(1, server.requestCount)
            } finally {
                releaseResponse.countDown()
                executor.shutdownNow()
            }
        }
    }

    @Test fun cancelAfterRedirectHeadersNeverStartsTheNextHop() {
        MockWebServer().use { server ->
            val cancellation = NativeResourceCancellation()
            val redirectResponseSeen = CountDownLatch(1)
            val client = OkHttpClient.Builder()
                .addInterceptor(Interceptor { chain ->
                    val response = chain.proceed(chain.request())
                    if (chain.request().url.encodedPath == "/redirect") {
                        redirectResponseSeen.countDown()
                        cancellation.cancel()
                    }
                    response
                })
                .build()
            server.enqueue(
                MockResponse.Builder()
                    .code(302)
                    .addHeader("Location", "/next")
                    .build(),
            )
            server.enqueue(corsResponse("next hop"))
            server.start()

            val executor = Executors.newSingleThreadExecutor()
            try {
                val result = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    NativeScriptResourceTransport(null, client).load(
                        sourceOrigin = "https://document.example",
                        request = request(server, "/redirect"),
                        cancellation = cancellation,
                    )
                }
                assertTrue(redirectResponseSeen.await(5, TimeUnit.SECONDS))
                assertCanceled(result)
                assertEquals("/redirect", server.takeRequest(1, TimeUnit.SECONDS)?.target)
                assertEquals(1, server.requestCount)
            } finally {
                executor.shutdownNow()
            }
        }
    }

    @Test fun cancelingOneTokenDoesNotCancelAnotherTokensCalls() {
        MockWebServer().use { server ->
            val firstReceived = CountDownLatch(1)
            val secondReceived = CountDownLatch(1)
            val releaseFirst = CountDownLatch(1)
            val releaseSecond = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    when (request.target.substringBefore("?")) {
                        "/first" -> {
                            firstReceived.countDown()
                            releaseFirst.await(5, TimeUnit.SECONDS)
                            corsResponse("first")
                        }
                        "/second" -> {
                            secondReceived.countDown()
                            releaseSecond.await(5, TimeUnit.SECONDS)
                            corsResponse("second")
                        }
                        else -> error("Unexpected request: " + request.target)
                    }
            }
            server.start()

            val firstCancellation = NativeResourceCancellation()
            val secondCancellation = NativeResourceCancellation()
            val executor = Executors.newFixedThreadPool(2)
            try {
                val first = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    transport().load(
                        "https://document.example",
                        request(server, "/first"),
                        cancellation = firstCancellation,
                    )
                }
                val second = executor.submit<NativeScriptResourceTransport.ResourceResponse> {
                    transport().load(
                        "https://document.example",
                        request(server, "/second"),
                        cancellation = secondCancellation,
                    )
                }
                assertTrue(firstReceived.await(5, TimeUnit.SECONDS))
                assertTrue(secondReceived.await(5, TimeUnit.SECONDS))

                firstCancellation.cancel()
                assertCanceled(first)
                releaseSecond.countDown()
                assertArrayEquals(
                    "second".toByteArray(),
                    second.get(2, TimeUnit.SECONDS).body,
                )
                assertEquals(2, server.requestCount)
            } finally {
                releaseFirst.countDown()
                releaseSecond.countDown()
                executor.shutdownNow()
            }
        }
    }

    private fun transport() = NativeScriptResourceTransport(null)

    private fun request(
        server: MockWebServer,
        path: String,
    ) = NativeScriptResourceTransport.ResourceRequest(url = server.url(path).toString())

    private fun corsResponse(body: String) =
        MockResponse.Builder()
            .addHeader("Access-Control-Allow-Origin", "https://document.example")
            .body(body)
            .build()

    private fun corsResponse(body: MockResponseBody) =
        MockResponse.Builder()
            .addHeader("Access-Control-Allow-Origin", "https://document.example")
            .body(body)
            .build()

    private fun assertCanceled(future: Future<*>) {
        try {
            future.get(2, TimeUnit.SECONDS)
            fail("Canceled resource loading must fail")
        } catch (error: ExecutionException) {
            assertTrue("Expected IOException, got " + error.cause, error.cause is IOException)
        }
    }
}
