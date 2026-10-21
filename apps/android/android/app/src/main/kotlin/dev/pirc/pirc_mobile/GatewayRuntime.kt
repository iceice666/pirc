package dev.pirc.pirc_mobile

import android.content.Context
import dev.pirc.android.core.*
import dev.pirc.android.core.timeline.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap

fun JsonElement?.wire(): Any? = when (this) {
    null, JsonNull -> null
    is JsonObject -> entries.associate { it.key to it.value.wire() }
    is JsonArray -> map { it.wire() }
    is JsonPrimitive -> if (isString) content else booleanOrNull ?: longOrNull ?: doubleOrNull ?: content
}
fun Any?.json(): JsonElement = when (this) {
    null -> JsonNull
    is Map<*, *> -> JsonObject(entries.associate { it.key.toString() to it.value.json() })
    is List<*> -> JsonArray(map { it.json() })
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    else -> JsonPrimitive(toString())
}
fun requirePairingStamp(expected: String?, actual: String?) {
    if (expected.isNullOrBlank() || expected != actual)
        throw ApiException(409, "account_changed", "配對帳戶已變更，請重新檢查問題")
}

/** Uses the existing Android authentication, HTTP client, reducer and event resumption. */
class GatewayRuntime private constructor(val context: Context) {
    internal data class HtmlMediaAccess(
        val pairing: Pairing,
        val pairingStamp: String,
        val contextLease: ContextRegistry.Lease,
        val cookies: NativeDocumentCookies?,
    )

    internal data class HtmlMediaResource(
        val bytes: ByteArray,
        val mimeType: String,
        val finalUrl: String,
        val headersRelevant: Map<String, String>,
    )

    private data class ScriptResourceAccess(
        val pairing: Pairing?,
        val pairingStamp: String?,
        val contextLease: ContextRegistry.Lease,
        val cookies: NativeDocumentCookies?,
    )

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val local = LocalStore(context)
    internal val credentials = KeystoreCredentialStore(context)
    private val documentCookies = NativeDocumentCookieStore(context)
    private val documentStorageStore = NativeDocumentStorageStore(context)
    private val documentStorage = NativeDocumentStorageCoordinator(documentStorageStore) {
        emitAccount("documentStorageChanged", it)
    }
    private var activeApi: PircApi? = null
    internal val activeApiOrNull: PircApi? get() = activeApi
    private var managementSession: Pair<PircApi, NativeManagementSession>? = null
    private val managementLock = Mutex()
    private suspend fun management(): NativeManagementSession = managementLock.withLock {
        val current = api()
        if (managementSession?.first !== current) {
            val stamp = ensurePairingStamp()
            managementSession = current to NativeManagementSession(current,
                { method, path, body -> requestWithApi(current, method, path, body) },
                { validatePairingStamp(stamp); if (activeApi !== current) throw ApiException(409, "account_changed", "配對已變更，請重試") },
            )
        }
        managementSession!!.second
    }
    private fun retireManagement() {
        activeApi?.clearManagementGrant()
        val retired = managementSession?.second
        managementSession = null
        if (retired != null) scope.launch {
            try { withTimeout(5_000) { retired.abandon() } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: java.io.IOException) { /* Offline cleanup expires at the gateway; local access is already closed. */ }
        }
    }
    suspend fun managementStatus() = management().status()
    suspend fun managementBegin(capabilities: List<String>) = management().begin(capabilities)
    suspend fun managementCheck() = management().check()
    suspend fun managementCancel() = management().cancel()
    suspend fun managementUrl() = management().url()
    private data class SocketKey(val contextId: String, val tag: String)
    private val contexts = ContextRegistry()
    private val socketTokens = ConcurrentHashMap<SocketKey, String>()
    internal val answerLock = Mutex()
    private val sockets = ConcurrentHashMap<SocketKey, WebSocket>()
    var listener: ((Map<String, Any?>) -> Unit)? = null
    internal val pairingIdentity = context.getSharedPreferences("pairing_identity", Context.MODE_PRIVATE)

    /** The session domain: watches, the control lease, commands and answers. */
    val sessions = SessionRuntime(this)

