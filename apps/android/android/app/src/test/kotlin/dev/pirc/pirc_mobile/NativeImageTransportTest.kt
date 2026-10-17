package dev.pirc.pirc_mobile

import dev.pirc.android.core.Pairing
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

class NativeImageTransportTest {
    @Test fun imageCookiesFollowRedirectsAndDisableTheInjectedOkHttpJar() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse.Builder()
                    .code(302)
                    .addHeader("Location", "/final.png")
                    .addHeader("Set-Cookie", "image=ready; Path=/; SameSite=Lax")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "image/png")
                    .body("png")
                    .build(),
            )
            server.start()

            val cookies = NativeDocumentCookies()
            var jarLoads = 0
            val ambientJar = object : CookieJar {
                override fun loadForRequest(url: HttpUrl): List<Cookie> {
                    jarLoads++
                    return listOf(checkNotNull(Cookie.parse(url, "ambient=must-not-leak; Path=/")))
                }

                override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = Unit
            }
            val transport = NativeImageTransport(
                Pairing(server.url("/").toString().trimEnd('/'), "test-token"),
                OkHttpClient.Builder().cookieJar(ambientJar).build(),
                cookies = cookies,
            )
            val pageUrl = server.url("/page").toString()
            val result = transport.load(
                server.url("/start.png").toString(),
                initiatorUrl = pageUrl,
                topLevelUrl = pageUrl,
            )

            val redirect = server.takeRequest()
            val final = server.takeRequest()
            assertNull(redirect.headers["Cookie"])
            assertEquals("image=ready", final.headers["Cookie"])
            assertEquals(opaqueCookieRequestKey("image=ready"), result["nativeCookieRequestKey"])
            assertEquals(true, result["nativeSetCookieProcessed"])
            assertFalse(result.keys.any { it.equals("Set-Cookie", ignoreCase = true) })
            assertEquals(0, jarLoads)
        }
    }

    @Test fun relativeImageUsesGatewayOriginAndCredential() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse.Builder().addHeader("Content-Type", "image/svg+xml; charset=utf-8").body("svg").build()); s.start()
            val result = NativeImageTransport(Pairing(s.url("/").toString().trimEnd('/'), "test-token")).load("images/chart.svg")
            val request = s.takeRequest()
            assertEquals("/images/chart.svg", request.target)
            assertEquals("Bearer test-token", request.headers["Authorization"])
            assertEquals("image/svg+xml", result["mimeType"])
            assertArrayEquals("svg".toByteArray(), result["bytes"] as ByteArray)
        }
    }
    @Test fun crossOriginRedirectAndDirectExternalRequestHaveNoCredential() {
        MockWebServer().use { origin -> MockWebServer().use { external ->
            origin.start(); external.start()
            origin.enqueue(MockResponse.Builder().code(302).addHeader("Location", external.url("/redirected")).build())
            repeat(2) { external.enqueue(MockResponse.Builder().body("image").build()) }
            val transport = NativeImageTransport(Pairing(origin.url("/").toString().trimEnd('/'), "test-token"))
            transport.load("/first")
            assertEquals("Bearer test-token", origin.takeRequest().headers["Authorization"])
            assertNull(external.takeRequest().headers["Authorization"])
            transport.load(external.url("/direct").toString())
            assertNull(external.takeRequest().headers["Authorization"])
        } }
    }
    @Test fun sameOriginRedirectKeepsCredential() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse.Builder().code(307).addHeader("Location", "../final").build())
            s.enqueue(MockResponse.Builder().body("image").build()); s.start()
            NativeImageTransport(Pairing(s.url("/").toString().trimEnd('/'), "test-token")).load("/dir/start")
            s.takeRequest()
            val final = s.takeRequest()
            assertEquals("/final", final.target)
            assertEquals("Bearer test-token", final.headers["Authorization"])
        }
    }
    @Test fun imageUrlsResolveAgainstDocumentBaseAndCredentialsFollowResolvedOrigin() {
        MockWebServer().use { origin -> MockWebServer().use { external ->
            origin.start(); external.start()
            repeat(3) { origin.enqueue(MockResponse.Builder().body("origin image").build()) }
            external.enqueue(MockResponse.Builder().body("external image").build())

            val originUrl = origin.url("/")
            val externalBase = external.url("/docs/page/index.html").toString()
            val transport = NativeImageTransport(
                Pairing(originUrl.toString().trimEnd('/'), "test-token"),
            )
            transport.load("../images/chart.svg", origin.url("/app/page/index.html").toString())
            transport.load("images/external.svg", externalBase)
            transport.load(origin.url("/absolute.svg").toString(), externalBase)
            transport.load("//${originUrl.host}:${originUrl.port}/protocol-relative.svg", externalBase)

            val sameOriginRelative = origin.takeRequest()
            val externalRelative = external.takeRequest()
            val absolutePairingOrigin = origin.takeRequest()
            val protocolRelativePairingOrigin = origin.takeRequest()
            assertEquals("/app/images/chart.svg", sameOriginRelative.target)
            assertEquals("Bearer test-token", sameOriginRelative.headers["Authorization"])
            assertEquals("/docs/page/images/external.svg", externalRelative.target)
            assertNull(externalRelative.headers["Authorization"])
            assertEquals("/absolute.svg", absolutePairingOrigin.target)
            assertEquals("Bearer test-token", absolutePairingOrigin.headers["Authorization"])
            assertEquals("/protocol-relative.svg", protocolRelativePairingOrigin.target)
            assertEquals("Bearer test-token", protocolRelativePairingOrigin.headers["Authorization"])
            assertEquals(3, origin.requestCount)
            assertEquals(1, external.requestCount)
        } }
    }
    @Test fun blobBaseAllowsAbsoluteHttpImagesAndRejectsRelativeResolution() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("image").build())
            val transport = NativeImageTransport(
                Pairing(server.url("/").toString().trimEnd('/'), "test-token"),
            )
            val blobBase = "blob:${server.url("/object/nonce/id")}"

            transport.load(server.url("/absolute.png").toString(), blobBase)
            val request = server.takeRequest()
            assertEquals("/absolute.png", request.target)
            assertEquals("Bearer test-token", request.headers["Authorization"])

            assertThrows(IllegalStateException::class.java) {
                transport.load("images/relative.png", blobBase)
            }
            assertThrows(IllegalStateException::class.java) {
                transport.load(server.url("/absolute.png").toString(), "not-a-base")
            }
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun failureRedirectLoopsAndUnknownLengthAreBounded() {
        MockWebServer().use { s ->
            s.start(); val transport = NativeImageTransport(null, limit = 4)
            s.enqueue(MockResponse.Builder().code(404).body("missing").build())
            assertThrows(IllegalStateException::class.java) { transport.load(s.url("/missing").toString()) }
            s.enqueue(MockResponse.Builder().chunkedBody("12345", 1).build())
            assertThrows(IllegalStateException::class.java) { transport.load(s.url("/large").toString()) }
            repeat(11) { s.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/loop").build()) }
            assertThrows(IllegalStateException::class.java) { transport.load(s.url("/loop").toString()) }
            assertEquals(13, s.requestCount)
        }
    }
}
