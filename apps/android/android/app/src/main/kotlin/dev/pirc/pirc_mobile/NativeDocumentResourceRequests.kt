package dev.pirc.pirc_mobile

/** Active HTTP work belongs to exactly one native document session. */
internal class NativeDocumentResourceRequests {
    private val lock = Any()
    private val active = mutableMapOf<String, NativeResourceCancellation>()
    private var closed = false
    private val verifiedScriptUrls = mutableSetOf<String>()

    fun recordScriptUrl(url: String) = synchronized(lock) {
        check(!closed) { "The document resource session is closed" }
        check(url in verifiedScriptUrls || verifiedScriptUrls.size < 1024) { "Too many document script URLs" }
        verifiedScriptUrls.add(url)
        Unit
    }

    fun requireScriptReferrer(url: String, documentUrl: String): String = synchronized(lock) {
        check(!closed) { "The document resource session is closed" }
        require(url == documentUrl || url in verifiedScriptUrls) {
            "Module referrer must belong to a successfully loaded script in this document"
        }
        url
    }

    fun begin(requestId: String): NativeResourceCancellation = synchronized(lock) {
        require(requestId.matches(Regex("^(fetch|script|image|stylesheet)-[1-9][0-9]{0,15}$"))) {
            "Invalid document resource identifier"
        }
        check(!closed) { "The document resource session is closed" }
        check(requestId !in active) { "The document resource is already active" }
        check(active.size < 256) { "Too many active document resources" }
        NativeResourceCancellation().also { active[requestId] = it }
    }

    fun finish(requestId: String, token: NativeResourceCancellation) {
        synchronized(lock) {
            if (active[requestId] === token) active.remove(requestId)
        }
    }

    fun cancel(requestId: String) {
        val token = synchronized(lock) { active[requestId] }
        token?.cancel()
    }

    fun close() {
        val retiring = synchronized(lock) {
            closed = true
            verifiedScriptUrls.clear()
            active.values.toList().also { active.clear() }
        }
        retiring.forEach { it.cancel() }
    }
}