    /** The rooms' domain: what the room pages show, published as `rooms` events. */
    val rooms = RoomsRuntime(scope, ::api, publish = { type, data ->
        emitEvent(type, data, sessionId = null, scopeName = "rooms")
    })

    init {
        // One process-scoped collector belongs to this runtime singleton, not to
        // each EventChannel subscription. A fresh Flutter listener receives a
        // future network regain without accumulating collectors across engines.
        scope.launch {
            Connectivity.regained.collect {
                emitAccount("networkAvailable", true)
            }
        }
        Connectivity.start(context)
    }
    // A lost POST response is uncertain; HTTP transport must not replay mutations.
    private fun connectedApi(pairing: Pairing) = PircApi(pairing, defaultHttpClient().newBuilder().retryOnConnectionFailure(false).addInterceptor(ReadRecovery()).build())
    private fun rotatePairingStamp(): String {
        val stamp = UUID.randomUUID().toString()
        if (!pairingIdentity.edit().putString("stamp", stamp).commit())
            throw ApiException(503, "account_changed", "無法保存配對狀態，請稍後再試")
        return stamp
    }
    internal fun ensurePairingStamp(): String =
        pairingIdentity.getString("stamp", null) ?: rotatePairingStamp()
    internal suspend fun validatePairingStamp(expected: String) {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
        requirePairingStamp(expected, if (pairing == null) null else ensurePairingStamp())
    }
    suspend fun api(): PircApi = activeApi ?: withContext(Dispatchers.IO) {
        credentials.load()?.let { connectedApi(it) } ?: throw ApiException(401, "unpaired", "請先配對此裝置")
    }.also { activeApi = it }

    suspend fun boot(): Map<String, Any?> = answerLock.withLock {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
        val stamp = pairing?.let { ensurePairingStamp() }
        withContext(Dispatchers.IO) { documentCookies.bind(stamp); documentStorage.bind(stamp) }
        if (contexts.currentPairingStamp() != stamp) {
            closeAllContexts(releaseLeases = true)
            contexts.bindPairingStamp(stamp)
        }
        mapOf(
            "origin" to pairing?.baseUrl,
            "clientId" to local.clientId,
            "pairingStamp" to stamp,
            "documentStorage" to true,
            "documentStylesheets" to true,
        )
    }
    suspend fun openContext(contextId: String, pairingStamp: String): Map<String, Any?> = answerLock.withLock {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
            ?: throw ApiException(401, "unpaired", "請先配對此裝置")
        val currentStamp = ensurePairingStamp()
        requirePairingStamp(pairingStamp, currentStamp)
        if (contexts.currentPairingStamp() != currentStamp) {
            closeAllContexts(releaseLeases = true)
            contexts.bindPairingStamp(currentStamp)
        }
        val lease = try {
            contexts.openContext(contextId, currentStamp)
        } catch (e: ContextRegistryException) {
            throw ApiException(409, "context_expired", e.message ?: "此原生視窗已關閉")
        } catch (e: IllegalStateException) {
            throw ApiException(409, "context_invalid", e.message ?: "無法開啟原生視窗")
        }
        mapOf(
            "contextId" to lease.contextId,
            "contextEpoch" to lease.generation,
            "origin" to pairing.baseUrl,
            "clientId" to local.clientId,
            "pairingStamp" to currentStamp,
        )
    }
    fun validateContext(contextId: String?) {
        contextLease(contextId)
    }
    fun closeContext(contextId: String) {
        documentStorage.closeReadersForContext(contextId)
        if (contextId == ContextRegistry.PRIMARY_CONTEXT_ID) {
            sessions.removeContext(contextId)
            closeSocketsFor(contextId)
            return
        }
        val closed = contexts.closeContext(contextId) ?: return
        sessions.removeContext(contextId)
        closeSocketsFor(closed.contextId)
    }
    fun closeAllContexts(releaseLeases: Boolean = true) {
        documentStorage.closeAllReaders()
        contexts.invalidateAll()
        sessions.closeAll(releaseLeases)
        closeSockets()
    }
    suspend fun pair(link: String): Map<String, Any?> {
        val pairing = PairingLink.parse(link)
        val candidate = connectedApi(pairing)
        candidate.sessions() // Verify before replacing the saved connection.
        return answerLock.withLock {
            closeAllContexts(releaseLeases = true)
            val previous = withContext(Dispatchers.IO) { credentials.load() }
            if (previous != pairing) {
                rotatePairingStamp()
                withContext(Dispatchers.IO) { documentCookies.bind(null); documentStorage.bind(null) }
                GatewayNotifications.clearQuestionNotifications(context)
                dev.pirc.android.push.PushRegistration.disable(context, activeApi ?: previous?.let { connectedApi(it) })
                local.clearDrafts(); sessions.clearUncertain(); rooms.stop()
                context.getSharedPreferences("recent_activity", Context.MODE_PRIVATE).edit().clear().apply()
            }
            withContext(Dispatchers.IO) { credentials.save(pairing) }
            retireManagement()
            activeApi = candidate
            val stamp = ensurePairingStamp()
            contexts.bindPairingStamp(stamp)
            val result = mapOf("origin" to pairing.baseUrl, "clientId" to local.clientId, "pairingStamp" to stamp)
            emitAccount("pairingChanged", result)
            result
        }
    }
    suspend fun unpair() {
        answerLock.withLock {
            closeAllContexts(releaseLeases = true)
            dev.pirc.android.push.PushRegistration.disable(context, activeApi)
            val stamp = rotatePairingStamp()
            withContext(Dispatchers.IO) { documentCookies.bind(null); documentStorage.bind(null) }
            GatewayNotifications.clearQuestionNotifications(context)
            withContext(Dispatchers.IO) { credentials.clear() }
            retireManagement()
            activeApi = null
            local.clearDrafts()
            sessions.clearUncertain()
            rooms.stop()
            contexts.bindPairingStamp(null)
            emitAccount("pairingChanged", mapOf(
                "origin" to null,
                "clientId" to local.clientId,
                "pairingStamp" to stamp,
            ))
        }
    }
    fun emit(type: String, data: Any?, sessionId: String? = sessions.watched) {
        emitEvent(type, data, sessionId)
    }
    private fun emitAccount(type: String, data: Any?) {
        emitEvent(type, data, sessionId = null, scopeName = "account")
    }
    fun notifyPreferencesChanged(preferences: Map<String, Any>) {
        emitAccount("preferencesChanged", preferences)
    }
    internal fun externalDropLease(contextId: String?): ContextRegistry.Lease = contextLease(contextId)
    internal fun externalDropLeaseIsCurrent(lease: ContextRegistry.Lease): Boolean =
        contextLeaseIsCurrent(lease)

