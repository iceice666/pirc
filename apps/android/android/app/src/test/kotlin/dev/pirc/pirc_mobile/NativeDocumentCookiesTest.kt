package dev.pirc.pirc_mobile

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class NativeDocumentCookiesTest {
    @Test fun hostDomainPathAndExpiryRulesUseCanonicalCookieScope() {
        var now = 1_700_000_000_000L
        val store = NativeDocumentCookies(nowMillis = { now })
        val responseUrl = "https://www.example.com/dir/page".toHttpUrl()
        val sameSite = sameSiteContext(responseUrl)
        store.receive(
            responseUrl,
            listOf(
                "host=h",
                "domain=d; Domain=example.com; Path=/",
                "path=p; Domain=example.com; Path=/dir",
                "segment=no; Domain=example.com; Path=/directory",
                "maxage=alive; Domain=example.com; Path=/; Max-Age=2; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
                "expired=gone; Max-Age=0",
            ),
            sameSite,
        )

        val subdomain = "https://api.example.com:8443/dir/child".toHttpUrl()
        val subdomainHeader = store.requestHeader(subdomain, sameSiteContext(subdomain))
        assertEquals("path=p; domain=d; maxage=alive", subdomainHeader)

        val sameHost = "https://www.example.com:9443/dir/child".toHttpUrl()
        assertEquals("host=h; path=p; domain=d; maxage=alive", store.requestHeader(sameHost, sameSiteContext(sameHost)))
        assertEquals(
            "domain=d; maxage=alive",
            store.requestHeader("https://www.example.com/dir2".toHttpUrl(), sameSiteContext(responseUrl)),
        )

        now += 2_001L
        assertEquals("path=p; domain=d", store.requestHeader(subdomain, sameSiteContext(subdomain)))
    }

    @Test fun publicSuffixDomainsAreRejectedAndRegistrableDomainCookiesMatchSubdomains() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val responseUrl = "https://docs.example.co.uk/path/page".toHttpUrl()
        store.receive(
            responseUrl,
            listOf(
                "bad=x; Domain=co.uk; Path=/",
                "good=y; Domain=example.co.uk; Path=/",
            ),
            sameSiteContext(responseUrl),
        )
        assertNull(store.requestHeader("https://evil.co.uk/path".toHttpUrl(), sameSiteContext(responseUrl)))
        assertEquals(
            "good=y",
            store.requestHeader("https://api.example.co.uk/path".toHttpUrl(), sameSiteContext(responseUrl)),
        )
        val allowed = store.exportScriptState(responseUrl)["allowedDomainSuffixes"] as List<*>
        assertTrue("example.co.uk" in allowed)
        assertFalse("co.uk" in allowed)
    }

    @Test fun hostOnlyAndDomainCookiesWithTheSameNameRemainDistinct() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val page = "https://www.example.test/path".toHttpUrl()
        val context = sameSiteContext(page)
        store.receive(
            page,
            listOf(
                "id=host; Path=/",
                "id=domain; Domain=www.example.test; Path=/",
            ),
            context,
        )

        assertEquals("id=host; id=domain", store.requestHeader(page, context))
        store.receive(page, listOf("id=; Max-Age=0; Path=/"), context)
        assertEquals("id=domain", store.requestHeader(page, context))
    }

    @Test fun sameSiteIsSchemefulPortIndependentAndRedirectTainted() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val site = "https://api.example.co.uk/".toHttpUrl()
        store.receive(
            site,
            listOf(
                "strict=s; SameSite=Strict; Domain=example.co.uk; Path=/",
                "lax=l; SameSite=Lax; Domain=example.co.uk; Path=/",
                "default=d; Domain=example.co.uk; Path=/",
                "none=n; SameSite=None; Secure; Domain=example.co.uk; Path=/",
            ),
            sameSiteContext(site),
        )

        val sameSiteDifferentHostAndPort = "https://www.example.co.uk:8443/path".toHttpUrl()
        val fromSibling = CookieRequestContext(
            initiatorUrl = "https://app.example.co.uk".toHttpUrl(),
            topLevelUrl = "https://top.example.co.uk:9443".toHttpUrl(),
        )
        assertEquals("strict=s; lax=l; default=d; none=n", store.requestHeader(sameSiteDifferentHostAndPort, fromSibling))

        val crossScheme = CookieRequestContext(
            initiatorUrl = "http://app.example.co.uk".toHttpUrl(),
            topLevelUrl = "http://app.example.co.uk".toHttpUrl(),
        )
        assertEquals(
            "lax=l; default=d; none=n",
            store.requestHeader("https://api.example.co.uk/".toHttpUrl(), crossScheme.copy(topLevelNavigation = true)),
        )

        val redirectedBack = CookieRequestContext(
            initiatorUrl = site,
            topLevelUrl = site,
            crossSiteRedirect = true,
        )
        assertEquals("lax=l; default=d; none=n", store.requestHeader(site, redirectedBack.copy(topLevelNavigation = true)))
    }

    @Test fun defaultLaxAllowsOnlyRecentUnsafeTopLevelNavigationAndCredentialsGateCookies() {
        var now = FIXED_NOW
        val store = NativeDocumentCookies(nowMillis = { now })
        val site = "https://app.example.test/page".toHttpUrl()
        store.receive(site, listOf("default=d; Path=/", "lax=l; SameSite=Lax; Path=/"), sameSiteContext(site))
        val crossSitePost = CookieRequestContext(
            initiatorUrl = "https://attacker.test/".toHttpUrl(),
            topLevelUrl = "https://attacker.test/".toHttpUrl(),
            method = "POST",
            topLevelNavigation = true,
        )
        assertEquals("default=d", store.requestHeader(site, crossSitePost))
        now += 120_001L
        assertNull(store.requestHeader(site, crossSitePost))
        assertNull(store.requestHeader(site, crossSitePost.copy(credentialsEnabled = false)))

        val ignoredResponseStore = NativeDocumentCookies(nowMillis = { now })
        assertEquals(
            0,
            ignoredResponseStore.receive(site, listOf("ignored=x"), crossSitePost.copy(credentialsEnabled = false)),
        )
        assertNull(ignoredResponseStore.requestHeader(site, sameSiteContext(site)))
    }

    @Test fun crossSiteSubresourceCannotSetDefaultLaxButCanSetSecureNone() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val target = "https://api.example.test/".toHttpUrl()
        val crossSiteSubresource = CookieRequestContext(
            initiatorUrl = "https://other.test/".toHttpUrl(),
            topLevelUrl = "https://other.test/".toHttpUrl(),
        )
        assertEquals(
            1,
            store.receive(
                target,
                listOf(
                    "blocked-default=x",
                    "blocked-strict=x; SameSite=Strict",
                    "allowed-none=n; SameSite=None; Secure",
                ),
                crossSiteSubresource,
            ),
        )
        assertEquals("allowed-none=n", store.requestHeader(target, crossSiteSubresource))
    }

    @Test fun documentCookieHidesHttpOnlyAndEnforcesSecurePrefixAndOverwriteRules() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val securePage = "https://www.example.test/login/index".toHttpUrl()
        store.receive(
            securePage,
            listOf(
                "httpOnly=secret; HttpOnly; Path=/",
                "securePath=s; Secure; Path=/login",
                "hostPrefix=h; Secure; Path=/",
                "readable=v; Path=/",
                "__Http-valid=server; Secure; HttpOnly; Path=/",
                "__Http-no-http-only=blocked; Secure; Path=/",
                "__Host-Http-valid=host-server; Secure; HttpOnly; Path=/",
                "__Host-Http-no-http-only=blocked; Secure; Path=/",
            ),
            sameSiteContext(securePage),
        )
        assertEquals("securePath=s; hostPrefix=h; readable=v", store.documentCookie(securePage))
        val requestCookies = store.requestHeader(securePage, sameSiteContext(securePage)).orEmpty()
        assertTrue(requestCookies.contains("__Http-valid=server"))
        assertTrue(requestCookies.contains("__Host-Http-valid=host-server"))
        assertFalse(requestCookies.contains("__Http-no-http-only"))
        assertFalse(requestCookies.contains("__Host-Http-no-http-only"))
        assertFalse(store.setDocumentCookie(securePage, "httpOnly=script; Path=/"))
        assertFalse(store.setDocumentCookie(securePage, "script=secret; HttpOnly"))
        assertFalse(store.setDocumentCookie("http://www.example.test/".toHttpUrl(), "__Secure-bad=x; Secure"))
        assertFalse(store.setDocumentCookie(securePage, "__Host-no-path=x; Secure"))
        assertFalse(store.setDocumentCookie(securePage, "__host-domain=x; Secure; Path=/; Domain=example.test"))
        assertTrue(store.setDocumentCookie(securePage, "__Host-valid=x; Secure; Path=/"))
        assertFalse(store.setDocumentCookie(securePage, "__Http-script=x; Secure"))

        val insecurePage = "http://www.example.test/".toHttpUrl()
        assertFalse(store.setDocumentCookie(insecurePage, "securePath=overwritten; Path=/login/child"))
        assertTrue(store.setDocumentCookie(insecurePage, "securePath=other-path; Path=/"))
        assertTrue(store.documentCookie("https://www.example.test/login/child".toHttpUrl()).contains("securePath=s"))
    }

    @Test fun hostPrefixRequiresHostOnlyEvenForAnExactLoopbackIpDomainAttribute() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val loopback = "http://127.0.0.1/".toHttpUrl()
        val context = sameSiteContext(loopback)

        // Chrome 155's frozen fixture accepts these exact-IP Domain cookies. Keep the host-only
        // prefix rule explicit here until native storage can preserve Chrome's special IP behavior.
        assertEquals(
            0,
            store.receive(
                loopback,
                listOf("__Host-Http-domain=x; Domain=127.0.0.1; Path=/; Secure; HttpOnly"),
                context,
            ),
        )
        assertFalse(
            store.setDocumentCookie(
                loopback,
                "__Host-script=x; Domain=127.0.0.1; Path=/; Secure",
                context = context,
            ),
        )
    }

    @Test fun scriptStateIsBoundedAndNeverExportsHttpOnlyValues() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val page = "https://embed.example.test/path/page".toHttpUrl()
        store.receive(
            page,
            listOf(
                "secret=do-not-export; HttpOnly; Path=/",
                "visible=okay; SameSite=None; Secure; Path=/elsewhere",
            ),
            sameSiteContext(page),
        )
        val state = store.exportScriptState(page)
        val cookies = state["cookies"] as List<Map<String, Any?>>
        val protections = state["protections"] as List<Map<String, Any?>>
        assertEquals("visible", cookies.single()["name"])
        assertEquals("okay", cookies.single()["value"])
        assertTrue(protections.any { it["name"] == "secret" && !it.containsKey("value") })
        assertTrue((state["generation"] as Long) > 0L)
        assertEquals(true, state["secureOrigin"])
        assertEquals(false, state["truncated"])

        val crossSiteDocument = CookieRequestContext(
            initiatorUrl = page,
            topLevelUrl = "https://top.test/".toHttpUrl(),
        )
        assertEquals("false", store.exportScriptState(page, crossSiteDocument)["sameSiteContext"].toString())
        assertEquals("", store.documentCookie(page, crossSiteDocument))
        val matchingPath = "https://embed.example.test/elsewhere".toHttpUrl()
        assertEquals(
            "visible=okay",
            store.documentCookie(matchingPath, crossSiteDocument.copy(initiatorUrl = matchingPath)),
        )
        assertFalse(store.setDocumentCookie(page, "blocked=x; SameSite=Lax", context = crossSiteDocument))
    }

    @Test fun scriptStateReportsWhenTheOneMiBExportCapTruncatesCookieRecords() {
        val store = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val page = "https://www.example.test/".toHttpUrl()
        val largeValue = "x".repeat(3_900)
        val headers = buildList {
            repeat(180) { index ->
                add("d${index.toString().padStart(3, '0')}=$largeValue; Domain=example.test; Path=/")
            }
            repeat(180) { index ->
                add("h${index.toString().padStart(3, '0')}=$largeValue; Path=/")
            }
        }
        assertEquals(360, store.receive(page, headers, sameSiteContext(page)))

        val state = store.exportScriptState(page)
        assertEquals(true, state["truncated"])
        val exported = state["cookies"] as List<Map<String, Any?>>
        assertTrue(exported.size in 1 until 360)
        assertTrue(exported.all { !it.containsKey("httpOnly") })
    }

    @Test fun persistenceIsDurableOnlyAndRetiredScopeRejectsLateMutations() {
        var now = FIXED_NOW
        val original = NativeDocumentCookies(nowMillis = { now })
        val page = "https://docs.example.test/".toHttpUrl()
        original.receive(
            page,
            listOf(
                "durable=d; Max-Age=60",
                "__Host-durable=h; Secure; Path=/; Max-Age=60",
                "session=s",
            ),
            sameSiteContext(page),
        )
        val durableSnapshot = original.snapshotPersistence()
        assertEquals(2, durableSnapshot.size)
        assertEquals(setOf("durable", "__Host-durable"), durableSnapshot.map { it["name"] }.toSet())
        assertEquals(true, durableSnapshot.single { it["name"] == "__Host-durable" }["hasHostPrefixPathAttribute"])

        val restored = NativeDocumentCookies(nowMillis = { now })
        assertEquals(2, restored.importPersistence(durableSnapshot))
        assertEquals("durable=d; __Host-durable=h", restored.requestHeader(page, sameSiteContext(page)))
        now += 61_000L
        val expired = NativeDocumentCookies(nowMillis = { now })
        assertEquals(0, expired.importPersistence(durableSnapshot))

        val generation = original.exportScriptState(page)["generation"] as Long
        original.retire()
        assertEquals(0, original.receive(page, listOf("late=x"), sameSiteContext(page)))
        assertFalse(original.setDocumentCookie(page, "late=script", expectedGeneration = generation))
        assertNull(original.requestHeader(page, sameSiteContext(page)))
        assertNull(restored.requestHeader(page, sameSiteContext(page)))
    }

    @Test fun sessionStoresAreIndependentAndChangeCallbackRunsAfterMutations() {
        var changes = 0
        val first = NativeDocumentCookies(nowMillis = { FIXED_NOW }, onChanged = { changes++ })
        val second = NativeDocumentCookies(nowMillis = { FIXED_NOW })
        val page = "https://one.example.test/".toHttpUrl()
        first.receive(page, listOf("first=1"), sameSiteContext(page))
        assertEquals(1, changes)
        assertNull(second.requestHeader(page, sameSiteContext(page)))
        first.retire()
        assertEquals(2, changes)
    }

    private fun sameSiteContext(url: HttpUrl) = CookieRequestContext(
        initiatorUrl = url,
        topLevelUrl = url,
    )

    companion object {
        private const val FIXED_NOW = 1_700_000_000_000L
    }
}
