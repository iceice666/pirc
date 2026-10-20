package dev.pirc.pirc_mobile

import dev.pirc.android.core.*
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One device/account's consent state. Verifier and grant never cross MethodChannel. */
internal class NativeManagementSession(
    private val api: PircApi,
    private val exchange: suspend (String, String, Any?) -> Any?,
    private val validate: suspend () -> Unit,
) {
    private val mutex = Mutex()
    private var request: Map<String, Any?>? = null
    private var verifier: String? = null
    private val publicFields = setOf("id", "status", "expiresAt", "serverNow", "deviceName", "capabilities", "verificationPath")
    private fun publicReply(value: Any?): Map<String, Any?> {
        val reply = value as? Map<*, *> ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權回應無法讀取"))
        return reply.entries.filter { it.key in publicFields }.associate { it.key.toString() to it.value }
    }
    private fun path(): String {
        val id = request?.get("id") as? String ?: throw ApiException(409, "management_missing", NativeI18n.text("請先提出管理授權"))
        require(id.matches(Regex("^[A-Za-z0-9_-]{16,128}$")))
        return "/api/native-management/requests/$id"
    }
    private suspend fun deleteRequest() {
        try { exchange("DELETE", path(), null) }
        catch (error: ApiException) { if (error.status != 404) throw error }
        validate()
    }
    suspend fun status(): Map<String, Any?> = mutex.withLock {
        validate()
        api.managementStatus() + mapOf("request" to request)
    }
    suspend fun begin(capabilities: List<String>): Map<String, Any?> = mutex.withLock {
        validate()
        require(capabilities.isNotEmpty() && capabilities.distinct().size == capabilities.size && capabilities.all { it == "providers" || it == "devices" })
        if (request != null) deleteRequest()
        api.clearManagementGrant(); request = null; verifier = null
        val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val challenge = MessageDigest.getInstance("SHA-256").digest(secret.toByteArray()).joinToString("") { "%02x".format(it) }
        val reply = publicReply(exchange("POST", "/api/native-management/requests", mapOf("challenge" to challenge, "capabilities" to capabilities, "replace" to true)))
        validate()
        request = reply; verifier = secret
        reply + mapOf("verificationUrl" to verificationUrl())
    }
    suspend fun check(): Map<String, Any?> = mutex.withLock {
        validate()
        val reply = try { publicReply(exchange("GET", path(), null)) }
        catch (error: ApiException) {
            if (error.status != 404) throw error
            validate(); api.clearManagementGrant(); verifier = null
            request = request?.plus("status" to "expired")
            return@withLock api.managementStatus() + mapOf("request" to request)
        }
        validate(); request = reply
        when (reply["status"]) {
            "approved" -> {
                val secret = verifier ?: throw ApiException(409, "management_missing", NativeI18n.text("請重新提出管理授權"))
                val claimed = exchange("POST", path() + "/claim", mapOf("verifier" to secret)) as? Map<*, *>
                    ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權回應無法讀取"))
                validate()
                val token = claimed["token"] as? String ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權回應無法讀取"))
                val expiry = (claimed["expiresAt"] as? Number)?.toLong() ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權回應無法讀取"))
                val now = (claimed["serverNow"] as? Number)?.toLong() ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權回應無法讀取"))
                val caps = (reply["capabilities"] as? List<*>)?.filterIsInstance<String>()?.toSet().orEmpty()
                api.installManagementGrant(token, expiry, now, caps)
                verifier = null; request = reply + mapOf("status" to "claimed", "expiresAt" to expiry)
            }
            "denied", "revoked", "expired" -> { api.clearManagementGrant(); verifier = null }
        }
        api.managementStatus() + mapOf("request" to request)
    }
    suspend fun cancel(): Map<String, Any?> = mutex.withLock {
        validate()
        // Local access closes immediately, even when revocation's response is lost.
        api.clearManagementGrant(); verifier = null
        if (request != null) deleteRequest()
        request = null
        mapOf("active" to false, "request" to null)
    }
    /** Cleanup after pairing changes uses only the captured old API, never the new account. */
    suspend fun abandon() = mutex.withLock {
        api.clearManagementGrant(); verifier = null
        val endpoint = if (request != null) path() else null
        request = null
        if (endpoint != null) exchange("DELETE", endpoint, null)
        Unit
    }
    private fun verificationUrl(): String {
        val relative = request?.get("verificationPath") as? String ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權網址無法讀取"))
        val id = request?.get("id") as? String ?: throw ApiException(502, "bad_reply", NativeI18n.text("管理授權網址無法讀取"))
        if (relative != "/?nativeManagement=$id") throw ApiException(502, "bad_reply", NativeI18n.text("管理授權網址無法讀取"))
        return api.pairing.baseUrl + relative
    }
    suspend fun url(): String = mutex.withLock { validate(); verificationUrl() }
}