    internal fun emitExternalImageDrop(target: ExternalImageDropTarget, dropId: String, files: List<Map<String, Any>>) {
        scope.launch {
            if (!contextLeaseIsCurrent(target.lease)) return@launch
            val event = scopedEventWire(
                type = "externalImageDrop",
                data = mapOf(
                    "targetId" to target.targetId,
                    "scopeToken" to target.scopeToken,
                    "dropId" to dropId,
                    "files" to files,
                ),
                sessionId = target.sessionId,
                contextId = target.contextId,
            )
            listener?.invoke(event)
        }
    }

    internal fun emitEvent(
        type: String,
        data: Any?,
        sessionId: String?,
        contextId: String? = null,
        eventTag: String? = null,
        scopeName: String? = null,
    ) {
        val event = scopedEventWire(
            type = type,
            data = data,
            sessionId = sessionId,
            contextId = contextId,
            watchTag = eventTag,
            scopeName = scopeName,
        )
        scope.launch { listener?.invoke(event) }
    }
    internal fun contextLease(contextId: String?): ContextRegistry.Lease = try {
        contexts.requireContext(contextId)
    } catch (e: ContextRegistryException) {
        throw ApiException(409, "context_expired", e.message ?: "此原生視窗已關閉")
    }
    internal fun contextLeaseIsCurrent(lease: ContextRegistry.Lease): Boolean = contexts.isCurrent(lease)
    suspend fun request(method: String, path: String, body: Any?): Any? = withContext(Dispatchers.IO) {
        require(path.startsWith("/api/") && !path.contains('\\') && !path.contains('#'))
        requestWithApi(api(), method, path, body)
    }
    /** Run a short local notification update atomically with pair/unpair changes. */
    suspend fun withCurrentPairingStamp(action: (String) -> Unit) = answerLock.withLock {
        withContext(Dispatchers.IO) { credentials.load() }
            ?: throw ApiException(401, "unpaired", "請先配對此裝置")
        action(ensurePairingStamp())
    }

