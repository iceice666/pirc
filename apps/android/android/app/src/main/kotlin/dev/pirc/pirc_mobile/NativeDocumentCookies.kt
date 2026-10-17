package dev.pirc.pirc_mobile

import okhttp3.Cookie
import okhttp3.HttpUrl
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/** Request facts that affect browser cookie delivery. URLs are kept separate from Referrer policy. */
internal data class CookieRequestContext(
    val initiatorUrl: HttpUrl? = null,
    val topLevelUrl: HttpUrl? = null,
    val method: String = "GET",
    val topLevelNavigation: Boolean = false,
    val credentialsEnabled: Boolean = true,
    /** Sticky bit carried over redirects that have crossed a schemeful site boundary. */
    val crossSiteRedirect: Boolean = false,
)

/**
 * A bounded, account-scoped cookie store for native document requests and document.cookie.
 * Create one instance per account scope. Retire it before replacing that scope; a retired
 * instance rejects late writes and never shares state with the replacement instance.
 */
internal class NativeDocumentCookies(
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val onChanged: () -> Unit = {},
    private val secureOriginPredicate: (HttpUrl) -> Boolean = DEFAULT_SECURE_ORIGIN,
) {
    private enum class SameSite { DEFAULT, STRICT, LAX, NONE }

    private data class StoredCookie(
        val cookie: Cookie,
        val sameSite: SameSite,
        val createdAtMillis: Long,
        var lastAccessAtMillis: Long,
        val creationOrder: Long,
        val hasHostPrefixPathAttribute: Boolean,
    )

    private data class ParsedCookie(
        val cookie: Cookie,
        val sameSite: SameSite,
        val hasPartitionedAttribute: Boolean,
        val hasPathAttribute: Boolean,
    )

    private data class Mutation<T>(val value: T, val changed: Boolean)

    private val lock = Any()
    private val cookies = mutableListOf<StoredCookie>()
    private var nextCreationOrder = 0L
    private var revision = 0L
    private var generation = NEXT_GENERATION.getAndIncrement()
    private var retired = false

    /** Process each Set-Cookie field independently; headers must not be comma-joined. */
    fun receive(
        url: HttpUrl,
        setCookieHeaders: List<String>,
        context: CookieRequestContext,
    ): Int {
        if (!context.credentialsEnabled || !isHttpUrl(url)) return 0
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) return@synchronized Mutation(0, false)
            var changed = pruneExpiredLocked(now)
            var accepted = 0
            for (line in setCookieHeaders) {
                if (!validLineSize(line)) continue
                val parsed = parseCookie(url, line, now) ?: continue
                if (parsed.hasPartitionedAttribute) continue
                val cookie = parsed.cookie
                if (cookie.secure && !isSecureOrigin(url)) continue
                if (!validPrefix(parsed, url)) continue
                if (parsed.sameSite == SameSite.NONE && !cookie.secure) continue
                if (!sameSiteForRequest(url, context) && !context.topLevelNavigation &&
                    parsed.sameSite != SameSite.NONE
                ) continue

                val applied = applyCookieLocked(
                    url = url,
                    parsed = parsed,
                    now = now,
                    fromScript = false,
                )
                if (applied) {
                    accepted++
                    changed = true
                }
            }
            if (changed) revision++
            Mutation(accepted, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /** Returns the Cookie header value, or null if no cookie is eligible for this request. */
    fun requestHeader(url: HttpUrl, context: CookieRequestContext): String? {
        if (!context.credentialsEnabled || !isHttpUrl(url)) return null
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) return@synchronized Mutation(null, false)
            val changed = pruneExpiredLocked(now)
            if (changed) revision++
            val eligible = cookies.filter { stored ->
                val cookie = stored.cookie
                matchesUrl(cookie, url) && sameSiteAllows(stored, url, context, now)
            }.sortedWith(cookieOrder())
            eligible.forEach { it.lastAccessAtMillis = now }
            Mutation(
                eligible.takeIf { it.isNotEmpty() }
                    ?.joinToString(separator = "; ") { "${it.cookie.name}=${it.cookie.value}" },
                changed,
            )
        }
        notifyChanged(result.changed)
        return result.value
    }

    /** document.cookie getter: path, Secure, domain, expiry and HttpOnly rules are applied. */
    fun documentCookie(
        url: HttpUrl,
        context: CookieRequestContext = CookieRequestContext(initiatorUrl = url, topLevelUrl = url),
    ): String {
        if (!isHttpUrl(url)) return ""
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) return@synchronized Mutation("", false)
            val changed = pruneExpiredLocked(now)
            val visible = cookies.filter { stored ->
                !stored.cookie.httpOnly && matchesUrl(stored.cookie, url) &&
                    sameSiteForDocument(url, context, stored.sameSite)
            }.sortedWith(cookieOrder())
            visible.forEach { it.lastAccessAtMillis = now }
            if (changed) revision++
            Mutation(visible.joinToString("; ") { "${it.cookie.name}=${it.cookie.value}" }, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /**
     * Apply a document.cookie assignment. HttpOnly writes and stale generation writes are
     * rejected. Cookie syntax, domain/public-suffix, prefix, Secure and overwrite rules are
     * checked again here even if JavaScript has already updated its local synchronous view.
     */
    fun setDocumentCookie(
        url: HttpUrl,
        line: String,
        expectedGeneration: Long? = null,
        context: CookieRequestContext = CookieRequestContext(initiatorUrl = url, topLevelUrl = url),
    ): Boolean {
        if (!isHttpUrl(url) || !validLineSize(line)) return false
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired || (expectedGeneration != null && expectedGeneration != generation)) {
                return@synchronized Mutation(false, false)
            }
            var changed = pruneExpiredLocked(now)
            val parsed = parseCookie(url, line, now)
            if (parsed == null || parsed.hasPartitionedAttribute || parsed.cookie.httpOnly) {
                if (changed) revision++
                return@synchronized Mutation(false, changed)
            }
            val cookie = parsed.cookie
            if ((cookie.secure && !isSecureOrigin(url)) || !validPrefix(parsed, url) ||
                (parsed.sameSite == SameSite.NONE && !cookie.secure) ||
                (parsed.sameSite != SameSite.NONE && !sameSiteForDocument(url, context, parsed.sameSite))
            ) {
                if (changed) revision++
                return@synchronized Mutation(false, changed)
            }
            val applied = applyCookieLocked(url, parsed, now, fromScript = true)
            changed = changed || applied
            if (changed) revision++
            Mutation(applied, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /**
     * JSON/StandardMessageCodec-safe seed for the JavaScript document.cookie shim.
     * Cookie values are included only for non-HttpOnly cookies. Cookies from other paths are
     * included so same-origin history.pushState can filter them synchronously in JavaScript.
     */
    fun exportScriptState(
        url: HttpUrl,
        context: CookieRequestContext = CookieRequestContext(initiatorUrl = url, topLevelUrl = url),
    ): Map<String, Any?> {
        if (!isHttpUrl(url)) {
            return emptyScriptState(url, context, truncated = false)
        }
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) {
                return@synchronized Mutation(emptyScriptState(url, context, truncated = false), false)
            }
            val changed = pruneExpiredLocked(now)
            if (changed) revision++
            val domainCookies = cookies.filter { domainMatchesUrl(it.cookie, url) }
                .sortedWith(cookieOrder())
            val visible = domainCookies.filter { !it.cookie.httpOnly &&
                (!it.cookie.secure || isSecureOrigin(url)) &&
                sameSiteForDocument(url, context, it.sameSite)
            }.map(::scriptCookieRecord)
            val protections = domainCookies.filter { it.cookie.httpOnly || it.cookie.secure }
                .map(::protectionRecord)
            val base = linkedMapOf<String, Any?>(
                "generation" to generation,
                "revision" to revision,
                "url" to url.toString(),
                "secureOrigin" to isSecureOrigin(url),
                "sameSiteContext" to sameSiteDocumentContext(url, context),
                "cookies" to emptyList<Map<String, Any?>>(),
                "protections" to emptyList<Map<String, Any?>>(),
                "allowedDomainSuffixes" to allowedDomainSuffixes(url),
                "truncated" to false,
            )
            val selectedCookies = mutableListOf<Map<String, Any?>>()
            val selectedProtections = mutableListOf<Map<String, Any?>>()
            var truncated = false
            for (record in visible) {
                selectedCookies += record
                base["cookies"] = selectedCookies.toList()
                if (jsonSize(base) > MAX_SCRIPT_STATE_BYTES) {
                    selectedCookies.removeAt(selectedCookies.lastIndex)
                    truncated = true
                    break
                }
            }
            if (!truncated) {
                for (record in protections) {
                    selectedProtections += record
                    base["protections"] = selectedProtections.toList()
                    if (jsonSize(base) > MAX_SCRIPT_STATE_BYTES) {
                        selectedProtections.removeAt(selectedProtections.lastIndex)
                        truncated = true
                        break
                    }
                }
            } else if (protections.isNotEmpty()) {
                truncated = true
            }
            base["cookies"] = selectedCookies.toList()
            base["protections"] = selectedProtections.toList()
            base["truncated"] = truncated
            // The fixed fields and bounded domain suffix list are small, but retain an explicit
            // error if future fields ever make the base exceed the transport limit.
            if (jsonSize(base) > MAX_SCRIPT_STATE_BYTES) {
                base["cookies"] = emptyList<Map<String, Any?>>()
                base["protections"] = emptyList<Map<String, Any?>>()
                base["truncated"] = true
                base["error"] = "script_cookie_state_too_large"
                if (jsonSize(base) > MAX_SCRIPT_STATE_BYTES) {
                    base.clear()
                    base["generation"] = generation
                    base["revision"] = revision
                    base["url"] = ""
                    base["secureOrigin"] = false
                    base["sameSiteContext"] = false
                    base["cookies"] = emptyList<Map<String, Any?>>()
                    base["protections"] = emptyList<Map<String, Any?>>()
                    base["allowedDomainSuffixes"] = emptyList<String>()
                    base["truncated"] = true
                    base["error"] = "script_cookie_state_too_large"
                }
            }
            Mutation(base, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /** Export durable, unexpired cookies only; session cookies are never persisted. */
    fun snapshotPersistence(): List<Map<String, Any?>> {
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) return@synchronized Mutation(emptyList(), false)
            val changed = pruneExpiredLocked(now)
            if (changed) revision++
            val snapshot = cookies.filter { it.cookie.persistent && it.cookie.expiresAt > now }
                .sortedWith(compareBy<StoredCookie> { it.creationOrder }.thenBy { it.cookie.name })
                .map(::persistenceRecord)
            Mutation(snapshot, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /** Import previously exported durable cookies after validating every field and PSL boundary. */
    fun importPersistence(records: List<Map<String, Any?>>): Int {
        val now = nowMillis()
        val result = synchronized(lock) {
            if (retired) return@synchronized Mutation(0, false)
            var changed = pruneExpiredLocked(now)
            var imported = 0
            for (record in records.take(MAX_TOTAL_COOKIES)) {
                val parsed = parsePersistenceRecord(record, now) ?: continue
                val candidate = parsed.first
                val sameSite = parsed.second
                if (candidate.cookie.expiresAt <= now || !validStoredCookie(candidate)) continue
                if (cookies.any { sameKey(it.cookie, candidate.cookie) }) continue
                evictForCapacityLocked(candidate.cookie)
                cookies += candidate
                nextCreationOrder = maxOf(nextCreationOrder, candidate.creationOrder + 1)
                imported++
                changed = true
            }
            if (changed) revision++
            Mutation(imported, changed)
        }
        notifyChanged(result.changed)
        return result.value
    }

    /** Retire this account scope and invalidate any JavaScript state seeded from it. */
    fun retire() {
        val changed = synchronized(lock) {
            if (retired) return@synchronized false
            retired = true
            cookies.clear()
            generation = NEXT_GENERATION.getAndIncrement()
            revision++
            true
        }
        notifyChanged(changed)
    }

    private fun applyCookieLocked(
        url: HttpUrl,
        parsed: ParsedCookie,
        now: Long,
        fromScript: Boolean,
    ): Boolean {
        val cookie = parsed.cookie
        val existing = cookies.firstOrNull { sameKey(it.cookie, cookie) }
        if (fromScript && cookies.any { stored ->
                stored.cookie.httpOnly && sameKey(stored.cookie, cookie)
            }
        ) return false
        if (!isSecureOrigin(url) && cookies.any { stored ->
                secureCookieBlocksOverwrite(stored.cookie, cookie)
            }
        ) return false

        if (cookie.expiresAt <= now) {
            val index = cookies.indexOfFirst { sameKey(it.cookie, cookie) }
            if (index < 0) return false
            cookies.removeAt(index)
            return true
        }

        val replacement = if (existing != null) {
            StoredCookie(
                cookie,
                parsed.sameSite,
                existing.createdAtMillis,
                now,
                existing.creationOrder,
                parsed.hasPathAttribute,
            )
        } else {
            StoredCookie(cookie, parsed.sameSite, now, now, nextCreationOrder++, parsed.hasPathAttribute)
        }
        if (existing != null) cookies.remove(existing)
        evictForCapacityLocked(cookie)
        cookies += replacement
        return true
    }

    private fun evictForCapacityLocked(incoming: Cookie) {
        while (cookies.count { it.cookie.domain == incoming.domain } >= MAX_COOKIES_PER_DOMAIN) {
            val oldest = cookies.filter { it.cookie.domain == incoming.domain }
                .minWithOrNull(evictionOrder()) ?: break
            cookies.remove(oldest)
        }
        while (cookies.size >= MAX_TOTAL_COOKIES) {
            val oldest = cookies.minWithOrNull(evictionOrder()) ?: break
            cookies.remove(oldest)
        }
    }

    private fun pruneExpiredLocked(now: Long): Boolean {
        val before = cookies.size
        cookies.removeAll { it.cookie.expiresAt <= now }
        return cookies.size != before
    }

    private fun sameSiteAllows(
        stored: StoredCookie,
        requestUrl: HttpUrl,
        context: CookieRequestContext,
        now: Long,
    ): Boolean {
        if (sameSiteForRequest(requestUrl, context)) return true
        return when (stored.sameSite) {
            SameSite.NONE -> true
            SameSite.STRICT -> false
            SameSite.LAX -> context.topLevelNavigation && isSafeMethod(context.method)
            SameSite.DEFAULT -> context.topLevelNavigation &&
                (isSafeMethod(context.method) || isWithinDefaultLaxGrace(stored, now))
        }
    }

    private fun sameSiteForDocument(
        documentUrl: HttpUrl,
        context: CookieRequestContext,
        cookieSameSite: SameSite,
    ): Boolean = cookieSameSite == SameSite.NONE || sameSiteDocumentContext(documentUrl, context)

    private fun sameSiteDocumentContext(documentUrl: HttpUrl, context: CookieRequestContext): Boolean {
        val topLevel = context.topLevelUrl ?: context.initiatorUrl ?: documentUrl
        return schemefulSameSite(documentUrl, topLevel)
    }

    private fun sameSiteForRequest(requestUrl: HttpUrl, context: CookieRequestContext): Boolean {
        if (context.crossSiteRedirect) return false
        val sourceUrls = listOfNotNull(context.initiatorUrl, context.topLevelUrl)
        if (sourceUrls.isEmpty()) {
            // A caller can model an address-bar/new-tab navigation as same-site by supplying
            // its target as initiatorUrl or topLevelUrl. An unknown subresource context fails closed.
            return false
        }
        return sourceUrls.all { schemefulSameSite(it, requestUrl) }
    }

    private fun isWithinDefaultLaxGrace(cookie: StoredCookie, now: Long): Boolean {
        val age = now - cookie.createdAtMillis
        return age >= 0L && age <= DEFAULT_LAX_UNSAFE_GRACE_MILLIS
    }

    private fun parseCookie(url: HttpUrl, line: String, now: Long): ParsedCookie? {
        if (!validLineSize(line) || !isHttpUrl(url)) return null
        val cookie = try {
            Cookie.parse(url, line)
        } catch (_: IllegalArgumentException) {
            null
        } ?: return null
        if (!validCookieSize(cookie)) return null
        val attributes = parseAttributes(line)
        val maxAgeSeconds = attributes.asSequence()
            .filter { it.first.equals("max-age", ignoreCase = true) }
            .mapNotNull { parseMaxAgeSeconds(it.second) }
            .lastOrNull()
        val effectiveCookie = when {
            maxAgeSeconds != null -> cookie.withExpiresAt(maxAgeExpiry(now, maxAgeSeconds))
            cookie.persistent -> cookie.withExpiresAt(minOf(cookie.expiresAt, maxCookieExpiry(now)))
            else -> cookie
        }
        val sameSiteAttribute = attributes.lastOrNull { it.first.equals("samesite", ignoreCase = true) }
        val sameSite = when (sameSiteAttribute?.second?.trim()?.lowercase(Locale.ROOT)) {
            "strict" -> SameSite.STRICT
            "lax" -> SameSite.LAX
            "none" -> SameSite.NONE
            else -> SameSite.DEFAULT
        }
        val pathAttribute = attributes.lastOrNull { attribute ->
            attribute.first.equals("path", ignoreCase = true) &&
                attribute.second?.toByteArray(StandardCharsets.UTF_8)?.size?.let { it <= 1024 } == true
        }?.second
        return ParsedCookie(
            cookie = effectiveCookie,
            sameSite = sameSite,
            hasPartitionedAttribute = attributes.any { it.first.equals("partitioned", ignoreCase = true) },
            hasPathAttribute = pathAttribute == "/",
        )
    }

    private fun parseMaxAgeSeconds(value: String?): Long? {
        if (value.isNullOrEmpty()) return null
        val negative = value[0] == '-'
        val firstDigit = if (negative) 1 else 0
        if (firstDigit == value.length) return null
        for (index in firstDigit until value.length) {
            if (value[index] !in '0'..'9') return null
        }
        if (negative) return 0L

        var seconds = 0L
        for (index in firstDigit until value.length) {
            val digit = value[index] - '0'
            if (seconds > MAX_COOKIE_AGE_SECONDS / 10L ||
                (seconds == MAX_COOKIE_AGE_SECONDS / 10L && digit > MAX_COOKIE_AGE_SECONDS % 10L)
            ) return MAX_COOKIE_AGE_SECONDS
            seconds = seconds * 10L + digit
        }
        return seconds.coerceAtMost(MAX_COOKIE_AGE_SECONDS)
    }

    private fun maxAgeExpiry(now: Long, seconds: Long): Long {
        if (seconds <= 0L) return Long.MIN_VALUE
        val ageMillis = seconds * 1000L
        if (now >= MAX_COOKIE_EXPIRY_AT) return MAX_COOKIE_EXPIRY_AT
        return if (now > MAX_COOKIE_EXPIRY_AT - ageMillis) {
            MAX_COOKIE_EXPIRY_AT
        } else {
            now + ageMillis
        }
    }

    private fun maxCookieExpiry(now: Long): Long {
        if (now >= MAX_COOKIE_EXPIRY_AT) return MAX_COOKIE_EXPIRY_AT
        return if (now > MAX_COOKIE_EXPIRY_AT - MAX_COOKIE_AGE_MILLIS) {
            MAX_COOKIE_EXPIRY_AT
        } else {
            now + MAX_COOKIE_AGE_MILLIS
        }
    }

    private fun Cookie.withExpiresAt(expiresAt: Long): Cookie {
        if (expiresAt == this.expiresAt) return this
        return Cookie.Builder().name(name).value(value).apply {
            if (hostOnly) hostOnlyDomain(domain) else domain(domain)
            path(path)
            expiresAt(expiresAt)
            if (secure) secure()
            if (httpOnly) httpOnly()
            this@withExpiresAt.sameSite?.let { sameSite(it) }
        }.build()
    }

    private fun validPrefix(parsed: ParsedCookie, sourceUrl: HttpUrl): Boolean {
        return validPrefixRequirements(
            cookie = parsed.cookie,
            hasHostPrefixPathAttribute = parsed.hasPathAttribute,
            secureSource = isSecureOrigin(sourceUrl),
        )
    }

    private fun validStoredCookie(stored: StoredCookie): Boolean {
        val cookie = stored.cookie
        if (!validCookieSize(cookie) || (stored.sameSite == SameSite.NONE && !cookie.secure)) return false
        if (!validPrefixRequirements(cookie, stored.hasHostPrefixPathAttribute, secureSource = true)) return false
        if (!cookie.hostOnly && !domainAttributeAccepted(cookie.domain)) return false
        return true
    }

    private fun validPrefixRequirements(
        cookie: Cookie,
        hasHostPrefixPathAttribute: Boolean,
        secureSource: Boolean,
    ): Boolean {
        val name = cookie.name
        val value = cookie.value
        val securePrefix = name.startsWith("__Secure-", ignoreCase = true)
        val hostPrefix = name.startsWith("__Host-", ignoreCase = true)
        val httpPrefix = name.startsWith("__Http-", ignoreCase = true)
        val hostHttpPrefix = name.startsWith("__Host-Http-", ignoreCase = true)
        if (name.isEmpty() && (value.startsWith("__Secure-", ignoreCase = true) ||
                value.startsWith("__Host-", ignoreCase = true))
        ) return false
        if ((securePrefix || hostPrefix || httpPrefix || hostHttpPrefix) &&
            (!cookie.secure || !secureSource)
        ) return false
        if ((httpPrefix || hostHttpPrefix) && !cookie.httpOnly) return false
        if ((hostPrefix || hostHttpPrefix) &&
            (!cookie.hostOnly || cookie.path != "/" || !hasHostPrefixPathAttribute)
        ) return false
        return true
    }

    private fun parsePersistenceRecord(record: Map<String, Any?>, now: Long): Pair<StoredCookie, SameSite>? {
        val name = record["name"] as? String ?: return null
        val value = record["value"] as? String ?: return null
        val domain = record["domain"] as? String ?: return null
        val path = record["path"] as? String ?: return null
        val hostOnly = record["hostOnly"] as? Boolean ?: return null
        val secure = record["secure"] as? Boolean ?: return null
        val httpOnly = record["httpOnly"] as? Boolean ?: return null
        val hasHostPrefixPathAttribute = record["hasHostPrefixPathAttribute"] as? Boolean ?: false
        val sameSite = parseSameSite(record["sameSite"] as? String) ?: return null
        val expiresAt = record["expiresAt"].asLongOrNull() ?: return null
        val createdAt = record["createdAt"].asLongOrNull() ?: return null
        val creationOrder = record["creationOrder"].asLongOrNull() ?: return null
        if (expiresAt == Long.MAX_VALUE || expiresAt <= now || createdAt < 0 || creationOrder < 0) return null
        if (name.toByteArray(StandardCharsets.UTF_8).size + value.toByteArray(StandardCharsets.UTF_8).size > MAX_COOKIE_BYTES) return null
        val cookie = try {
            Cookie.Builder().name(name).value(value).apply {
                if (hostOnly) hostOnlyDomain(domain) else domain(domain)
                path(path)
                expiresAt(expiresAt)
                if (secure) secure()
                if (httpOnly) httpOnly()
            }.build()
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (cookie.domain != domain.lowercase(Locale.ROOT) || cookie.hostOnly != hostOnly) return null
        val stored = StoredCookie(cookie, sameSite, createdAt, now, creationOrder, hasHostPrefixPathAttribute)
        return stored to sameSite
    }

    private fun domainAttributeAccepted(domain: String): Boolean {
        val url = try {
            HttpUrl.Builder().scheme("https").host(domain).build()
        } catch (_: IllegalArgumentException) {
            return false
        }
        val probe = try {
            Cookie.parse(url, "pirc-domain-check=1; Domain=$domain; Path=/")
        } catch (_: IllegalArgumentException) {
            null
        }
        return probe != null && !probe.hostOnly && probe.domain == domain.lowercase(Locale.ROOT)
    }

    private fun matchesUrl(cookie: Cookie, url: HttpUrl): Boolean =
        domainMatchesUrl(cookie, url) && pathMatches(url.encodedPath, cookie.path) &&
            (!cookie.secure || isSecureOrigin(url))

    private fun domainMatchesUrl(cookie: Cookie, url: HttpUrl): Boolean {
        val host = url.host
        return if (cookie.hostOnly) {
            host.equals(cookie.domain, ignoreCase = true)
        } else {
            domainMatches(host, cookie.domain)
        }
    }

    private fun domainMatches(host: String, domain: String): Boolean =
        host.equals(domain, ignoreCase = true) || host.endsWith(".$domain", ignoreCase = true)

    private fun pathMatches(requestPath: String, cookiePath: String): Boolean {
        if (requestPath == cookiePath) return true
        if (!requestPath.startsWith(cookiePath)) return false
        return cookiePath.endsWith('/') || requestPath.getOrNull(cookiePath.length) == '/'
    }

    private fun secureCookieBlocksOverwrite(existing: Cookie, incoming: Cookie): Boolean {
        if (!existing.secure || incoming.secure || existing.name != incoming.name) return false
        val domainOverlap = domainMatches(incoming.domain, existing.domain) ||
            domainMatches(existing.domain, incoming.domain)
        // Cookie integrity protects an existing secure path when the new cookie's path
        // path-matches it; this comparison is intentionally directional.
        val pathOverlap = pathMatches(incoming.path, existing.path)
        return domainOverlap && pathOverlap
    }

    private fun sameKey(first: Cookie, second: Cookie): Boolean =
        first.name == second.name && first.domain == second.domain &&
            first.hostOnly == second.hostOnly && first.path == second.path

    private fun isSecureOrigin(url: HttpUrl): Boolean = secureOriginPredicate(url)

    private fun allowedDomainSuffixes(url: HttpUrl): List<String> {
        val labels = url.host.split('.')
        val candidates = if (labels.size == 1 || url.host.contains(':')) {
            listOf(url.host)
        } else {
            labels.indices.map { index -> labels.drop(index).joinToString(".") }
        }
        return candidates.distinct().filter { candidate ->
            val probe = try {
                Cookie.parse(url, "pirc-domain-check=1; Domain=$candidate; Path=/")
            } catch (_: IllegalArgumentException) {
                null
            }
            probe != null && !probe.hostOnly && probe.domain == candidate.lowercase(Locale.ROOT)
        }
    }

    private fun scriptCookieRecord(stored: StoredCookie): Map<String, Any?> = linkedMapOf(
        "name" to stored.cookie.name,
        "value" to stored.cookie.value,
        "domain" to stored.cookie.domain,
        "path" to stored.cookie.path,
        "hostOnly" to stored.cookie.hostOnly,
        "secure" to stored.cookie.secure,
        "expiresAt" to stored.cookie.expiresAt.takeIf { stored.cookie.persistent },
        "sameSite" to stored.sameSite.wireName(),
        "createdAt" to stored.createdAtMillis,
        "creationOrder" to stored.creationOrder,
        "hasHostPrefixPathAttribute" to stored.hasHostPrefixPathAttribute,
    )

    private fun protectionRecord(stored: StoredCookie): Map<String, Any?> = linkedMapOf(
        "name" to stored.cookie.name,
        "domain" to stored.cookie.domain,
        "path" to stored.cookie.path,
        "hostOnly" to stored.cookie.hostOnly,
        "secure" to stored.cookie.secure,
        "httpOnly" to stored.cookie.httpOnly,
    )

    private fun persistenceRecord(stored: StoredCookie): Map<String, Any?> = linkedMapOf(
        "name" to stored.cookie.name,
        "value" to stored.cookie.value,
        "domain" to stored.cookie.domain,
        "path" to stored.cookie.path,
        "hostOnly" to stored.cookie.hostOnly,
        "secure" to stored.cookie.secure,
        "httpOnly" to stored.cookie.httpOnly,
        "sameSite" to stored.sameSite.wireName(),
        "expiresAt" to stored.cookie.expiresAt,
        "createdAt" to stored.createdAtMillis,
        "creationOrder" to stored.creationOrder,
        "hasHostPrefixPathAttribute" to stored.hasHostPrefixPathAttribute,
    )

    private fun emptyScriptState(
        url: HttpUrl,
        context: CookieRequestContext,
        truncated: Boolean,
    ): Map<String, Any?> {
        val state = linkedMapOf<String, Any?>(
            "generation" to synchronized(lock) { generation },
            "revision" to synchronized(lock) { revision },
            "url" to url.toString(),
            "secureOrigin" to (isHttpUrl(url) && isSecureOrigin(url)),
            "sameSiteContext" to (isHttpUrl(url) && sameSiteDocumentContext(url, context)),
            "cookies" to emptyList<Map<String, Any?>>(),
            "protections" to emptyList<Map<String, Any?>>(),
            "allowedDomainSuffixes" to if (isHttpUrl(url)) allowedDomainSuffixes(url) else emptyList<String>(),
            "truncated" to truncated,
        )
        if (jsonSize(state) <= MAX_SCRIPT_STATE_BYTES) return state
        return linkedMapOf(
            "generation" to synchronized(lock) { generation },
            "revision" to synchronized(lock) { revision },
            "url" to "",
            "secureOrigin" to false,
            "sameSiteContext" to false,
            "cookies" to emptyList<Map<String, Any?>>(),
            "protections" to emptyList<Map<String, Any?>>(),
            "allowedDomainSuffixes" to emptyList<String>(),
            "truncated" to true,
            "error" to "script_cookie_state_too_large",
        )
    }

    private fun cookieOrder(): Comparator<StoredCookie> =
        compareByDescending<StoredCookie> { it.cookie.path.length }.thenBy { it.creationOrder }

    private fun evictionOrder(): Comparator<StoredCookie> =
        compareBy<StoredCookie> { it.lastAccessAtMillis }.thenBy { it.creationOrder }

    private fun parseAttributes(line: String): List<Pair<String, String?>> = line.split(';').drop(1).map { raw ->
        val attribute = raw.trim()
        val separator = attribute.indexOf('=')
        if (separator < 0) attribute to null
        else attribute.substring(0, separator).trim() to attribute.substring(separator + 1).trim()
    }

    private fun parseSameSite(value: String?): SameSite? = when (value?.lowercase(Locale.ROOT)) {
        "default" -> SameSite.DEFAULT
        "strict" -> SameSite.STRICT
        "lax" -> SameSite.LAX
        "none" -> SameSite.NONE
        else -> null
    }

    private fun SameSite.wireName(): String = when (this) {
        SameSite.DEFAULT -> "default"
        SameSite.STRICT -> "strict"
        SameSite.LAX -> "lax"
        SameSite.NONE -> "none"
    }

    private fun isSafeMethod(method: String): Boolean =
        method.uppercase(Locale.ROOT) in SAFE_METHODS

    private fun isHttpUrl(url: HttpUrl): Boolean = url.scheme == "http" || url.scheme == "https"

    private fun validLineSize(line: String): Boolean =
        line.toByteArray(StandardCharsets.UTF_8).size <= MAX_COOKIE_BYTES

    private fun validCookieSize(cookie: Cookie): Boolean =
        cookie.name.toByteArray(StandardCharsets.UTF_8).size +
            cookie.value.toByteArray(StandardCharsets.UTF_8).size <= MAX_COOKIE_BYTES

    private fun notifyChanged(changed: Boolean) {
        if (changed) runCatching { onChanged() }
    }

    private fun Any?.asLongOrNull(): Long? = when (this) {
        is Long -> this
        is Int -> toLong()
        is Short -> toLong()
        is Byte -> toLong()
        is Double -> if (isFinite() && this % 1.0 == 0.0 && this >= Long.MIN_VALUE && this <= Long.MAX_VALUE) toLong() else null
        is Float -> if (isFinite() && this % 1f == 0f && this >= Long.MIN_VALUE && this <= Long.MAX_VALUE) toLong() else null
        else -> null
    }

    private fun jsonSize(value: Any?): Int = when (value) {
        null -> 4
        is Boolean -> if (value) 4 else 5
        is Number -> value.toString().toByteArray(StandardCharsets.UTF_8).size
        is String -> jsonStringSize(value)
        is Map<*, *> -> 2 + value.entries.sumOf { jsonStringSize(it.key.toString()) + 1 + jsonSize(it.value) } +
            (value.size - 1).coerceAtLeast(0)
        is Iterable<*> -> 2 + value.sumOf(::jsonSize) + (value.count() - 1).coerceAtLeast(0)
        else -> jsonStringSize(value.toString())
    }

    private fun jsonStringSize(value: String): Int {
        var size = 2 // quotes
        for (char in value) {
            size += when (char) {
                '"', '\\', '\b', '\u000c', '\n', '\r', '\t' -> 2
                in '\u0000'..'\u001f' -> 6
                in '\u0000'..'\u007f' -> 1
                else -> 6 // conservative for non-ASCII and surrogate pairs
            }
        }
        return size
    }

    companion object {
        private const val MAX_COOKIE_BYTES = 4096
        private const val MAX_COOKIES_PER_DOMAIN = 180
        private const val MAX_TOTAL_COOKIES = 3000
        private const val MAX_SCRIPT_STATE_BYTES = 1024 * 1024
        private const val MAX_COOKIE_AGE_SECONDS = 400L * 24L * 60L * 60L
        private const val MAX_COOKIE_AGE_MILLIS = MAX_COOKIE_AGE_SECONDS * 1000L
        private const val MAX_COOKIE_EXPIRY_AT = 253_402_300_799_999L
        private const val DEFAULT_LAX_UNSAFE_GRACE_MILLIS = 120_000L
        private val SAFE_METHODS = setOf("GET", "HEAD", "OPTIONS", "TRACE")
        private val NEXT_GENERATION = AtomicLong(1L)

        /** Compare schemeful sites using OkHttp's bundled Public Suffix List. */
        internal fun schemefulSameSite(left: HttpUrl, right: HttpUrl): Boolean =
            schemefulSiteKey(left) == schemefulSiteKey(right)

        private fun schemefulSiteKey(url: HttpUrl): String =
            "${url.scheme}://${url.topPrivateDomain() ?: url.host}"

        private val DEFAULT_SECURE_ORIGIN: (HttpUrl) -> Boolean = { url ->
            url.isHttps || isLoopbackHost(url.host)
        }

        private fun isLoopbackHost(host: String): Boolean {
            val normalized = host.lowercase(Locale.ROOT).trimEnd('.')
            if (normalized == "localhost" || normalized.endsWith(".localhost") || normalized == "::1") return true
            val octets = normalized.split('.')
            if (octets.size != 4) return false
            val numbers = octets.map { it.toIntOrNull() ?: return false }
            return numbers.all { it in 0..255 } && numbers[0] == 127
        }
    }
}
