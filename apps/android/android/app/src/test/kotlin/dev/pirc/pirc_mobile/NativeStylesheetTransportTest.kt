package dev.pirc.pirc_mobile

import java.security.MessageDigest
import java.util.Base64
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl
import org.junit.Assert.*
import org.junit.Test

class NativeStylesheetTransportTest {
    @Test fun missingCrossoriginIncludesCookiesButKeepsSheetOriginTainted() {
        MockWebServer().use { server ->
            server.start()
            val target = server.url("/style.css")
            val cookies = NativeDocumentCookies()
            cookies.receive(
                target,
                listOf("sid=include; Path=/; SameSite=None; Secure"),
                CookieRequestContext(initiatorUrl = target, topLevelUrl = target),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "text/css; charset=UTF-8")
                    .addHeader("Set-Cookie", "saved=1; Path=/; SameSite=None; Secure")
                    .addHeader("Referrer-Policy", "no-referrer, unsafe-url")
                    .addHeader("X-Private", "host only")
                    .body("body { color: red }\n")
                    .build(),
            )

            val documentUrl = "https://document.example/page.html"
            val sheetParent = "https://user:secret@cdn.example/css/main.css#private"
            val result = NativeScriptResourceTransport(null, cookies = cookies).load(
                sourceOrigin = "https://document.example",
                request = NativeScriptResourceTransport.ResourceRequest(
                    url = target.toString(),
                    kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                    referrerPolicy = "unsafe-url",
                    stylesheetReferrerUrl = sheetParent,
                ),
                referrerUrl = documentUrl,
                initiatorUrl = documentUrl,
                topLevelUrl = documentUrl,
            )

            val sent = server.takeRequest()
            assertEquals("GET", sent.method)
            assertEquals("text/css,*/*;q=0.1", sent.headers["Accept"])
            assertEquals("sid=include", sent.headers["Cookie"])
            assertNull("No-CORS stylesheet GET must not send Origin", sent.headers["Origin"])
            assertEquals("https://cdn.example/css/main.css", sent.headers["Referer"])
            assertEquals("stylesheet", result.type)
            assertEquals(target.toString(), result.url)
            assertFalse(result.originClean)
            assertEquals("unsafe-url", result.stylesheetReferrerPolicy)
            assertTrue(result.nativeSetCookieProcessed)
            assertEquals(opaqueCookieRequestKey("sid=include"), result.nativeCookieRequestKey)
            assertNull(result.headers.entries.firstOrNull { it.key.equals("Set-Cookie", true) })
            assertEquals("body { color: red }\n", result.body?.decodeToString())
        }
    }

    @Test fun crossoriginAnonymousOmitsCrossOriginCookiesAndUseCredentialsIncludesThemWithoutPreflight() {
        MockWebServer().use { server ->
            server.start()
            val target = server.url("/style.css")
            val cookies = NativeDocumentCookies()
            cookies.receive(
                target,
                listOf("sid=credential; Path=/; SameSite=None; Secure"),
                CookieRequestContext(initiatorUrl = target, topLevelUrl = target),
            )
            val source = "https://document.example"
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/css")
                    .body(".anonymous { color: blue }")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Access-Control-Allow-Credentials", "true")
                    .addHeader("Content-Type", "text/css")
                    .body(".credentialed { color: green }")
                    .build(),
            )

            val transport = NativeScriptResourceTransport(null, cookies = cookies)
            val anonymous = transport.load(
                source,
                NativeScriptResourceTransport.ResourceRequest(
                    url = target.toString(),
                    kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                    crossOrigin = "anonymous",
                ),
                initiatorUrl = "$source/page.html",
                topLevelUrl = "$source/page.html",
            )
            val credentialed = transport.load(
                source,
                NativeScriptResourceTransport.ResourceRequest(
                    url = target.toString(),
                    kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                    crossOrigin = "use-credentials",
                ),
                initiatorUrl = "$source/page.html",
                topLevelUrl = "$source/page.html",
            )

            val anonymousRequest = server.takeRequest()
            val credentialedRequest = server.takeRequest()
            assertNull(anonymousRequest.headers["Cookie"])
            assertEquals(source, anonymousRequest.headers["Origin"])
            assertEquals("sid=credential", credentialedRequest.headers["Cookie"])
            assertEquals(source, credentialedRequest.headers["Origin"])
            assertEquals("GET", anonymousRequest.method)
            assertEquals("GET", credentialedRequest.method)
            assertEquals("stylesheet", anonymous.type)
            assertTrue(anonymous.originClean)
            assertTrue(credentialed.originClean)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun credentialedStylesheetStoresCookieBeforeCorsFailure() {
        MockWebServer().use { server ->
            server.start()
            val source = "https://document.example"
            val target = server.url("/style.css")
            val cookies = NativeDocumentCookies()
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", "*")
                    .addHeader("Set-Cookie", "cors=stored; Path=/; SameSite=None; Secure")
                    .addHeader("Content-Type", "text/css")
                    .body("unreadable")
                    .build(),
            )
            server.enqueue(MockResponse.Builder().addHeader("Content-Type", "text/css").body("ok").build())
            val transport = NativeScriptResourceTransport(null, cookies = cookies)

            try {
                transport.load(
                    source,
                    NativeScriptResourceTransport.ResourceRequest(
                        url = target.toString(),
                        kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                        crossOrigin = "use-credentials",
                    ),
                    initiatorUrl = "$source/page.html",
                    topLevelUrl = "$source/page.html",
                )
                fail("Credentialed CORS must reject wildcard origins")
            } catch (error: IllegalStateException) {
                assertTrue(error.message.orEmpty().contains("CORS response"))
            }

            val verifyUrl = server.url("/verify.css")
            transport.load(
                origin(target),
                NativeScriptResourceTransport.ResourceRequest(
                    url = verifyUrl.toString(),
                    kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                ),
                initiatorUrl = target.toString(),
                topLevelUrl = target.toString(),
            )
            assertNull(server.takeRequest().headers["Cookie"])
            assertEquals("cors=stored", server.takeRequest().headers["Cookie"])
        }
    }

    @Test fun stylesheetFollowsRedirectAndAppliesRedirectSetCookieOnNextHop() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse.Builder()
                    .code(302)
                    .addHeader("Location", "/css/final.css")
                    .addHeader("Set-Cookie", "from-redirect=1; Path=/; SameSite=Lax")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "text/css")
                    .addHeader("Referrer-Policy", "origin")
                    .body(".loaded { color: black }")
                    .build(),
            )
            val document = server.url("/page.html")
            val start = server.url("/css/start.css")
            val result = NativeScriptResourceTransport(null, cookies = NativeDocumentCookies()).load(
                sourceOrigin = origin(document),
                request = NativeScriptResourceTransport.ResourceRequest(
                    url = start.toString(),
                    kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                    stylesheetReferrerUrl = document.toString(),
                ),
                initiatorUrl = document.toString(),
                topLevelUrl = document.toString(),
            )

            val redirect = server.takeRequest()
            val final = server.takeRequest()
            assertNull(redirect.headers["Cookie"])
            assertEquals("from-redirect=1", final.headers["Cookie"])
            assertEquals("/css/final.css", result.url.substringAfter("${origin(document)}"))
            assertTrue(result.redirected)
            assertTrue(result.nativeSetCookieProcessed)
            assertEquals("origin", result.stylesheetReferrerPolicy)
            assertEquals("stylesheet", result.type)
        }
    }

    @Test fun stylesheetEnforcesMimeStatusIntegrityAndAllowsBodiesAboveGenericFetchLimit() {
        MockWebServer().use { server ->
            server.start()
            val valid = ".valid { display: block }".toByteArray()
            val largerThanFetchLimit = "a".repeat(3 * 1024 * 1024)
            val source = "https://document.example"
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/html")
                    .body("not css")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .code(404)
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/css")
                    .body("missing")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/css")
                    .body(String(valid))
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/css")
                    .body(largerThanFetchLimit)
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Access-Control-Allow-Origin", source)
                    .addHeader("Content-Type", "text/css")
                    .body(String(valid))
                    .build(),
            )
            val transport = NativeScriptResourceTransport(null, responseLimit = 2 * 1024 * 1024)
            fun request(integrity: String? = null) = NativeScriptResourceTransport.ResourceRequest(
                url = server.url("/style.css").toString(),
                kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                integrity = integrity,
                crossOrigin = "anonymous",
            )
            fun rejected(request: NativeScriptResourceTransport.ResourceRequest, detail: String) {
                try {
                    transport.load(source, request)
                    fail(detail)
                } catch (error: IllegalArgumentException) {
                    assertTrue(error.message.orEmpty().contains("Stylesheet"))
                }
            }

            rejected(request(), "Non-CSS MIME must fail")
            rejected(request(), "Unsuccessful HTTP status must fail")
            rejected(request(sri("sha256", "different".toByteArray())), "Bad integrity must fail")
            val large = transport.load(source, request(), referrerUrl = "$source/page.html")
            assertEquals(largerThanFetchLimit.length, large.body?.size)
            val integrityChecked = transport.load(
                source,
                request(sri("sha256", valid)),
                referrerUrl = "$source/page.html",
            )
            assertArrayEquals(valid, integrityChecked.body)
            assertEquals(5, server.requestCount)
        }
    }

    @Test fun crossOriginNoCorsStylesheetIntegrityAndForbiddenRequestShapesFailBeforeNetwork() {
        MockWebServer().use { server ->
            server.start()
            val transport = NativeScriptResourceTransport(null)
            val source = "https://document.example"
            val url = server.url("/style.css").toString()
            val integrity = sri("sha256", "body".toByteArray())
            val noCorsWithIntegrity = NativeScriptResourceTransport.ResourceRequest(
                url = url,
                kind = NativeScriptResourceTransport.Kind.STYLESHEET,
                integrity = integrity,
            )
            assertThrows(IllegalArgumentException::class.java) { transport.load(source, noCorsWithIntegrity) }

            val customHeader = noCorsWithIntegrity.copy(
                integrity = null,
                headers = listOf(NativeScriptResourceTransport.Header("X-Trace", "1")),
            )
            assertThrows(IllegalArgumentException::class.java) { transport.load(source, customHeader) }
            val post = noCorsWithIntegrity.copy(integrity = null, method = "POST")
            assertThrows(IllegalArgumentException::class.java) { transport.load(source, post) }
            assertEquals(0, server.requestCount)
        }
    }

    private fun origin(url: HttpUrl): String = "${url.scheme}://${url.host}:${url.port}"

    private fun sri(algorithm: String, bytes: ByteArray): String {
        val jca = when (algorithm) {
            "sha256" -> "SHA-256"
            "sha384" -> "SHA-384"
            else -> "SHA-512"
        }
        val digest = MessageDigest.getInstance(jca).digest(bytes)
        return "$algorithm-${Base64.getEncoder().encodeToString(digest)}"
    }
}