    /** A revoke may safely clear its exact old note while unpaired; pair changes serialize this update. */
    suspend fun withOptionalPairingStamp(action: (String?) -> Unit) = answerLock.withLock {
        val paired = withContext(Dispatchers.IO) { credentials.load() } != null
        action(if (paired) ensurePairingStamp() else null)
    }

    internal suspend fun requestWithApi(api: PircApi, method: String, path: String, body: Any?): Any? = withContext(Dispatchers.IO) {
        require(path.startsWith("/api/") && !path.contains('\\') && !path.contains('#'))
        val payload = if (method in listOf("GET", "HEAD")) null else body.json().toString().toRequestBody("application/json".toMediaType())
        api.client.newCall(api.request(path).header("Accept", "application/json").method(method, payload).build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { PircJson.parseToJsonElement(text) }.getOrNull()
            if (!response.isSuccessful) throw api.failure(response, text)
            if (response.code == 204) null else json?.wire() ?: throw ApiException(502, "bad_reply", "伺服器回傳的內容不是 JSON，請檢查 gateway 與反向代理")
        }
    }
    internal suspend fun documentStorageState(
        principal: NativeDocumentScripts.ResourcePrincipal,
        documentUrl: String,
        operations: List<Map<*, *>> = emptyList(),
        knownRevision: Long? = null,
        expectedGeneration: Long? = null,
    ): Map<String, Any?> = withContext(Dispatchers.IO) {
        answerLock.withLock {
            val pairing = credentials.load()
            val stamp = pairing?.let { ensurePairingStamp() }
            if (principal.pairingStamp != stamp) {
                throw ApiException(409, "account_changed", "Browser storage account changed; reload the document.")
            }
            val lease = contextLease(principal.contextId)
            if (!contextLeaseIsCurrent(lease) || lease.pairingStamp != stamp) {
                throw ApiException(409, "context_expired", "The browser storage context is no longer current.")
            }
            documentStorage.state(principal, documentUrl, operations, knownRevision, expectedGeneration)
        }
    }

    internal suspend fun documentStorageWindow(
        open: Boolean, key: String, openerKey: String?, expectedStamp: String,
    ) = withContext(Dispatchers.IO) {
        answerLock.withLock {
            credentials.load() ?: throw ApiException(401, "unpaired", "請先配對此裝置")
            requirePairingStamp(expectedStamp, ensurePairingStamp())
            if (open) documentStorage.openWindow(expectedStamp, key, openerKey)
            else documentStorage.closeWindow(expectedStamp, key)
        }
    }

    internal suspend fun documentStorageCloseReader(owner: String, contextId: String?) = answerLock.withLock {
        documentStorage.closeReader(owner, contextId)
    }

    internal suspend fun documentCookieState(
        principal: NativeDocumentScripts.ResourcePrincipal,
        documentUrl: String,
        writes: List<Map<*, *>> = emptyList(),
    ): Map<String, Any?> = answerLock.withLock {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
        val stamp = pairing?.let { ensurePairingStamp() }
        if (principal.pairingStamp != stamp) {
            throw ApiException(409, "account_changed", "Cookie account changed; reload the document.")
        }
        val lease = contextLease(principal.contextId)
        if (!contextLeaseIsCurrent(lease) || lease.pairingStamp != principal.pairingStamp) {
            throw ApiException(409, "context_expired", "This native context is no longer current.")
        }
        val url = documentUrl.toHttpUrlOrNull()
            ?: throw ApiException(400, "cookie_document", "Cookies require an HTTP document.")
        if (NativeScriptResourceTransport.originForDocument(url.toString()) != principal.documentOrigin) {
            throw ApiException(400, "cookie_document", "Cookie document origin changed.")
        }
        require(writes.size <= 256) { "Too many cookie writes" }
        val jar = withContext(Dispatchers.IO) { documentCookies.bind(principal.pairingStamp) }!!
        for (write in writes) {
            val writeUrl = (write["url"] as? String)?.toHttpUrlOrNull()
                ?: throw ApiException(400, "cookie_document", "Invalid cookie write URL.")
            if (NativeScriptResourceTransport.originForDocument(writeUrl.toString()) != principal.documentOrigin) {
                throw ApiException(400, "cookie_document", "Cookie write origin changed.")
            }
            val line = write["line"] as? String ?: throw ApiException(400, "cookie_document", "Invalid cookie assignment.")
            require(line.length <= 4096) { "Cookie assignment is too long" }
            val generation = (write["generation"] as? Number)?.toLong()
                ?: throw ApiException(400, "cookie_document", "Cookie scope generation is required.")
            jar.setDocumentCookie(writeUrl, line, expectedGeneration = generation)
        }
        jar.exportScriptState(url) + mapOf("persistenceError" to documentCookies.persistenceError)
    }

    internal suspend fun documentPrepareRequest(
        source: String,
        baseUrl: String?,
        expectedStamp: String,
        method: String,
        resourceType: String,
        initiatorUrl: String?,
        topLevelUrl: String?,
    ): Map<String, Any?> = answerLock.withLock {
        withContext(Dispatchers.IO) {
            credentials.load() ?: throw ApiException(401, "unpaired", "請先配對此裝置")
            requirePairingStamp(expectedStamp, ensurePairingStamp())
            val url = NativeDocumentTransport(null).resolveUrl(source, baseUrl).toHttpUrlOrNull()
                ?: throw ApiException(400, "cookie_document", "Cookie request requires HTTP.")
            val jar = documentCookies.bind(expectedStamp)!!
            val initiator = nativeCookieContextUrl(initiatorUrl, url.takeIf { resourceType == "document" })
            val header = jar.requestHeader(url, CookieRequestContext(
                initiatorUrl = initiator, topLevelUrl = nativeCookieContextUrl(topLevelUrl, initiator),
                method = method, topLevelNavigation = resourceType == "document",
            ))
            mapOf("nativeCookieRequestKey" to opaqueCookieRequestKey(header))
        }
    }

    suspend fun document(
        source: String,
        method: String,
        body: String?,
        contentType: String?,
        baseUrl: String?,
        pairingStamp: String,
        resourceType: NativeDocumentTransport.ResourceType = NativeDocumentTransport.ResourceType.DOCUMENT,
        cacheMode: NativeDocumentTransport.CacheMode = NativeDocumentTransport.CacheMode.DEFAULT,
        ifNoneMatch: String? = null,
        ifModifiedSince: String? = null,
        bodyBytes: ByteArray? = null,
        referrerUrl: String? = null,
        referrerPolicy: String? = null,
        originUrl: String? = null,
        initiatorUrl: String? = null,
        topLevelUrl: String? = null,
    ): Map<String, Any?> = withContext(Dispatchers.IO) {
        val captured = answerLock.withLock {
            val current = credentials.load() ?: throw ApiException(401, "unpaired", "請先配對此裝置")
            requirePairingStamp(pairingStamp, ensurePairingStamp())
            current to documentCookies.bind(pairingStamp)
        }
        val pairing = captured.first
        val response = NativeDocumentTransport(pairing, cookies = captured.second).load(
            source,
            method,
            body,
            contentType,
            baseUrl,
            resourceType,
            cacheMode,
            ifNoneMatch,
            ifModifiedSince,
            bodyBytes,
            referrerUrl,
            referrerPolicy,
            originUrl,
            initiatorUrl = initiatorUrl ?: originUrl ?: referrerUrl,
            topLevelUrl = topLevelUrl ?: initiatorUrl ?: originUrl ?: referrerUrl,
        )
        answerLock.withLock {
            requirePairingStamp(pairingStamp, if (credentials.load() == pairing) ensurePairingStamp() else null)
        }
        response
    }

    /** Loads one script/fetch resource for the native document principal bound to its isolate. */
    internal suspend fun documentScriptResource(
        principal: NativeDocumentScripts.ResourcePrincipal,
        request: NativeScriptResourceTransport.ResourceRequest,
        cancellation: NativeResourceCancellation? = null,
    ): NativeScriptResourceTransport.ResourceResponse = withContext(Dispatchers.IO) {
        cancellation?.throwIfCancelled()
        val access = answerLock.withLock {
            val pairing = credentials.load()
            val stamp = pairing?.let { ensurePairingStamp() }
            if (principal.pairingStamp != stamp) {
                throw ApiException(409, "account_changed", "配對帳戶已變更，請重新載入文件")
            }
            if (contexts.currentPairingStamp() != stamp) {
                closeAllContexts(releaseLeases = true)
                contexts.bindPairingStamp(stamp)
            }
            val lease = contextLease(principal.contextId)
            if (!contextLeaseIsCurrent(lease) || lease.pairingStamp != stamp) {
                throw ApiException(409, "context_expired", "This native context is no longer current.")
            }
            ScriptResourceAccess(pairing, stamp, lease, documentCookies.bind(stamp))
        }

        val response = NativeScriptResourceTransport(access.pairing, cookies = access.cookies).load(
            sourceOrigin = principal.documentOrigin,
            request = request,
            baseUrl = principal.documentUrl,
            referrerUrl = if (request.kind == NativeScriptResourceTransport.Kind.STYLESHEET) {
                request.stylesheetReferrerUrl ?: principal.documentUrl
            } else if (request.kind == NativeScriptResourceTransport.Kind.MODULE_SCRIPT) {
                request.moduleReferrerUrl?.let { referrer ->
                    principal.scriptSources?.requireScriptReferrer(referrer, principal.documentUrl)
                        ?: throw IllegalArgumentException("Module referrer requires an owning document script session")
                } ?: principal.documentUrl
            } else principal.documentUrl,
            cancellation = cancellation,
            initiatorUrl = principal.documentUrl,
            topLevelUrl = principal.documentUrl,
        )
        cancellation?.throwIfCancelled()

        answerLock.withLock {
            val currentPairing = credentials.load()
            val currentStamp = currentPairing?.let { ensurePairingStamp() }
            if (currentPairing != access.pairing || currentStamp != access.pairingStamp ||
                principal.pairingStamp != currentStamp
            ) {
                throw ApiException(409, "account_changed", "配對帳戶已變更，請重新載入文件")
            }
            if (!contextLeaseIsCurrent(access.contextLease)) {
                throw ApiException(409, "context_expired", "This native context is no longer current.")
            }
        }
        response
    }

    /** Loads trusted initial HTML CSS through the same cookie, CORS, MIME, SRI and redirect path as script-owned CSS. */
    internal suspend fun documentStylesheet(
        documentUrl: String,
        blobCreatorUrl: String?,
        contextId: String?,
        expectedPairingStamp: String,
        request: NativeScriptResourceTransport.ResourceRequest,
    ): NativeScriptResourceTransport.ResourceResponse = withContext(Dispatchers.IO) {
        require(request.kind == NativeScriptResourceTransport.Kind.STYLESHEET) {
            "Initial document stylesheet requests must use the stylesheet resource kind"
        }
        require(expectedPairingStamp.isNotBlank()) { "A current pairing stamp is required for stylesheet requests" }
        val sourceOrigin = NativeScriptResourceTransport.originForDocument(documentUrl, blobCreatorUrl)
        val principal = answerLock.withLock {
            val pairing = credentials.load()
                ?: throw ApiException(401, "unpaired", "請先配對此裝置")
            val stamp = ensurePairingStamp()
            requirePairingStamp(expectedPairingStamp, stamp)
            if (contexts.currentPairingStamp() != stamp) {
                closeAllContexts(releaseLeases = true)
                contexts.bindPairingStamp(stamp)
            }
            val lease = contextLease(contextId)
            if (!contextLeaseIsCurrent(lease) || lease.pairingStamp != stamp) {
                throw ApiException(409, "context_expired", "This native window is no longer current.")
            }
            NativeDocumentScripts.ResourcePrincipal(
                documentUrl = documentUrl,
                documentOrigin = sourceOrigin,
                contextId = lease.contextId,
                pairingStamp = stamp,
            )
        }
        documentScriptResource(principal, request)
    }

    /** Captures the account and native-window lease that own one HTML media element. */
    internal suspend fun captureHtmlMediaAccess(
        contextId: String?,
        expectedPairingStamp: String,
    ): HtmlMediaAccess = answerLock.withLock {
        val pairing = withContext(Dispatchers.IO) { credentials.load() }
            ?: throw ApiException(401, "unpaired", "請先配對此裝置")
        val currentStamp = ensurePairingStamp()
        requirePairingStamp(expectedPairingStamp, currentStamp)
        if (contexts.currentPairingStamp() != currentStamp) {
            closeAllContexts(releaseLeases = true)
            contexts.bindPairingStamp(currentStamp)
        }
        val lease = contextLease(contextId)
        if (lease.pairingStamp != currentStamp) {
            throw ApiException(409, "context_expired", "This native context is no longer current.")
        }
        HtmlMediaAccess(pairing, currentStamp, lease, withContext(Dispatchers.IO) { documentCookies.bind(currentStamp) })
    }

    /** Revalidates both owners immediately before a media operation touches the player. */
    internal suspend fun validateHtmlMediaAccess(access: HtmlMediaAccess) = answerLock.withLock {
        val currentPairing = withContext(Dispatchers.IO) { credentials.load() }
        if (currentPairing != access.pairing) {
            throw ApiException(409, "account_changed", "配對帳戶已變更，請重新檢查問題")
        }
        requirePairingStamp(
            access.pairingStamp,
            if (currentPairing == access.pairing) ensurePairingStamp() else null,
        )
        if (!contextLeaseIsCurrent(access.contextLease)) {
            throw ApiException(409, "context_expired", "This native context is no longer current.")
        }
    }

    /** Loads a bounded HTTP(S) media representation with the pairing-scoped bearer transport. */
    internal suspend fun loadHtmlMediaResource(
        access: HtmlMediaAccess,
        source: String,
        baseUrl: String?,
        documentUrl: String? = null,
    ): HtmlMediaResource {
        validateHtmlMediaAccess(access)
        val response = withContext(Dispatchers.IO) {
            NativeDocumentTransport(access.pairing, cookies = access.cookies).load(
                url = source,
                method = "GET",
                body = null,
                contentType = null,
                baseUrl = baseUrl,
                resourceType = NativeDocumentTransport.ResourceType.MEDIA,
                initiatorUrl = documentUrl,
                topLevelUrl = documentUrl,
            )
        }
        val status = (response["status"] as? Number)?.toInt()
            ?: throw IllegalStateException("Media response did not include an HTTP status")
        if (status !in 200..299) {
            throw ApiException(status, "media_http_error", "Media request failed with HTTP $status")
        }
        val bytes = response["bytes"] as? ByteArray
            ?: throw IllegalStateException("Media response did not include bytes")
        if (bytes.size > MAX_HTML_MEDIA_BYTES) {
            throw IllegalArgumentException("Media exceeds the 32 MiB limit")
        }
        validateHtmlMediaAccess(access)
        val headers = (response["headersRelevant"] as? Map<*, *>)
            ?.mapNotNull { (name, value) ->
                if (name is String && value is String) name to value else null
            }
            ?.toMap()
            .orEmpty()
        return HtmlMediaResource(
            bytes = bytes,
            mimeType = response["mimeType"] as? String ?: "",
            finalUrl = response["finalUrl"] as? String ?: "",
            headersRelevant = headers,
        )
    }

    suspend fun image(source: String, baseUrl: String? = null, documentUrl: String? = null, crossOrigin: String? = null): Map<String, Any> = withContext(Dispatchers.IO) {
        val captured = answerLock.withLock {
            val pairing = credentials.load()
            val stamp = pairing?.let { ensurePairingStamp() }
            Triple(pairing, stamp, documentCookies.bind(stamp))
        }
        val image = if (crossOrigin == null) {
            NativeImageTransport(captured.first, cookies = captured.third).load(
                source, baseUrl, initiatorUrl = documentUrl, topLevelUrl = documentUrl,
            )
        } else {
            require(crossOrigin in setOf("", "anonymous", "use-credentials")) { "Invalid image crossorigin" }
            val sourceOrigin = documentUrl?.let { NativeScriptResourceTransport.originForDocument(it) }
                ?: throw IllegalArgumentException("A CORS image requires its document URL")
            val response = NativeScriptResourceTransport(captured.first,
                responseLimit = 32 * 1024 * 1024, cookies = captured.third).load(
                sourceOrigin,
                NativeScriptResourceTransport.ResourceRequest(source,
                    kind = NativeScriptResourceTransport.Kind.IMAGE, crossOrigin = crossOrigin),
                baseUrl = baseUrl,
                referrerUrl = documentUrl,
                initiatorUrl = documentUrl,
                topLevelUrl = documentUrl,
            )
            require(response.status in 200..299) { "Image request failed (${response.status})" }
            mapOf("bytes" to (response.body ?: error("Image response has no bytes")),
                "mimeType" to response.mimeType,
                "nativeCookieRequestKey" to response.nativeCookieRequestKey,
                "nativeSetCookieProcessed" to response.nativeSetCookieProcessed)
        }
        answerLock.withLock {
            val currentPairing = credentials.load()
            val currentStamp = currentPairing?.let { ensurePairingStamp() }
            check(currentPairing == captured.first && currentStamp == captured.second &&
                documentCookies.bind(currentStamp) === captured.third) { "Image connection changed" }
        }
        image
    }
    suspend fun openSocket(tag: String, path: String, contextId: String? = null) {
        val contextLease = contextLease(contextId)
        require(path.startsWith("/api/sessions/") && path.endsWith("/stream"))
        val key = SocketKey(contextLease.contextId, tag)
        closeSocketKey(key)
        val token = UUID.randomUUID().toString()
        socketTokens[key] = token
        val api = api()
        if (!contextLeaseIsCurrent(contextLease)) {
            socketTokens.remove(key, token)
            throw ApiException(409, "context_expired", "此原生視窗已關閉")
        }
        val socket = api.client.newBuilder().readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .pingInterval(25, java.util.concurrent.TimeUnit.SECONDS).build()
            .newWebSocket(api.request(path).build(), object: WebSocketListener() {
                private fun current() = socketTokens[key] == token && contextLeaseIsCurrent(contextLease)
                private fun send(type: String, data: Map<String, Any?>) {
                    if (!current()) return
                    emitEvent(type, data, sessionId = null, contextId = contextLease.contextId)
                }
                override fun onOpen(ws: WebSocket, response: Response) {
                    send("socketOpened", mapOf("tag" to tag))
                }
                override fun onMessage(ws: WebSocket, text: String) {
                    send("socket", mapOf("tag" to tag, "frame" to runCatching { PircJson.parseToJsonElement(text).wire() }.getOrNull()))
                }
                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    send("socketClosed", mapOf("tag" to tag, "code" to response?.code, "message" to t.message))
                }
                override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                    ws.close(1000, null)
                    send("socketClosed", mapOf("tag" to tag, "code" to code, "message" to reason))
                }
            })
        if (!contextLeaseIsCurrent(contextLease) || socketTokens[key] != token) {
            socket.cancel()
            socketTokens.remove(key, token)
            return
        }
        sockets[key] = socket
    }
    fun sendSocket(tag: String, data: Map<*, *>, contextId: String? = null) {
        val context = contextLease(contextId)
        check(contextLeaseIsCurrent(context)) { "此原生視窗已關閉" }
        val key = SocketKey(context.contextId, tag)
        check(sockets[key]?.send(data.json().toString()) == true) { "Socket 已斷線" }
    }
    fun closeSocket(tag: String, contextId: String? = null) {
        val context = contextLease(contextId)
        closeSocketKey(SocketKey(context.contextId, tag))
    }
    private fun closeSocketKey(key: SocketKey) {
        socketTokens.remove(key)
        sockets.remove(key)?.cancel()
    }
    private fun closeSocketsFor(contextId: String) {
        socketTokens.keys.filter { it.contextId == contextId }.forEach(::closeSocketKey)
        sockets.keys.filter { it.contextId == contextId }.forEach(::closeSocketKey)
    }
    fun closeSockets() {
        socketTokens.clear()
        sockets.values.forEach { it.cancel() }
        sockets.clear()
    }
    companion object {
        @Volatile private var instance: GatewayRuntime? = null
        fun get(context: Context) = instance ?: synchronized(this) {
            instance ?: GatewayRuntime(context.applicationContext).also { instance = it }
        }
    }
}
